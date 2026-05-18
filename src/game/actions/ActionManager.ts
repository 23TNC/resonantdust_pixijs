import { debug } from "../../debug";
import type { GameContext } from "../../GameContext";
import type { Card } from "../cards/Card";
import {
  getStackDirection,
  getStackedState,
  STACK_DIRECTION_DOWN,
  STACK_DIRECTION_UP,
  STACKED_LOOSE,
  STACKED_ON_HEX,
  STACKED_ON_ROOT,
  STACKED_SLOT,
} from "../cards/cardData";
import { WORLD_LAYER } from "../../server/data/packing";
import { getZoneTileSlot } from "../world/worldCoords";

/** Defensive cap on the phase loop. Each iteration that finds a match
 *  adds at least one card to the in-pass held set, which is bounded by
 *  the total chain length — so a correct matcher terminates well before
 *  this limit. The cap exists only to bound a buggy matcher returning
 *  the same match repeatedly. */
const MATCH_LOOP_CAP = 64;

/** Default fire-after-match delay. Matches stay queued for this long
 *  before being submitted to the server, giving the player a window to
 *  break the chain (drag a card off, etc.) and abort. */
const DEFAULT_DELAY_MS = 5000;

/** Maximum allowed `rootDist + consumed.length` for a rooted match.
 *  State-2 (`OnRoot`) rows pack `position` into a u5 (0..31); any
 *  rooted recipe whose actor + slot window would reach past chain
 *  index 31 must be rejected client-side, since the server's
 *  `pack_stack_micro_zone(position & 0x1f, ...)` would silently
 *  truncate and corrupt chain layout. Same constraint that
 *  `DragManager` enforces at drop-time, restated for the matcher. */
const MAX_PIN_DEPTH = 31;

export type StackDirection = "up" | "down";

/** Detailed result of a successful `matchStackRecipe` call. The slot
 *  window `[slotStart, slotStart + slotCount)` is the slice of
 *  `[root, ...slotDefs]` that fills the recipe's slot list — needed to
 *  assemble the `propose_action` reducer args, since the actor may
 *  slide along the chain when the recipe has no `root` constraint.
 *  Defined here (next to its sole consumer) and imported by
 *  `DefinitionManager` for its return-type annotation. */
export interface StackMatch {
  recipeIndex: number;
  slotStart: number;
  slotCount: number;
  hasRoot: boolean;
  hasHex: boolean;
}

export interface ActionManagerOptions {
  /** Milliseconds to wait after a match is queued before submitting it
   *  via `proposeAction`. If the queue entry is updated during the wait
   *  the timer is reset; if it's dropped the timer is cancelled. */
  delayMs?: number;
}

/** A recipe match the client has detected on a chain segment.
 *
 *  Queue keys are `${looseRootId}:${direction}:${recipeIndex}:${actorId}`.
 *  Multiple entries per (root, direction) are normal — every recipe
 *  that fits somewhere in a chain fires independently. The per-entry
 *  identity is "this recipe at this actor card"; a chain mutation that
 *  preserves both keeps the entry, otherwise it's replaced.
 */
export interface QueuedAction {
  /** Loose root of the chain this match lives in. Always passed as the
   *  recipe's root tier when `hasRoot` is true. */
  looseRootId: number;
  /** Direction of the chain (`up` = top stack, `down` = bottom stack). */
  direction: StackDirection;
  /** Stable packed recipe id (`u16`). */
  recipeIndex: number;
  /** Actor card id — the first card of the matched slot window. The
   *  recipe's `slots[0]` binds here. UI ties the per-card debounce
   *  progress bar to this card. */
  actorId: number;
  /** Card ids of the matched slot window in chain order, from actor
   *  outward. Passed directly as `slots` to `propose_action`. For
   *  rootless matches whose window started at the root tier slot, R
   *  appears at `chain[0]` here. */
  chain: readonly number[];
  /** Actor's chain distance from `looseRootId`. `0` if the actor is
   *  the loose root itself (rootless match consuming R); otherwise
   *  the actor's index in the full direction chain plus 1. Server
   *  reads this as the actor's `position` on `OnRoot` rows when
   *  `hasRoot` is true; ignored when `hasRoot` is false. */
  rootDist: number;
  /** `card_id` of the hex card the loose root is stacked on, or `0`
   *  if R isn't on a hex. Forwarded to `propose_action.hex` only when
   *  `hasHex` is true. */
  hexParentId: number;
  /** Whether the matched recipe constrains a `root` tier. */
  hasRoot: boolean;
  /** Whether the matched recipe constrains a `hex` tier. */
  hasHex: boolean;
  /** True between `proposeAction` dispatch and its round-trip
   *  resolution. While submitted, `evaluateRoot` and the
   *  cluster-pruning paths leave the entry alone — the user has
   *  committed to the action and the client may not cancel or
   *  upgrade it. The `.then` / `.catch` handlers clean up. */
  submitted: boolean;
  /** `performance.now()` value at the moment the fire-after-match
   *  timer was last (re)started. UI uses this with `delayMs` to draw
   *  the per-card debounce-progress indicator. `0` while the entry
   *  hasn't been scheduled (i.e. just constructed). */
  scheduledAt: number;
}

