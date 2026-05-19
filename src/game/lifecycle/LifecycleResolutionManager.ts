// LifecycleResolutionManager — client-side state machine that
// observes magnetic-flagged cards owned by the local player and
// submits `propose_action` calls for either the success recipe
// (during the active phase) or the failure recipe (after expiry).
//
// Server-side counterpart: `magnetic_pending` table + block-gate in
// `magnetic_pending::block_check`. See
// [docs/MAGNETIC_REWRITE.md](../../../../docs/MAGNETIC_REWRITE.md)
// for the full design.

import type { Card } from "../../server/spacetime/bindings/types";
import { validAtOf } from "../../server/data/packing";
import { parseLifecycleBlockedError } from "../../server/spacetime/LifecycleBlockedError";
import { debug } from "../../debug";
import type {
  CardDefinition,
  DefinitionManager,
} from "../definitions/DefinitionManager";
import type { DataManager } from "../../server/data/DataManager";
import type { ReducerManager } from "../../server/spacetime/ReducerManager";
import type { PlayerManager } from "../../server/player/PlayerManager";

/** How many candidate slot-combinations to try per magnetic card per
 *  resolution attempt. Magnetic recipes today have ≤ 3 slots; with
 *  modest inventories (tens of cards), the combinatorial space is
 *  small. The cap exists to defend against pathological inventories
 *  blowing up the client tick. */
const MAX_COMBINATION_ATTEMPTS = 100;

/** Re-attempt cooldown for a card whose previous resolution attempt
 *  failed (no match, server rejection, etc.). Without this, every
 *  inventory tick would re-attempt the same failing card. */
const RETRY_COOLDOWN_MS = 1_000;

type ResolutionState =
  | { kind: "idle"; lastAttemptedMs: number }
  | { kind: "attempting" }
  | { kind: "resolved" };

export interface MagneticResolutionContext {
  readonly data: DataManager;
  readonly reducers: ReducerManager;
  readonly definitions: DefinitionManager;
  readonly playerSession: PlayerManager;
}

/**
 * Bootstrap-scoped manager. Created in `main.ts` after definitions
 * load; lives for the application lifetime. Internally tracks
 * per-card resolution state to avoid hammering the server on repeat
 * inventory changes.
 *
 * Usage:
 *
 * ```ts
 * const mgr = new LifecycleResolutionManager(ctx);
 * mgr.start();
 * // ... lifetime ...
 * mgr.dispose();
 * ```
 */
export class LifecycleResolutionManager {
  private readonly ctx: MagneticResolutionContext;
  private readonly states = new Map<number, ResolutionState>();
  private started = false;
  private unsubCards: (() => void) | null = null;
  private unsubPlayer: (() => void) | null = null;

  constructor(ctx: MagneticResolutionContext) {
    this.ctx = ctx;
  }

  /** Begin observing cards and resolving magnetic phases. Idempotent.
   *
   *  Wires two listeners:
   *  - `data.cardsLocal.subscribe` — fires for inserts/updates/deletes
   *    in the client's card view. Used to notice new magnetic cards.
   *  - `playerSession.on(player)` — on login, kick off an enumeration
   *    pass so we resolve any magnetic cards that already exist. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubCards = this.ctx.data.subscribeLocalCard(() => {
      // Inventory or card-state change. Run a resolution pass. The
      // per-card cooldown in `tryResolve` prevents tight loops.
      void this.enumerateAndResolve();
    });
    this.unsubPlayer = this.ctx.playerSession.on((player) => {
      if (player !== null) {
        void this.enumerateAndResolve();
      } else {
        // Player logged out — drop our state. Magnetic cards we'd
        // tracked are for the previous player anyway.
        this.states.clear();
      }
    });
  }

  /** Tear down listeners and clear state. Safe to call before
   *  `start()` (no-op). */
  dispose(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubCards?.();
    this.unsubCards = null;
    this.unsubPlayer?.();
    this.unsubPlayer = null;
    this.states.clear();
  }

  /** Walk every visible card and run resolution against the
   *  magnetic ones owned by the local player. Triggered automatically
   *  on subscription changes; safe to call manually for tests. */
  async enumerateAndResolve(): Promise<void> {
    if (!this.started) return;
    const player = this.ctx.playerSession.getPlayer();
    if (player === null) return;
    const playerId = player.playerId;

    // Collect candidates first; iterating + awaiting inside the
    // subscription's change loop confuses listeners that mutate.
    const candidates: Card[] = [];
    for (const card of this.ctx.data.cardsLocal.values()) {
      if (!this.isOwnedMagnetic(card, playerId)) continue;
      const state = this.states.get(card.cardId);
      if (state?.kind === "attempting" || state?.kind === "resolved") continue;
      // Cooldown gate for previously-failed attempts.
      const now = this.ctx.reducers.serverNowMs();
      if (state?.kind === "idle" && now - state.lastAttemptedMs < RETRY_COOLDOWN_MS) {
        continue;
      }
      candidates.push(card);
    }
    for (const card of candidates) {
      await this.tryResolve(card);
    }
  }

