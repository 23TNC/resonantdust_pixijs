import { debug } from "../../debug";
import type { GameContext } from "../../GameContext";
import type { Card } from "../cards/Card";
import {
  getStackedState,
  STACK_DIRECTION_DOWN,
  STACK_DIRECTION_UP,
  STACKED_LOOSE,
  STACKED_ON_HEX,
} from "../cards/cardData";

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
    if (
      !looseRoot ||
      !rootRow ||
      getStackedState(rootRow.microZone) !== STACKED_LOOSE
    ) {
      this.dropClusterNonSubmitted(looseRootId, "loose root gone");
      return;
    }

    const hexParentId =
      getStackedState(rootRow.microZone) === STACKED_ON_HEX
        ? rootRow.microLocation
        : 0;
    const hexDef =
      hexParentId !== 0
        ? this.ctx.data.cardsLocal.get(hexParentId)?.packedDefinition ?? 0
        : 0;
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
          rootCard: looseRoot, rootDef, hexDef, hexParentId,
          looseRootId, direction: "up", rootless: false,
          inPassHeld, wanted,
        })) continue phaseLoop;
      }
      if (bot.firstSubChain && bot.firstSubChain.length > 0) {
        if (this.tryMatch({
          subChainCards: bot.firstSubChain,
          fullChain: botChain,
          rootCard: looseRoot, rootDef, hexDef, hexParentId,
          looseRootId, direction: "down", rootless: false,
          inPassHeld, wanted,
        })) continue phaseLoop;
      }

      // Phase 2 — rootless firsts. Skipped when R is held (a prior
      // match already consumed R as a slot, so it can't appear again).
      if (!isHeld(looseRoot)) {
        if (top.firstSubChain && top.firstSubChain.length > 0) {
          if (this.tryMatch({
            subChainCards: top.firstSubChain,
            fullChain: topChain,
            rootCard: looseRoot, rootDef, hexDef, hexParentId,
            looseRootId, direction: "up", rootless: true,
            inPassHeld, wanted,
          })) continue phaseLoop;
        }
        if (bot.firstSubChain && bot.firstSubChain.length > 0) {
          if (this.tryMatch({
            subChainCards: bot.firstSubChain,
            fullChain: botChain,
            rootCard: looseRoot, rootDef, hexDef, hexParentId,
            looseRootId, direction: "down", rootless: true,
            inPassHeld, wanted,
          })) continue phaseLoop;
        }
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
            rootCard: looseRoot, rootDef, hexDef, hexParentId,
            looseRootId, direction: "up", rootless: false,
            inPassHeld, wanted,
          })) continue phaseLoop;
        }
        const botSub = bot.subsequentSubChains[i];
        if (botSub && botSub.length > 0) {
          if (this.tryMatch({
            subChainCards: botSub,
            fullChain: botChain,
            rootCard: looseRoot, rootDef, hexDef, hexParentId,
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
    hexParentId: number;
    looseRootId: number;
    direction: StackDirection;
    rootless: boolean;
    inPassHeld: Set<number>;
    wanted: Map<string, QueuedAction>;
  }): boolean {
    const {
      subChainCards, fullChain, rootCard, rootDef, hexDef, hexParentId,
      looseRootId, direction, rootless, inPassHeld, wanted,
    } = args;

    const slotCards = rootless ? [rootCard, ...subChainCards] : subChainCards;
    if (slotCards.length === 0) return false;

    const slotDefs = slotCards.map((c) =>
      this.ctx.data.cardsLocal.get(c.cardId)?.packedDefinition ?? 0,
    );

    const matchRoot = rootless ? 0 : rootDef;
    const match = this.ctx.definitions.matchStackRecipe(
      hexDef,
      matchRoot,
      slotDefs,
      direction,
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
      `[ActionManager] attempting action: recipe=${action.recipeIndex} root=${root} hex=${hex} slots=[${slots.join(",")}] rootDist=${action.rootDist} dir=${action.direction}`,
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
          `[ActionManager] proposeAction accepted: recipe=${action.recipeIndex} key=${key}`,
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