/**
 * Scene-scoped recipe pre-filter and submission queue.
 *
 * Listens to stack-change events from `CardManager`. For each affected
 * loose root R, runs a multi-phase, restart-on-match evaluation that
 * yields every recipe match against R's chains — in both directions,
 * across sub-chains split by `slot_hold` blocks, with per-evaluation
 * in-pass holds that prevent the same card being consumed by two
 * matches in one pass.
 *
 * R is the recipe's root tier for every match attempt; there is no
 * "sub-root" concept. Recipes that don't constrain root match via the
 * Phase 2 rootless retry, where R is prepended into the slot list.
 *
 * Chain construction goes through `CardManager.buildChain(R, dir)`
 * which threads state-1 (Slot) cards into the visual chain order
 * alongside state-2 (OnRoot) cards. Sub-chains are runs of contiguous
 * unheld cards within those chains, partitioned by
 * `CardManager.splitChainByHeld`.
 *
 * Phase ordering (top before bottom at each tier; restart on every match):
 *   1. Rooted firsts.   `match(hex, R.def, firstSubChain.defs, dir)`
 *   2. Rootless firsts. `match(hex, 0, [R, ...firstSubChain].defs, dir)` — only if R is unheld.
 *   3. Rooted subsequents (interleaved by sub-chain index across directions).
 *
 * After `delayMs` elapses without the entry being mutated, the action
 * is submitted via `ctx.reducers.proposeAction`. Hex / root args are
 * gated by `hasHex` / `hasRoot` so the server-side flag rules in
 * `actions.rs::propose_action` apply correctly.
 */
export class ActionManager {
  private readonly queue = new Map<string, QueuedAction>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delayMs: number;
  private readonly slotHoldMask: number;
  private readonly unsubStackChange: () => void;
  private readonly unsubData: () => void;

  constructor(
    private readonly ctx: GameContext,
    options: ActionManagerOptions = {},
  ) {
    if (!ctx.cards) {
      throw new Error("[ActionManager] ctx.cards is null — CardManager must exist");
    }
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.slotHoldMask = ctx.definitions.cardFlagMask("slot_hold");

    this.unsubStackChange = ctx.cards.subscribeAllStackChanges((rootId) => {
      this.evaluateRoot(rootId);
      // When the soul's own chain changes (equipment), recipes anchored
      // at OTHER chains owned by the same soul may transition between
      // unmatched and matched (their has-predicates depend on the
      // soul's stack via `topStackDefs`). Fan out to those chains so a
      // newly-equipped axe causes corpus-on-tree to start chopping
      // without needing a separate user action.
      this.cascadeFromSoulChange(rootId);
    });

    // Cards leaving cardsLocal (server delete or scope teardown) need to
    // drop their queue entries — stack-change events only fire for live
    // chain transitions, not for outright removals.
    this.unsubData = ctx.data.subscribeLocalCard((change) => {
      if (change.kind === "removed") {
        this.dropForCard(change.key);
      }
    });

    // Initial scan: every loose root currently in cardsLocal gets a fresh
    // evaluation. Stacked (non-root) cards are reached transitively via
    // their root; no need to enumerate them here.
    for (const row of ctx.data.cardsLocal.values()) {
      if (getStackedState(row.microZone) === STACKED_LOOSE) {
        this.evaluateRoot(row.cardId);
      }
    }
  }

  dispose(): void {
    this.unsubStackChange();
    this.unsubData();
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    this.queue.clear();
  }

  /** Snapshot iterator over currently queued actions. */
  pendingActions(): IterableIterator<QueuedAction> {
    return this.queue.values();
  }

  /** Number of queued actions across all roots, directions, and recipes. */
  pendingCount(): number {
    return this.queue.size;
  }