  /** Attempt to resolve a single magnetic card. Reads the card def,
   *  computes phase status, picks success or failure path, submits
   *  the resulting `propose_action`.
   *
   *  Visible primarily for testing; the listeners in `start()` call
   *  this implicitly via `enumerateAndResolve`. */
  async tryResolve(card: Card): Promise<void> {
    const def = this.ctx.definitions.decode(card.packedDefinition);
    if (def === null) return;
    if (!def.lifecycleRecipeKey || !def.lifecycleDurationMs) {
      // Not a magnetic card def, even though the flag was set. Skip.
      return;
    }

    this.states.set(card.cardId, { kind: "attempting" });

    try {
      const installMs = Number(validAtOf(card.validAt));
      const phaseEndMs = installMs + def.lifecycleDurationMs;
      const nowMs = this.ctx.reducers.serverNowMs();

      if (nowMs < phaseEndMs) {
        await this.tryResolveSuccess(card, def);
      } else {
        await this.tryResolveFailure(card, def);
      }
    } catch (err) {
      debug.log(
        ["magnetic"],
        `[magnetic] tryResolve card=${card.cardId} threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
        3,
      );
    } finally {
      // If the resolution succeeded server-side, the card transitions
      // out of magnetic state and we'll observe it leave the
      // owned-magnetic set on the next subscription change — at which
      // point we won't be picked up again. Until that observation
      // lands, leave the state as "idle" so we don't retry
      // immediately on the same tick.
      if (this.states.get(card.cardId)?.kind === "attempting") {
        this.states.set(card.cardId, {
          kind: "idle",
          lastAttemptedMs: this.ctx.reducers.serverNowMs(),
        });
      }
    }
  }

  // ---------- success path -----------------------------------------

  private async tryResolveSuccess(card: Card, def: CardDefinition): Promise<void> {
    if (!def.lifecycleRecipeKey) return;
    const expectedRecipe = this.ctx.definitions.recipeByKey(def.lifecycleRecipeKey);
    if (expectedRecipe === null) {
      debug.log(
        ["magnetic"],
        `[magnetic] success recipe ${def.lifecycleRecipeKey} not registered`,
        3,
      );
      return;
    }

    // How many cards does the recipe need in each top-level branch?
    // Walk every input statement, find slot refs on top-level
    // iterators, and track the max offset per branch — the binding
    // for that branch needs at least `max_offset + 1` cards.
    const branchCounts = computeBranchCounts(expectedRecipe);

    // Currently support recipes that need branch 1 only (the
    // standard magnetic-success shape — `despair_success` /
    // `strike_success`). Recipes drawing from branch 2 / hex
    // weren't a magnetic pattern under the legacy model and
    // aren't a target for this combo iteration today.
    const count1 = branchCounts.get(1) ?? 0;
    if (count1 === 0) {
      // Root-only magnetic recipe — no inventory needed. Try the
      // matcher with empty branches; if it hits the expected
      // recipe, submit.
      const match = this.runMatcher(card, []);
      if (match !== null && match.recipe.id === def.lifecycleRecipeKey) {
        await this.submitProposeAction(card, match.recipeId, match.bindings);
        return;
      }
      this.states.delete(card.cardId);
      return;
    }

    // Build inventory candidate pool.
    const candidates = this.collectInventoryCandidates(card);
    if (candidates.length < count1) {
      this.states.delete(card.cardId);
      return;
    }

    // Walk K-combinations of `candidates` (K = count1). For each,
    // call the matcher with the synthetic chain. First combo whose
    // matched recipe id equals the expected key wins.
    let attempts = 0;
    const found = this.searchCombos(
      card,
      candidates,
      count1,
      def.lifecycleRecipeKey,
      [],
      0,
      { value: attempts },
    );
    if (found !== null) {
      await this.submitProposeAction(card, found.recipeId, found.bindings);
      return;
    }
    this.states.delete(card.cardId);
  }

  /** Recursive K-combination search. Builds candidate branch-1
   *  arrangements and asks the matcher; returns the first match
   *  whose `recipe.id` equals `expectedKey`, or `null` after
   *  exhausting attempts up to `MAX_COMBINATION_ATTEMPTS`. */
  private searchCombos(
    card: Card,
    pool: Card[],
    remaining: number,
    expectedKey: string,
    chosen: Card[],
    startIdx: number,
    counter: { value: number },
  ): { recipeId: number; bindings: number[][] } | null {
    if (counter.value >= MAX_COMBINATION_ATTEMPTS) return null;
    if (remaining === 0) {
      counter.value++;
      const branch1 = chosen.map((c) => c.cardId);
      const match = this.runMatcher(card, branch1);
      if (match !== null && match.recipe.id === expectedKey) {
        return { recipeId: match.recipeId, bindings: match.bindings };
      }
      return null;
    }
    for (let i = startIdx; i < pool.length; i++) {
      chosen.push(pool[i]);
      const result = this.searchCombos(
        card,
        pool,
        remaining - 1,
        expectedKey,
        chosen,
        i + 1,
        counter,
      );
      chosen.pop();
      if (result !== null) return result;
      if (counter.value >= MAX_COMBINATION_ATTEMPTS) return null;
    }
    return null;
  }

  /** Run the matcher against a synthetic chain with `card` as root
   *  and `branch1` filling branch 1. Other branches empty; no
   *  synthetic tile (magnetic anchors are inventory cards). */
  private runMatcher(
    card: Card,
    branch1: number[],
  ): { recipe: { id: string }; recipeId: number; bindings: number[][] } | null {
    const cardsLocal = this.ctx.data.cardsLocal;
    return this.ctx.definitions.findRecipeMatch({
      root: card.cardId,
      branches: [[], branch1, []],
      cardLookup: (id: number) => {
        const row = cardsLocal.get(id);
        if (!row) return null;
        return {
          cardId: row.cardId,
          packedDefinition: row.packedDefinition,
          ownerId: row.ownerId,
          microLocation: row.microLocation,
        };
      },
      syntheticTile: null,
      // Magnetic resolution doesn't have a `CardManager` in its
      // context — current magnetic recipes (despair_success /
      // strike_success) use only top-level iterators, so a
      // branch-walker isn't needed. If a future magnetic recipe
      // adds nested-iterator predicates (e.g. equipment checks),
      // thread a real `cards.buildChain` walker through the
      // `MagneticResolutionContext`.
      branchWalker: () => [] as readonly number[],
    });
  }

  // ---------- failure path -----------------------------------------

  private async tryResolveFailure(card: Card, _def: CardDefinition): Promise<void> {
    // Failure recipe is a regular tape-form recipe whose `input`
    // predicates are satisfied by the magnetic card sitting alone as
    // root (no branches). Under the unified card model there's no
    // "direction" — the matcher takes the chain configuration as-is
    // and returns the highest-priority recipe that matches.
    //
    // For a root-only configuration we pass empty branches; the
    // matcher only considers recipes whose `AnchorSet` requires no
    // top-level branches, leaving root-only recipes like
    // `despair_failure` / `strike_failure` / `corpus-` as the
    // candidates.
    const cardsLocal = this.ctx.data.cardsLocal;
    const match = this.ctx.definitions.findRecipeMatch({
      root: card.cardId,
      branches: [],
      cardLookup: (id: number) => {
        const row = cardsLocal.get(id);
        if (!row) return null;
        return {
          cardId: row.cardId,
          packedDefinition: row.packedDefinition,
          ownerId: row.ownerId,
          microLocation: row.microLocation,
        };
      },
    });
    if (match !== null) {
      await this.submitProposeAction(card, match.recipeId, match.bindings);
      return;
    }
    debug.log(
      ["magnetic"],
      `[magnetic] no failure recipe matches expired magnetic card ${card.cardId} — content authoring bug?`,
      3,
    );
  }

  // ---------- proposeAction submission -----------------------------

  private async submitProposeAction(
    card: Card,
    recipeId: number,
    bindings: number[][],
  ): Promise<void> {
    try {
      await this.ctx.reducers.proposeAction({
        recipeId,
        surface: card.surface,
        macroZone: card.macroZone,
        microZone: card.microZone,
        root: card.cardId,
        bindings,
      });
      this.states.set(card.cardId, { kind: "resolved" });
    } catch (err) {
      const blocked = parseLifecycleBlockedError(err);
      if (blocked !== null) {
        // Server is reminding us about another card we should resolve
        // first. The subscription will surface it; just log and let
        // the next pass handle it.
        debug.log(
          ["magnetic"],
          `[magnetic] proposeAction blocked by card_id=${blocked.cardId} overdue ${blocked.overdueMs}ms`,
          3,
        );
        return;
      }
      // Other errors (predicate mismatch, etc.) — log and back off.
      debug.log(
        ["magnetic"],
        `[magnetic] proposeAction for card=${card.cardId} recipe=${recipeId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        3,
      );
    }
  }

  // ---------- helpers ----------------------------------------------

  private isOwnedMagnetic(card: Card, playerId: number): boolean {
    if (!this.ctx.definitions.hasCardFlag(card.flags, "magnetic")) return false;
    if (this.ctx.definitions.hasCardFlag(card.flags, "dead")) return false;
    // The magnetic-resolution gate is per-player. World-owned magnetic
    // cards don't run through this client (no player to resolve);
    // those are sidecar-territory (when we have one). Check ownership
    // via FLAG_OWNED_BY_PLAYER on the card or on a card up its owner
    // chain — for simplicity we just check the card's direct
    // owner_id matches the player when the player-owned flag is set,
    // and otherwise treat it as not-mine.
    if (this.ctx.definitions.hasCardFlag(card.flags, "is_owned_by_player")) {
      return card.ownerId === playerId;
    }
    // Owner chain walk: cards in inventory carry `ownerId =
    // soul_card_id`. The soul carries `FLAG_OWNED_BY_PLAYER` and
    // `ownerId = player_id`. So a "magnetic card in my inventory"
    // looks like: this card's ownerId is a soul I own. Resolve by
    // looking up the owner card in the local view and checking
    // recursively. For depth-1 (the common case: magnetic anchor in
    // a soul's inventory bucket), this is a single lookup.
    const owner = this.ctx.data.cardsLocal.get(card.ownerId);
    if (owner === undefined) return false;
    if (this.ctx.definitions.hasCardFlag(owner.flags, "is_owned_by_player")) {
      return owner.ownerId === playerId;
    }
    // Deeper chains would need recursion. Magnetic anchors today are
    // always direct soul children, so this terminates.
    return false;
  }

  private collectInventoryCandidates(magneticCard: Card): Card[] {
    const out: Card[] = [];
    // Look only in the magnetic card's macro_zone — the recipe
    // operates on cards co-located with the anchor. For magnetic
    // cards anchored to a soul's inventory, this is the soul's
    // inventory bucket (`macro_zone = soul.card_id`).
    for (const c of this.ctx.data.cardsLocal.values()) {
      if (c.cardId === magneticCard.cardId) continue;
      if (c.macroZone !== magneticCard.macroZone) continue;
      if (c.surface !== magneticCard.surface) continue;
      if (this.ctx.definitions.hasCardFlag(c.flags, "magnetic")) continue;
      if (this.ctx.definitions.isSlotHeld(c.flags)) continue;
      if (this.ctx.definitions.hasCardFlag(c.flags, "dead")) continue;
      out.push(c);
    }
    return out;
  }

}

/** Walk every input statement in `recipe`, find `Seg::Slot` refs
 *  that resolve through top-level iterators, and return the
 *  required card count per branch (1-indexed by branch number,
 *  i.e. `result.get(1)` is the count for branch 1).
 *
 *  A branch's required count is `max referenced offset + 1` — if
 *  the recipe references `slot.1.0` and `slot.1.2`, the binding
 *  for branch 1 must have at least 3 cards (positions 0, 1, 2).
 *
 *  Used by the magnetic success-path resolver to know how many
 *  inventory cards to pull into branch 1 when trying combos.
 *  Nested iterators (parent !== []) don't count — their card
 *  pool isn't inventory. */
function computeBranchCounts(recipe: {
  input: Array<{ segments: Array<{ type: string; value: unknown }> }>;
  iterators: Array<{ parent: unknown[]; branch: number }>;
}): Map<number, number> {
  const maxOffset = new Map<number, number>();
  for (const stmt of recipe.input) {
    for (const seg of stmt.segments) {
      if (seg.type !== "slot") continue;
      const slotValue = seg.value as { iteratorId: number; offset: number };
      const it = recipe.iterators[slotValue.iteratorId];
      if (!it || it.parent.length !== 0) continue;
      const prev = maxOffset.get(it.branch);
      if (prev === undefined || slotValue.offset > prev) {
        maxOffset.set(it.branch, slotValue.offset);
      }
    }
  }
  const counts = new Map<number, number>();
  for (const [branch, max] of maxOffset) {
    counts.set(branch, max + 1);
  }
  return counts;
}