  /** Per-card debounce progress in `[0, 1]`, or `null` if `cardId` isn't
   *  the actor of any pending (non-submitted) queued action. The actor
   *  is `chain[0]` of the matched slot window; only it shows the
   *  progress bar so the visual indicator is unambiguous about which
   *  card "owns" the action. */
  progressFor(cardId: number): number | null {
    for (const entry of this.queue.values()) {
      if (entry.submitted) continue;
      if (entry.actorId !== cardId) continue;
      const elapsed = performance.now() - entry.scheduledAt;
      return Math.max(0, Math.min(1, elapsed / this.delayMs));
    }
    return null;
  }

  /** Re-evaluate every recipe match anchored at the loose root R. See
   *  the class docstring for the phase ordering. */
  private evaluateRoot(looseRootId: number): void {
    const cards = this.ctx.cards;
    if (!cards) return;

    const looseRoot = cards.get(looseRootId);
    const rootRow = this.ctx.data.cardsLocal.get(looseRootId);
    if (!looseRoot || !rootRow) {
      this.dropClusterNonSubmitted(looseRootId, "loose root gone");
      return;
    }

    // A "root" for matching is either:
    //   - state-0 LOOSE — the standard inventory case, or
    //   - state-3 ON_HEX with `microLocation == 0` on a world surface —
    //     a card dropped on a world tile that has no hex Card row of its
    //     own. The state-3 card itself becomes the matcher's root tier;
    //     hex tier comes from the zone's tile data at the card's local
    //     (q, r). `CardManager.rootOf` returns `cardId` for this case
    //     (microLocation=0 has no parent to hop to), so it's already
    //     surfacing here as the "loose root" from fireStackChange's
    //     perspective.
    const rootState = getStackedState(rootRow.microZone);
    const isVirtualWorldHexRoot =
      rootState === STACKED_ON_HEX &&
      rootRow.microLocation === 0 &&
      rootRow.surface >= WORLD_LAYER;
    if (rootState !== STACKED_LOOSE && !isVirtualWorldHexRoot) {
      this.dropClusterNonSubmitted(looseRootId, "root not loose or virtual world hex");
      return;
    }

    // Hex tier resolution:
    //   - Virtual world hex root: read the tile's def from the zones
    //     table at the rect's (macro_zone, localQ, localR).
    //     `hexParentId` stays 0 because there is no Card row — server-
    //     side `propose_action` will see `hex=0` and consult its own
    //     zone table for the hex def at action-fire time (or skip the
    //     hex constraint when the matched recipe doesn't require one).
    //   - Otherwise: no hex tier. Inventory chains never have a hex
    //     parent; if/when world hex Cards become roots themselves,
    //     that path will need its own handling.
    let hexParentId = 0;
    let hexDef = 0;
    // Stock counters for the hex tile, when the chain sits on a
    // synthetic-tile hex. The matcher uses them to evaluate
    // `Entity::Aspect` predicates against row-mutable values (forest
    // pine, mountain stone, etc.) rather than the def's static
    // aspects — see [docs/TILE_ASPECTS.md] § "Recipe matching".
    // `null` when the chain has no tile-hex tier (inventory chains)
    // or when the hex came from a Card row (no row stocks).
    let hexStocks: { stock0: number; stock1: number } | null = null;
    if (isVirtualWorldHexRoot) {
      const localQ = (rootRow.microZone >> 5) & 0x7;
      const localR = (rootRow.microZone >> 2) & 0x7;
      const slot = getZoneTileSlot(
        this.ctx.data.zonesLocal,
        rootRow.macroZone,
        localQ,
        localR,
      );
      hexDef = slot.packed;
      if (hexDef !== 0) {
        hexStocks = { stock0: slot.stock0, stock1: slot.stock1 };
      }
    }
    const rootDef = rootRow.packedDefinition;

    // Chains built once per evaluation. The held set grows as in-pass
    // matches consume cards; sub-chain splitting is re-derived on each
    // iteration of the phase loop.
    const topChain = cards.buildChain(looseRootId, STACK_DIRECTION_UP);
    const botChain = cards.buildChain(looseRootId, STACK_DIRECTION_DOWN);

    const inPassHeld = new Set<number>();
    const isHeld = (c: Card): boolean => {
      if (inPassHeld.has(c.cardId)) return true;
      return this.serverHeld(c.cardId);
    };

    const wanted = new Map<string, QueuedAction>();

    phaseLoop: for (let safety = 0; safety < MATCH_LOOP_CAP; safety++) {
      const top = cards.splitChainByHeld(topChain, isHeld);
      const bot = cards.splitChainByHeld(botChain, isHeld);

      // Phase 1 — rooted firsts (top before bottom).
      if (top.firstSubChain && top.firstSubChain.length > 0) {
        if (this.tryMatch({
          subChainCards: top.firstSubChain,
          fullChain: topChain,
          rootCard: looseRoot, rootDef, hexDef, hexStocks, hexParentId,
          looseRootId, direction: "up", rootless: false,
          inPassHeld, wanted,
        })) continue phaseLoop;
      }
      if (bot.firstSubChain && bot.firstSubChain.length > 0) {
        if (this.tryMatch({
          subChainCards: bot.firstSubChain,
          fullChain: botChain,
          rootCard: looseRoot, rootDef, hexDef, hexStocks, hexParentId,
          looseRootId, direction: "down", rootless: false,
          inPassHeld, wanted,
        })) continue phaseLoop;
      }

      // Phase 2 — rootless firsts. Skipped when R is held (a prior
      // match already consumed R as a slot, so it can't appear again).
      //
      // Fires even when the corresponding `firstSubChain` is null or
      // empty: in that case `subChainCards = []` and tryMatch will
      // prepend the rootCard to produce `slotCards = [R]`. This lets
      // recipes whose slot list is satisfied by R alone (e.g. a
      // recipe with `hex: [rock], slots: [corpus]` against a corpus
      // dropped on an empty rock world tile — the corpus is itself
      // the virtual world hex root, no chain members above or
      // below) match correctly. Without this, evaluation would skip
      // every phase and the recipe would never fire.
      if (!isHeld(looseRoot)) {
        const topFirst = top.firstSubChain ?? [];
        if (this.tryMatch({
          subChainCards: topFirst,
          fullChain: topChain,
          rootCard: looseRoot, rootDef, hexDef, hexStocks, hexParentId,
          looseRootId, direction: "up", rootless: true,
          inPassHeld, wanted,
        })) continue phaseLoop;
        const botFirst = bot.firstSubChain ?? [];
        if (this.tryMatch({
          subChainCards: botFirst,
          fullChain: botChain,
          rootCard: looseRoot, rootDef, hexDef, hexStocks, hexParentId,
          looseRootId, direction: "down", rootless: true,
          inPassHeld, wanted,
        })) continue phaseLoop;
      }

      // Phase 3+ — rooted subsequents, interleaved by sub-chain index
      // across directions.
      const maxSubsequent = Math.max(
        top.subsequentSubChains.length,
        bot.subsequentSubChains.length,
      );
      for (let i = 0; i < maxSubsequent; i++) {
        const topSub = top.subsequentSubChains[i];
        if (topSub && topSub.length > 0) {
          if (this.tryMatch({
            subChainCards: topSub,
            fullChain: topChain,
            rootCard: looseRoot, rootDef, hexDef, hexStocks, hexParentId,
            looseRootId, direction: "up", rootless: false,
            inPassHeld, wanted,
          })) continue phaseLoop;
        }
        const botSub = bot.subsequentSubChains[i];
        if (botSub && botSub.length > 0) {
          if (this.tryMatch({
            subChainCards: botSub,
            fullChain: botChain,
            rootCard: looseRoot, rootDef, hexDef, hexStocks, hexParentId,
            looseRootId, direction: "down", rootless: false,
            inPassHeld, wanted,
          })) continue phaseLoop;
        }
      }

      // No phase produced a match this iteration — fixed point reached.
      break;
    }

    // Reconcile: drop cluster entries that are no longer wanted (and
    // not submitted), then add / update wanted entries.
    const toDelete: string[] = [];
    for (const [key, entry] of this.queue) {
      if (entry.looseRootId !== looseRootId) continue;
      if (entry.submitted) continue;
      if (!wanted.has(key)) toDelete.push(key);
    }
    for (const key of toDelete) {
      this.queue.delete(key);
      this.cancelTimer(key);
      debug.log(
        ["actions"],
        `[ActionManager] queue drop: ${key} (no longer matches)`,
        2,
      );
    }

    for (const [key, action] of wanted) {
      const existing = this.queue.get(key);
      if (existing && existing.submitted) continue;
      const changed = !existing || queueActionDiffers(existing, action);
      if (changed) {
        this.queue.set(key, action);
        this.scheduleTimer(key);
        debug.log(
          ["actions"],
          `[ActionManager] queue ${existing ? "update" : "add"}: root=${action.looseRootId} dir=${action.direction} recipe=${action.recipeIndex} actor=${action.actorId} chain=[${action.chain.join(",")}] rootDist=${action.rootDist}${action.hexParentId ? ` hex=${action.hexParentId}` : ""}`,
          2,
        );
      }
    }
  }

  /** Run one matcher call against `subChainCards` (with R prepended if
   *  `rootless`), then map the result back to consumed cards, the
   *  actor, and the actor's chain distance from R. On a hit, mutate
   *  `inPassHeld` (adds consumed cards) and `wanted` (records the
   *  match) and return `true`. On no match, return `false`. */
  private tryMatch(args: {
    subChainCards: Card[];
    fullChain: Card[];
    rootCard: Card;
    rootDef: number;
    hexDef: number;
    hexStocks: { stock0: number; stock1: number } | null;
    hexParentId: number;
    looseRootId: number;
    direction: StackDirection;
    rootless: boolean;
    inPassHeld: Set<number>;
    wanted: Map<string, QueuedAction>;
  }): boolean {
    const {
      subChainCards, fullChain, rootCard, rootDef, hexDef, hexStocks, hexParentId,
      looseRootId, direction, rootless, inPassHeld, wanted,
    } = args;

    const slotCards = rootless ? [rootCard, ...subChainCards] : subChainCards;
    if (slotCards.length === 0) return false;

    const slotDefs = slotCards.map((c) =>
      this.ctx.data.cardsLocal.get(c.cardId)?.packedDefinition ?? 0,
    );

    const matchRoot = rootless ? 0 : rootDef;
    // Build has-predicate candidate pools. Root and actor owners can
    // differ in principle (combat-style recipes where root is the
    // target), but at this point in the matcher we don't yet know
    // which chain slot will be the actor — `slotStart` falls out of
    // the matcher itself. For v1 we approximate by reading the
    // *root card's* owner soul stack and feeding it to both root and
    // actor pools (same convention `on_create::trigger` uses where
    // root == actor). This over-permits in the rare cross-owner
    // case; `propose_action::resolve_has` is the authoritative
    // server-side check that catches it.
    //
    // Resolution: walk `ownerId` up to the soul (the row carrying
    // `FLAG_OWNED_BY_PLAYER`). Under the post-flag-20 card-owner
    // model, `card.ownerId` is a card_id (the container), so a
    // direct lookup by player_id is no longer correct.
    const soulId = this.owningSoulCardId(rootCard.cardId);
    const above = this.topStackDefs(soulId, STACK_DIRECTION_UP);
    const below = this.topStackDefs(soulId, STACK_DIRECTION_DOWN);
    const match = this.ctx.definitions.matchStackRecipe(
      hexDef,
      hexStocks,
      matchRoot,
      slotDefs,
      direction,
      {
        rootAbove: above,
        actorAbove: above,
        rootBelow: below,
        actorBelow: below,
      },
    );
    if (match === null) return false;

    // Map the matcher's slot window back to consumed cards.
    //
    // Internal chain seen by matcher = [root_card_or_None, ...slot_cards]:
    //   index 0 = root tier (R for rooted attempts; None for rootless).
    //   index i ≥ 1 = slot_cards[i - 1].
    //
    // For rooted attempts the matcher CAN match a rootless recipe
    // (recipe.root is None) starting at index 0, in which case R is
    // consumed at the head of the window. For rootless attempts
    // chain[0] is None, so any window touching index 0 fails the
    // Some-check; slotStart ≥ 1 always there.
    const winStart = match.slotStart;
    const winEnd = winStart + match.slotCount;
    const consumed: Card[] = [];
    for (let i = winStart; i < winEnd; i++) {
      if (i === 0) {
        if (rootless) {
          // Defensive: rootless attempt shouldn't reach index 0.
          return false;
        }
        consumed.push(rootCard);
      } else {
        const idx = i - 1;
        if (idx < 0 || idx >= slotCards.length) return false;
        consumed.push(slotCards[idx]);
      }
    }
    if (consumed.length === 0) return false;

    const actor = consumed[0];
    let rootDist: number;
    if (actor.cardId === looseRootId) {
      rootDist = 0;
    } else {
      const idx = fullChain.indexOf(actor);
      if (idx < 0) return false; // shouldn't happen — actor must be in the chain
      rootDist = idx + 1;
    }

    // Rooted recipes pin the actor at chain distance `rootDist` from R
    // as a state-2 row, with the recipe's slots above stacking from
    // there. The state-2 `position` field is u5 — `pack_stack_micro_zone`
    // will silently truncate `position & 0x1f` if `rootDist` is too
    // deep, corrupting chain layout. Reject the match when the
    // chain-tail position the slots would occupy exceeds 31. (We
    // include all consumed slots in the bound, not just the actor's
    // index, so the rejection is monotone with chain depth even
    // though only `slot[0]` carries the position field today —
    // future server changes that pack additional slots into state-2
    // would inherit the same constraint.)
    if (match.hasRoot && rootDist + consumed.length > MAX_PIN_DEPTH) {
      return false;
    }

    // Defensive: reject any match whose `consumed` set touches a
    // server-held or in-pass-held card. `splitChainByHeld` already
    // filters held cards out of `subChainCards`, but `rootCard`
    // (looseRoot R) is passed separately and is NOT filtered. For a
    // rootless recipe matched via a "rooted" attempt the matcher's
    // window can start at `slotStart = 0`, consuming R at the head —
    // if R is held (because it's already an actor in an in-flight
    // recipe like a corpus+corpus mid-action), claiming it again is
    // a bug. Same guard for `inPassHeld` covers the case where an
    // earlier match in this same evaluation pass already claimed
    // the card.
    for (const c of consumed) {
      if (inPassHeld.has(c.cardId) || this.serverHeld(c.cardId)) {
        return false;
      }
    }

    for (const c of consumed) {
      inPassHeld.add(c.cardId);
    }

    const key = this.queueKey(looseRootId, direction, match.recipeIndex, actor.cardId);
    wanted.set(key, {
      looseRootId,
      direction,
      recipeIndex: match.recipeIndex,
      actorId: actor.cardId,
      chain: consumed.map((c) => c.cardId),
      rootDist,
      hexParentId,
      hasRoot: match.hasRoot,
      hasHex: match.hasHex,
      submitted: false,
      scheduledAt: 0,
    });
    return true;
  }

  /** Whether `cardId`'s row carries the `slot_hold` flag — i.e. it's a
   *  slot in an in-flight or accepted recipe and must not participate
   *  in further matching. False if the row is missing or the flag bit
   *  is undefined in the registry. */
  private serverHeld(cardId: number): boolean {
    if (this.slotHoldMask === 0) return false;
    const row = this.ctx.data.cardsLocal.get(cardId);
    if (!row) return false;
    return (row.flags & this.slotHoldMask) !== 0;
  }

  /** Drop every non-submitted queue entry belonging to `looseRootId`'s
   *  cluster. Submitted entries stay — the user has committed to those
   *  actions and only their `proposeAction` round-trip resolves them. */
  private dropClusterNonSubmitted(looseRootId: number, why: string): void {
    const toDelete: string[] = [];
    for (const [key, entry] of this.queue) {
      if (entry.looseRootId !== looseRootId) continue;
      if (entry.submitted) continue;
      toDelete.push(key);
    }
    for (const key of toDelete) {
      this.queue.delete(key);
      this.cancelTimer(key);
      debug.log(["actions"], `[ActionManager] queue drop: ${key} (${why})`, 2);
    }
  }

  /** Drop every queue entry that names `cardId` as its loose root or
   *  carries it in its chain — used when the card itself is removed
   *  from `cardsLocal`. Submitted entries are dropped too: with the
   *  card gone there's nothing to clean up against, and the server
   *  side has already resolved one way or another. */
  private dropForCard(cardId: number): void {
    const toDelete: string[] = [];
    for (const [key, entry] of this.queue) {
      if (entry.looseRootId === cardId || entry.chain.includes(cardId)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this.queue.delete(key);
      this.cancelTimer(key);
      debug.log(
        ["actions"],
        `[ActionManager] queue drop: ${key} (card ${cardId} removed)`,
        2,
      );
    }
  }

  /** (Re)start the fire timer for `key`. Always cancels the existing
   *  timer first — a queue update should restart the countdown rather
   *  than fire on the original schedule. Also stamps `scheduledAt` on
   *  the entry so UI (`progressFor`) can show debounce-progress, and
   *  invalidates the actor's layout so the progress bar starts being
   *  drawn — the actor's row may not have changed (e.g. when the
   *  player drops a child onto the actor; only the child's row is
   *  written), so without this kick its `layout()` would never fire. */
  private scheduleTimer(key: string): void {
    this.cancelTimer(key);
    const entry = this.queue.get(key);
    if (entry) {
      entry.scheduledAt = performance.now();
      this.invalidateActor(entry);
    }
    const handle = setTimeout(() => {
      this.timers.delete(key);
      this.fireAction(key);
    }, this.delayMs);
    this.timers.set(key, handle);
  }

  private cancelTimer(key: string): void {
    const handle = this.timers.get(key);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.timers.delete(key);
    }
    // Kick the actor's layout so any in-flight progress bar is
    // erased on the next frame.
    const entry = this.queue.get(key);
    if (entry) this.invalidateActor(entry);
  }

  /** Mark the actor of `entry` as needing a fresh layout pass.
   *  `progressFor` reads the queue each frame, but `LayoutCard.layout`
   *  only runs while the node is invalidated — so we kick it whenever
   *  the queue's progress visibility for this entry changes. */
  private invalidateActor(entry: QueuedAction): void {
    this.ctx.cards?.get(entry.actorId)?.layoutCard.invalidate();
  }

  /** Submit the queued action for `key` via `ctx.reducers.proposeAction`.
   *  Marks the entry `submitted` before dispatch — that locks
   *  `evaluateRoot` and cluster-pruning out for the duration of the
   *  round-trip. The promise handlers then remove the entry on either
   *  outcome (so a rejected action can be re-tried by the next
   *  evaluation; an accepted action's cards will arrive carrying
   *  `slot_hold`, which excludes them from future walks). */
  private fireAction(key: string): void {
    const action = this.queue.get(key);
    if (!action || action.submitted) return;

    const rootRow = this.ctx.data.cardsLocal.get(action.looseRootId);
    if (!rootRow) {
      debug.log(
        ["actions"],
        `[ActionManager] fire abort: root=${action.looseRootId} dir=${action.direction} (root row gone)`,
        2,
      );
      this.queue.delete(key);
      return;
    }

    const slots = action.chain.slice();
    const hex = action.hasHex ? action.hexParentId : 0;
    const root = action.hasRoot ? action.looseRootId : 0;

    const submittedEntry: QueuedAction = { ...action, submitted: true };
    this.queue.set(key, submittedEntry);
    // Kick the actor's layout so its progress bar disappears on the
    // next frame — `progressFor` skips submitted entries.
    this.invalidateActor(submittedEntry);

    debug.log(
      ["actions"],
      `[ActionManager] attempting action: recipe=${action.recipeIndex} root=${root} hex=${hex} slots=[${slots.join(",")}] rootDist=${action.rootDist} dir=${action.direction} surface=${rootRow.surface} macroZone=${rootRow.macroZone} microZone=0x${rootRow.microZone.toString(16)} microLocation=${rootRow.microLocation}`,
      2,
    );

    const cleanup = () => {
      // Only remove if this exact submitted entry is still present —
      // a `dropForCard` could have replaced it in the meantime.
      if (this.queue.get(key) === submittedEntry) {
        this.queue.delete(key);
      }
    };

    this.ctx.reducers
      .proposeAction({
        hex,
        root,
        slots,
        surface: rootRow.surface,
        macroZone: rootRow.macroZone,
        microZone: rootRow.microZone,
        microLocation: rootRow.microLocation,
        recipeId: action.recipeIndex,
        rootDist: action.rootDist,
      })
      .then(() => {
        debug.log(
          ["actions"],
          `[ActionManager] proposeAction accepted: t=${(Date.now() / 1000).toFixed(3)} recipe=${action.recipeIndex} key=${key}`,
          2,
        );
        cleanup();
      })
      .catch((err: unknown) => {
        debug.log(
          ["actions"],
          `[ActionManager] proposeAction rejected: recipe=${action.recipeIndex} err=${String(err)}`,
          2,
        );
        cleanup();
      });
  }

  private queueKey(
    looseRootId: number,
    direction: StackDirection,
    recipeIndex: number,
    actorId: number,
  ): string {
    return `${looseRootId}:${direction}:${recipeIndex}:${actorId}`;
  }

  /** Walk `cardsLocal.ownerId` up from `cardId` until reaching a row
   *  carrying `FLAG_OWNED_BY_PLAYER` — that row IS the soul, and its
   *  card_id is returned. Returns `0` if the walk reaches world
   *  (`ownerId === 0` without the flag), hits a card not present
   *  locally, or trips the depth cap (defensive against cycles).
   *  Mirrors server-side `cards::owning_soul`. */
  private owningSoulCardId(cardId: number): number {
    const FLAG_OWNED_BY_PLAYER = 1 << 20;
    const DEPTH_CAP = 32;
    let cur = cardId;
    for (let i = 0; i < DEPTH_CAP; i++) {
      const row = this.ctx.data.cardsLocal.get(cur);
      if (!row) return 0;
      if ((row.flags & FLAG_OWNED_BY_PLAYER) !== 0) return cur;
      if (row.ownerId === 0) return 0;
      cur = row.ownerId;
    }
    return 0;
  }

  /** When a stack-change event fires for a chain rooted at a soul, every
   *  other chain owned by that soul also needs re-evaluation — recipe
   *  has-predicates feed off `topStackDefs(soulId, …)`, so an equip /
   *  unequip on the soul transitions those chains' matchability without
   *  any structural change on the chains themselves. Iterate
   *  `cardsLocal` and re-evaluate every other eligible loose root
   *  (state-0 LOOSE or state-3 virtual world hex root) whose owning
   *  soul resolves to `rootId`.
   *
   *  No-op when `rootId` isn't a soul. The soul walking itself on the
   *  world also fires this path; the fan-out is harmless — chains that
   *  don't match cheap-out in `evaluateRoot`'s phase loop. */
  private cascadeFromSoulChange(rootId: number): void {
    const FLAG_OWNED_BY_PLAYER = 1 << 20;
    const rootRow = this.ctx.data.cardsLocal.get(rootId);
    if (!rootRow) return;
    if ((rootRow.flags & FLAG_OWNED_BY_PLAYER) === 0) return;

    for (const row of this.ctx.data.cardsLocal.values()) {
      if (row.cardId === rootId) continue;
      const state = getStackedState(row.microZone);
      const isLoose = state === STACKED_LOOSE;
      const isVirtualWorldHexRoot =
        state === STACKED_ON_HEX &&
        row.microLocation === 0 &&
        row.surface >= WORLD_LAYER;
      if (!isLoose && !isVirtualWorldHexRoot) continue;
      if (this.owningSoulCardId(row.cardId) !== rootId) continue;
      this.evaluateRoot(row.cardId);
    }
  }

  /** Packed defs of cards currently stacked on `soulId` in the given
   *  `direction` (UP = equipment / above, DOWN = action stack /
   *  below). Used by `tryMatch` to feed `has` / `reagents.has` /
   *  `has_below` predicate filters into the wasm matcher.
   *
   *  Walks the chain BFS-style from the soul outward, accepting both
   *  state-1 (`Slot`, `microLocation = immediate parent`) and
   *  state-2 (`OnRoot`, `microLocation = chain root`) rows. Both
   *  encodings appear in `cardsLocal`:
   *   - `CardManager.stack` writes state-1 from drag-drop.
   *   - The server's `equip_card` / `propose_action` writes state-2,
   *     but `mirrorCard.preservePosition` keeps the local state-1
   *     shape when `force_position` is clear — so practically the
   *     local row's state can differ from the server's verbatim.
   *  A filter on either state alone would miss whichever the server
   *  wrote. The BFS subsumes both: every child whose
   *  `microLocation` points into the already-visited chain set is
   *  picked up.
   *
   *  Returns an empty array when `soulId === 0` or no chained cards
   *  in that direction. The matcher treats an empty pool as "this
   *  slot has no candidate," filtering any recipe that declares a
   *  has-predicate for it. */
  private topStackDefs(soulId: number, direction: number): number[] {
    if (soulId === 0) return [];

    // Build a `parentId -> children[]` index over chain rows in this
    // direction. `parentId` is whatever `microLocation` points at,
    // regardless of whether the row is `Slot` (immediate-predecessor
    // pointer) or `OnRoot` (chain-root pointer). The BFS below
    // naturally handles both shapes because:
    //   - Multiple `OnRoot` siblings under one root all show up as
    //     children of that root and are visited at the same depth.
    //   - `Slot` chains form a linked list; each card is a child of
    //     the prior. The BFS traverses depth-first effectively
    //     because there's only one child per parent in a pure Slot
    //     chain.
    const childrenByParent = new Map<number, { id: number; def: number }[]>();
    for (const row of this.ctx.data.cardsLocal.values()) {
      const state = getStackedState(row.microZone);
      if (state !== STACKED_ON_ROOT && state !== STACKED_SLOT) continue;
      if (getStackDirection(row.microZone) !== direction) continue;
      const parentId = row.microLocation;
      if (parentId === 0) continue;
      let list = childrenByParent.get(parentId);
      if (list === undefined) {
        list = [];
        childrenByParent.set(parentId, list);
      }
      list.push({ id: row.cardId, def: row.packedDefinition });
    }

    const result: number[] = [];
    const visited = new Set<number>([soulId]);
    const queue: number[] = [soulId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const kids = childrenByParent.get(cur);
      if (kids === undefined) continue;
      for (const kid of kids) {
        if (visited.has(kid.id)) continue;
        visited.add(kid.id);
        result.push(kid.def);
        queue.push(kid.id);
      }
    }
    return result;
  }
}

function queueActionDiffers(a: QueuedAction, b: QueuedAction): boolean {
  return (
    a.recipeIndex !== b.recipeIndex ||
    a.actorId !== b.actorId ||
    a.rootDist !== b.rootDist ||
    a.hasRoot !== b.hasRoot ||
    a.hasHex !== b.hasHex ||
    a.hexParentId !== b.hexParentId ||
    a.looseRootId !== b.looseRootId ||
    !sameChain(a.chain, b.chain)
  );
}

function sameChain(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
