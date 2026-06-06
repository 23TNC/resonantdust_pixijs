import { debug } from "../../debug";
import type { GameContext } from "../../GameContext";
import { microIsCard, microLooseCell } from "../cards/cardData";
import {
  STACK_DIRECTION_DOWN,
  STACK_DIRECTION_HEX,
  STACK_DIRECTION_UP,
} from "../cards/cardData";
import { WORLD_LAYER, type MacroZone } from "../../server/data/packing";
import type { LocalCard } from "../../server/data/DataManager";
import { getZoneTileSlot } from "../viewport/worldCoords";
import type { MatchResult } from "./recipeMatcher";
import { isSlotHeld } from "./chainState";

/** Default fire-after-match delay. Matches stay queued for this long
 *  before being submitted to the server, giving the player a window
 *  to break the chain (drag a card off, etc.) and abort. */
const DEFAULT_DELAY_MS = 5000;

/** Max retries after `time_drift:client_ahead_by` rejections. The
 *  retry mechanism waits for the server's clock to catch up to the
 *  row's `valid_at`; cap exists to bound runaway loops when the
 *  client's clock is catastrophically off (broken NTP, etc.). After
 *  this many retries the entry is dropped and the player would have
 *  to re-trigger the action. */
const MAX_TIME_DRIFT_RETRIES = 3;

/** Padding added on top of the server-reported "ahead by N ms" gap
 *  when scheduling a retry. Absorbs the round-trip back to the
 *  server plus the time-to-effective-now math, so the retry lands
 *  comfortably past the boundary that triggered the rejection. */
const TIME_DRIFT_RETRY_PAD_MS = 250;

/** Regex matching the server's `time_drift:` rejection prefix from
 *  [`cards::effective_now_ms`]. Captures direction (`ahead`/`behind`)
 *  and the gap in milliseconds. See
 *  [time_sync.rs](../../server/spacetime/bindings/shard) /
 *  [cards.rs](../../../../spacetime/server/modules/shard/src/cards.rs). */
const TIME_DRIFT_RE = /time_drift:client_(ahead|behind)_by=(\d+)/;

export interface ActionManagerOptions {
  /** Milliseconds to wait after a match is queued before submitting
   *  it via `proposeAction`. If the queue entry is updated during
   *  the wait the timer is reset; if it's dropped the timer is
   *  cancelled. */
  delayMs?: number;
}

/** A recipe match the client has detected on a chain.
 *
 *  Queue keys are `${looseRootId}:${recipeId}`. Under the unified
 *  card model each chain root has **at most one match at a time** —
 *  the matcher takes the chain configuration as a unit and returns
 *  the single highest-priority recipe that fires, if any. So each
 *  loose root maps to at most one queue entry.
 */
export interface QueuedAction {
  /** Loose root of the chain this match lives in. The chain root
   *  the recipe operates on. */
  looseRootId: number;
  /** Stable packed recipe id (`u16`). */
  recipeId: number;
  /** Per-iterator card_id bindings, ready to pass to
   *  `proposeAction` directly. `bindings[i]` is the cards for
   *  `recipe.iterators[i]` in offset order. */
  bindings: number[][];
  /** Root's world / inventory address at queue time. Snapshotted so
   *  the action submits with the location the player saw at
   *  match-time, even if the root row mutates during the debounce
   *  window (server will reject in Stage 2 cross-check if it
   *  doesn't agree). */
  surface: number;
  macroZone: bigint;
  microLocation: number;
  /** True between `proposeAction` dispatch and its round-trip
   *  resolution. While submitted, `evaluateRoot` and the
   *  cluster-pruning paths leave the entry alone — the user has
   *  committed to the action and the client may not cancel or
   *  upgrade it. */
  submitted: boolean;
  /** `performance.now()` value at the moment the fire-after-match
   *  timer was last (re)started. UI uses this with `delayMs` to
   *  draw the per-card debounce-progress indicator. `0` while the
   *  entry hasn't been scheduled (i.e. just constructed). */
  scheduledAt: number;
  /** Debounce duration for this specific entry, in milliseconds.
   *  Usually the manager's `DEFAULT_DELAY_MS`, but recipes with a
   *  single input statement use `0` — those have no
   *  cancel-affordance (the only "chain" is root itself, which the
   *  player can't intrinsically alter during a debounce window), so
   *  the debounce just adds latency without giving the player any
   *  real choice. Lifecycle / on-create style recipes (`fleeting`,
   *  `corpus-`, `despair_failure`, etc.) all fall into this bucket. */
  delayMs: number;
  /** Card the UI anchors the debounce progress bar to. Resolved at
   *  queue time using the priority cascade:
   *
   *    slot.1.0 (first card of top stack)
   *      → slot.2.0 (first card of bottom stack)
   *      → root
   *
   *  Snapshotted in the queue entry so a mid-debounce chain mutation
   *  (which would also drop the entry) doesn't leave the bar
   *  flicker-relocating. `progressFor(cardId)` returns the fraction
   *  iff `cardId === progressAnchor`. */
  progressAnchor: number;
  /** Number of times this action has already been retried after a
   *  `time_drift:client_ahead_by` rejection from the server. Capped
   *  at `MAX_TIME_DRIFT_RETRIES` to prevent infinite loops if the
   *  client's clock is catastrophically out of sync. */
  retryCount: number;
}

/**
 * Scene-scoped recipe pre-filter and submission queue.
 *
 * Listens to stack-change events from `CardManager`. For each
 * affected loose root R, gathers `(root, branches[0..2])` and asks
 * `DefinitionManager.findRecipeMatch` whether the assembly fires a
 * recipe. If it does, queues a `QueuedAction`; after `delayMs`
 * elapses without the entry being mutated, submits via
 * `ctx.reducers.proposeAction`.
 *
 * One queue entry per loose root maximum — the new matcher returns
 * at most one match per configuration. Replacing the legacy
 * multi-phase sliding-window walker.
 */
export class ActionManager {
  private readonly queue = new Map<number, QueuedAction>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly delayMs: number;
  private readonly unsubStackChange: () => void;
  private readonly unsubData: () => void;
  /** Client-side prediction sets. Bridges the round-trip window between
   *  proposeAction dispatch and the server's `slot_hold` /
   *  `position_hold_count` writes — readers consult these via
   *  [`isSlotHeld`] / [`isPositionHeld`] in `chainState.ts`. Server is
   *  authoritative; entries clear at the round-trip response. */
  private readonly predSlotHold = new Set<number>();
  private readonly predPositionHold = new Set<number>();

  constructor(
    private readonly ctx: GameContext,
    options: ActionManagerOptions = {},
  ) {
    if (!ctx.cards) {
      throw new Error("[ActionManager] ctx.cards is null — CardManager must exist");
    }
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

    this.unsubStackChange = ctx.cards.subscribeAllStackChanges((rootId) => {
      // Re-evaluate the reported root (catches new matches arising
      // from the change) AND every existing queued action's root.
      //
      // The reported `rootId` is `fireStackChange`'s `rootOf` walk
      // from the mutated card, which doesn't always coincide with
      // an existing queue's key — e.g. a queue was made when card X
      // was a loose root, then X moved to a state-3 child of hex Y,
      // and now a chain mutation under X reports `rootOf(X) = Y`.
      // Without re-evaluating queued roots, X's stale queue can't
      // be invalidated.
      //
      // Re-evaluation is the unifying primitive: each queue's
      // validity is a function of the current chain rooted at its
      // `looseRootId`. Whenever anything in the chain graph
      // mutates, every queue re-derives its validity from current
      // state. No edge cases to chase — chain re-rooting, state
      // transitions, child pulls, all collapse into the same loop.
      this.recheckAllQueued(rootId);
    });

    this.unsubData = ctx.data.subscribeLocalCard((change) => {
      if (change.kind === "removed") {
        // A consumed/removed card can't be re-bound — drop its predicted hold
        // so it doesn't linger (predictions are kept past accept now; see
        // `fireAction`).
        this.clearPrediction(change.key);
        this.dropForCard(change.key);
        return;
      }
      // `added` events fire for cards arriving fresh from the server
      // (recipe outputs, character_creation spawns, etc). They aren't
      // attached to any chain yet — `subscribeAllStackChanges` only
      // fires when a card moves into/out of an existing chain, so a
      // brand-new loose card never reaches `evaluateRoot` without
      // this hook. Examples broken without it: corpus- spawned by
      // `corpus_b.1` doesn't start its self-destruct lifecycle;
      // freshly-magnetic cards don't begin their inner recipe pull.
      if (change.kind === "added") {
        // A loose card (`!micro_is_card`) is a chain root. Stacked members
        // and still-deferred rows (resolved by `mirrorCard` first) aren't.
        const isRoot = !microIsCard(change.row.flagsBk);
        if (isRoot && change.row.dead !== 2) {
          this.evaluateRoot(change.key);
        }
        return;
      }
      // `updated` covers every other row mutation: dead-bit flips
      // (`dead === 1` after server marks the card destroyed),
      // server-forced position writes (FLAG_POS_NEED / FLAG_POS_WANT
      // from another action's chain_stitch), slot_hold acquisition by
      // a concurrent recipe, magnetic-flag flips, ownership changes,
      // packed_definition shifts, etc. Any of these can invalidate
      // an outstanding queue.
      //
      // Rather than enumerate which fields matter, funnel through
      // the same `recheckAllQueued` primitive used for stack
      // changes — the matcher is a pure function of state, so
      // re-deriving every queue's validity from current state is
      // the unifying answer. Same brute-force / small-N tradeoff
      // documented at the stack-change site above.
      //
      // The most important specific case this closes is the
      // "card died, queue still firing" gap: today, `mirrorCard`
      // writes `dead = 1` on the local row via an `updated` event;
      // `subscribeAllStackChanges` doesn't fire for flag-only
      // changes; the queue lingers until debounce expiry and
      // `proposeAction` hits the server's `card N is dead`
      // rejection. With this hook, the death triggers
      // `recheckAllQueued` → `evaluateRoot` → death gate drops
      // the queue immediately.
      //
      // Also retire this card's predicted hold once the server's
      // authoritative hold lands (see `reconcilePredictedHolds`) — done
      // BEFORE the recheck so the matcher sees a consistent (server-held,
      // not predicted) state in the same pass.
      this.reconcilePredictedHolds(change.key, change.newRow);
      this.recheckAllQueued(change.key);
    });

    // Initial scan: every unchained root currently in cardsLocal gets
    // a fresh evaluation. Stacked (non-root) cards are reached
    // transitively via their root. Only `STACKED_LOOSE` is a real
    // root state in the unified model — state 3 (`STACKED_DEFERRED`)
    // is transient and resolved by `mirrorCard` before reaching here.
    for (const row of ctx.data.cardsLocal.values()) {
      if (!microIsCard(row.flagsBk)) {
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
    this.predSlotHold.clear();
    this.predPositionHold.clear();
  }

  /** True if `cardId` is currently being predicted as slot-held by a
   *  proposeAction dispatch awaiting round-trip. Read site for
   *  [`isSlotHeld`] in `chainState.ts`. */
  isSlotHeldPrediction(cardId: number): boolean {
    return this.predSlotHold.has(cardId);
  }

  /** Companion to [`isSlotHeldPrediction`]. */
  isPositionHeldPrediction(cardId: number): boolean {
    return this.predPositionHold.has(cardId);
  }

  /** Snapshot iterator over currently queued actions. */
  pendingActions(): IterableIterator<QueuedAction> {
    return this.queue.values();
  }

  /** Number of queued actions across all roots. */
  pendingCount(): number {
    return this.queue.size;
  }

  /** Per-card debounce progress in `[0, 1]`, or `null` if `cardId`
   *  isn't the progress-anchor of any pending (non-submitted) queued
   *  action. See `QueuedAction.progressAnchor` for the anchor-pick
   *  cascade (`slot.1.0 → slot.2.0 → root`). */
  progressFor(cardId: number): number | null {
    for (const entry of this.queue.values()) {
      if (entry.submitted) continue;
      if (entry.progressAnchor !== cardId) continue;
      // Zero-debounce entries (single-input recipes) never visibly
      // sit in the queue — they fire on the next macrotask. Don't
      // render a bar that would just flicker to full-and-gone.
      if (entry.delayMs <= 0) return null;
      const elapsed = performance.now() - entry.scheduledAt;
      return Math.max(0, Math.min(1, elapsed / entry.delayMs));
    }
    return null;
  }

  /** Re-evaluate the loose root R. Gather its three branches off
   *  root (tile / top / bottom), ask the matcher, queue if hit. */
  private evaluateRoot(looseRootId: number): void {
    const cards = this.ctx.cards;
    if (!cards) return;

    const rootRow = this.ctx.data.cardsLocal.get(looseRootId);
    if (!rootRow) {
      this.dropForCard(looseRootId);
      return;
    }

    // Dead-root gate. `mirrorCard` writes `dead = 1` when the server
    // sets FLAG_ACTION_DEAD on the row, and `dead = 2` once the
    // client's death animation completes. Either way, the card is
    // logically gone — the server's `validate_bindings` would reject
    // any propose against it. Drop any existing queue and don't
    // attempt to match a new one (predicates would still pass against
    // the still-readable def/aspects/flags, but the propose would
    // just bounce).
    if ((rootRow.dead ?? 0) > 0) {
      const existing = this.queue.get(looseRootId);
      if (existing && !existing.submitted) {
        this.dropForRoot(looseRootId, "root is dead");
      }
      return;
    }

    // Root must be unchained — chain-stitched cards aren't roots,
    // and we don't match against in-progress chains. `STACKED_LOOSE`
    // is the only root state in the unified model. Value 3 (formerly
    // `STACKED_ON_HEX`, now repurposed as `STACKED_DEFERRED`) is
    // transient — mirror resolution writes a concrete state 1/2 row
    // before any recipe matcher sees it, so deferred rows never reach
    // this evaluator as roots. Match-side, the synthetic-tile lookup
    // below treats the tile under a card as branch-0 of the chain.
    //
    // Use `dropForRoot` (not `dropForCard`) — the card still EXISTS
    // (just stack-chained somewhere), it isn't removed. `dropForCard`
    // would additionally walk every other queue's bindings and drop
    // any queue that mentions this card, which is wrong: a recipe
    // like `cut_tree` legitimately references an equipped axe via
    // `share.slot.1.0.owner.slot.1.0.def_id: axe`. When the axe
    // shows up as a `triggeredRootId` in `recheckAllQueued` (e.g.
    // because `applyPredictedHolds` just stamped `predict_position_hold`
    // on it), `evaluateRoot(axe)` lands here — and pre-fix would
    // nuke every cut_tree queue that depends on the axe.
    if (microIsCard(rootRow.flagsBk)) {
      this.dropForRoot(looseRootId, "no longer a loose root");
      return;
    }

    // Skip in-flight cards: if the server has stamped FLAG_SLOT_HOLD
    // on the root, an action is already running against this chain.
    // Re-evaluating here would propose a duplicate (the chain_stitch
    // server push fires `onDataChange` → `fireStackChange` for the
    // root, but the original `proposeAction` promise has already
    // resolved and cleared our queue entry by then — so without this
    // gate we'd re-match, re-queue, and re-submit, getting bounced
    // by the server's `card N is already claimed by another in-flight
    // action` check). The gate clears naturally when the recipe
    // completes (`action_completion::apply` releases `slot_hold`).
    if (isSlotHeld(this.ctx, rootRow.cardId, rootRow.flagsState, rootRow.flagsBk)) {
      return;
    }

    // Skip magnetic cards: a card carrying `FLAG_LIFECYCLE_PENDING`
    // (registry name `magnetic`) is owned by
    // `LifecycleResolutionManager`, not this manager. Its lifecycle
    // recipe (success/failure path) fires through the
    // try-resolve-success / try-resolve-failure flow when the
    // magnetic pull completes, NOT via generic recipe matching here.
    // Without this gate:
    //   - A freshly-spawned strike card (magnetic flag set) would
    //     match `strike_failure` (root.def_id: strike) and we'd
    //     submit it immediately, before the magnetic pull even
    //     starts.
    //   - When strike's magnetic pull stitches three corpuses into
    //     its chain, the chain {strike, corpus×3} would also match
    //     non-strike recipes like `corpus_b.1`, queueing a
    //     duplicate the server rejects.
    // Both collapse into "magnetic-card chains are off-limits to
    // ActionManager until the magnetic flag clears."
    if (this.ctx.definitions.hasCardFlag(rootRow.flagsState, rootRow.flagsBk, "magnetic")) {
      const existing = this.queue.get(looseRootId);
      if (existing && !existing.submitted) {
        this.dropForRoot(looseRootId, "root is magnetic — owned by LifecycleResolutionManager");
      }
      return;
    }

    // Gather branches 0/1/2 by walking the chain in each direction.
    const branchHex = cards
      .buildChain(looseRootId, STACK_DIRECTION_HEX)
      .map((c) => c.cardId);
    const branchUp = cards
      .buildChain(looseRootId, STACK_DIRECTION_UP)
      .map((c) => c.cardId);
    const branchDown = cards
      .buildChain(looseRootId, STACK_DIRECTION_DOWN)
      .map((c) => c.cardId);

    // Synthetic-tile binding: when root sits on a tile-bearing
    // surface and branch 0 has no card, resolve the tile data so
    // recipes referencing `slot.0.0.aspect.X.min` (alias `Hex.0`)
    // can match. Card-priority lookup: a promoted tile-card at the
    // hex (possibly orphaned — microLocation points to a moved /
    // lifted root) wins over the Zone slot. Falls back to
    // `zonesLocal` when no tile-card resolves. See
    // `docs/TILE_AS_CARD.md`.
    //
    // Threshold gates the inventory layer (1) out — it has no tile
    // bitfield — admitting only `WORLD_LAYER` (64+), tile-bearing today.
    let syntheticTile: { packedDef: number; stock0: number; stock1: number } | null = null;
    if (rootRow.macroZone.surface >= WORLD_LAYER && branchHex.length === 0) {
      const { localQ, localR } = microLooseCell(rootRow.microLocation);
      const tileCardRow = findFreeTileCardAt(
        this.ctx.data.cardsLocal,
        rootRow.macroZone.surface,
        rootRow.macroZone.packed,
        localQ,
        localR,
      );
      if (tileCardRow !== null) {
        syntheticTile = {
          packedDef: tileCardRow.packedDefinition,
          stock0:
            this.ctx.definitions.cardFlagFieldValueIn(
              "cards_bk",
              tileCardRow.flagsBk,
              "tile_stock_0",
            ) ?? 0,
          stock1:
            this.ctx.definitions.cardFlagFieldValueIn(
              "cards_bk",
              tileCardRow.flagsBk,
              "tile_stock_1",
            ) ?? 0,
        };
      } else {
        const slot = getZoneTileSlot(
          this.ctx.data.zonesLocal,
          rootRow.macroZone.packed,
          localQ,
          localR,
        );
        if (slot.packed !== 0) {
          syntheticTile = {
            packedDef: slot.packed,
            stock0: slot.stock0,
            stock1: slot.stock1,
          };
        }
      }
    }

    const cardsLocal = this.ctx.data.cardsLocal;
    const match = this.ctx.definitions.findRecipeMatch({
      root: looseRootId,
      branches: [branchHex, branchUp, branchDown],
      cardLookup: (id: number) => {
        const row = cardsLocal.get(id);
        if (!row) return null;
        // Treat dead cards as absent. Their def/aspects/flags are
        // still readable, but a recipe binding a dead card would be
        // server-rejected at validate_bindings. Returning null here
        // makes the matcher's predicate eval (`def_id`, `aspect.X`)
        // fail naturally for paths that resolve to a dead card —
        // queues referencing the dead card drop on the next recheck.
        if ((row.dead ?? 0) > 0) return null;
        // Treat slot-held cards as absent. A card with the server-
        // set `slot_hold` bit (or the client-prediction equivalent)
        // is claimed by an in-flight action; binding it to a new
        // action would hit the server's `card N is already claimed
        // by another in-flight action` rejection.
        //
        // The root-slot-held gate above prevents the chain ROOT from
        // re-matching, but for slot-held *children* the gate doesn't
        // fire — they were entered via `buildChain`, not as the
        // matcher's root. Without this filter, post-accept server
        // pushes (releasing predict_slot_hold, landing server
        // slot_hold) re-trigger `evaluateRoot`, the matcher sees the
        // claimed children as available bindings, and we propose the
        // same recipe twice. See the post-corpus_b.2-accept rejection
        // for the canonical trace.
        if (isSlotHeld(this.ctx, row.cardId, row.flagsState, row.flagsBk)) return null;
        return {
          cardId: row.cardId,
          packedDefinition: row.packedDefinition,
          ownerId: row.ownerId,
          microLocation: row.microLocation,
        };
      },
      syntheticTile,
      branchWalker: (parentId: number, direction: number) => {
        return cards
          .buildChain(parentId, direction)
          .map((c) => c.cardId);
      },
    });

    if (match === null) {
      // No recipe matches this configuration. Drop any queued
      // (non-submitted) entry for this root — the chain mutated to
      // a no-longer-matching state.
      const existing = this.queue.get(looseRootId);
      if (existing && !existing.submitted) {
        this.dropForRoot(looseRootId, "chain no longer matches");
      }
      return;
    }

    this.queueAction(rootRow, match);
  }

  /** Build / update / replace a queue entry for the matched recipe.
   *  The debounce timer is (re)started on every entry update;
   *  if the entry is unchanged (same recipeId + bindings), the
   *  timer keeps running — only a real change resets it. */
  private queueAction(
    rootRow: {
      cardId: number;
      macroZone: MacroZone;
      microLocation: number;
    },
    match: MatchResult,
  ): void {
    const existing = this.queue.get(rootRow.cardId);
    if (existing && existing.submitted) {
      // Submitted entry is committed — leave it alone.
      return;
    }
    // The root's loose `microLocation` (cell + within-cell offset) is the
    // wire position; the server's `chain_stitch` decodes the cell from it.
    const microLocationForWire = rootRow.microLocation;
    if (
      existing !== undefined &&
      existing.recipeId === match.recipeId &&
      bindingsEqual(existing.bindings, match.bindings)
    ) {
      // Recipe + bindings unchanged. Keep the existing timer running — but
      // the root may have moved between queue and now, so re-snapshot its
      // CURRENT `surface / macroZone / microLocation` so `chain_stitch`
      // writes it where the player sees it (else it snaps back).
      existing.surface = rootRow.macroZone.surface;
      existing.macroZone = rootRow.macroZone.packed;
      existing.microLocation = microLocationForWire;
      return;
    }

    // Progress-bar anchor: matcher computed it from the matched
    // bindings. Promotion-aware — when root was promoted to slot.1.0
    // (recipes where root is omitted), the matcher returns root here
    // so the bar lands on the card the recipe semantically calls
    // slot.1.0, regardless of which card physically holds that role.
    const progressAnchor = match.progressAnchor !== 0
      ? match.progressAnchor
      : rootRow.cardId;

    // Single-input recipes bypass the debounce: they have no
    // cancel-affordance (no slot chain the player can break) and
    // are typically on-create / lifecycle triggers (`fleeting`,
    // `corpus-`, `despair_failure`, `strike_failure`). Sitting on
    // a 5-second debounce timer just delays inevitable execution.
    const delayMs = match.inputCount <= 1 ? 0 : this.delayMs;

    const entry: QueuedAction = {
      looseRootId: rootRow.cardId,
      recipeId: match.recipeId,
      bindings: match.bindings,
      surface: rootRow.macroZone.surface,
      macroZone: rootRow.macroZone.packed,
      microLocation: microLocationForWire,
      submitted: false,
      scheduledAt: 0,
      progressAnchor,
      delayMs,
      retryCount: 0,
    };
    this.queue.set(rootRow.cardId, entry);
    this.scheduleTimer(rootRow.cardId);
    // Force the anchor card's layout to re-run so the bar appears on
    // the next frame. Stack-change events typically invalidate the
    // involved cards anyway via their data-subscription, but the
    // initial-scan path queues without any data mutation — the
    // anchor card has already been laid out and would otherwise show
    // no bar until something else touched it.
    this.ctx.cards?.get(progressAnchor)?.layoutCard.invalidate();
  }

  /** Drop the queue entry for a specific root. Called when the
   *  chain mutates to a no-longer-matching configuration, or when
   *  the root itself leaves cardsLocal. */
  private dropForRoot(rootId: number, why: string): void {
    const entry = this.queue.get(rootId);
    if (entry === undefined || entry.submitted) return;
    this.cancelTimer(rootId);
    this.queue.delete(rootId);
    // Force the anchor card to re-layout so the bar disappears
    // immediately rather than waiting for the next data tick.
    this.ctx.cards?.get(entry.progressAnchor)?.layoutCard.invalidate();
    debug.log(
      ["actions"],
      `[ActionManager] dropped root ${rootId}: ${why}`,
      2,
    );
  }

  /** Re-evaluate every queued action's root, plus the reported
   *  `triggeredRootId` if it isn't already a queue key. This is the
   *  unified invalidation primitive — see the call site in
   *  `subscribeAllStackChanges` for why.
   *
   *  Submitted entries are left alone (their action is already
   *  in-flight on the server). */
  private recheckAllQueued(triggeredRootId: number): void {
    // Snapshot queue keys before the loop — `evaluateRoot` may
    // mutate `this.queue` (drop entries when no match, replace
    // entries when bindings change).
    const queuedRoots = [...this.queue.keys()];
    for (const rootId of queuedRoots) {
      const entry = this.queue.get(rootId);
      if (entry?.submitted) continue;
      this.evaluateRoot(rootId);
    }
    if (!queuedRoots.includes(triggeredRootId)) {
      this.evaluateRoot(triggeredRootId);
    }
  }

  /** Drop entries that reference `cardId` — typically called when a
   *  card leaves `cardsLocal` (server delete, subscription
   *  teardown). Walks both the queue keys and every queued entry's
   *  bindings; if `cardId` shows up anywhere, the action can no
   *  longer fire and gets pruned. */
  private dropForCard(cardId: number): void {
    // Direct queue key (cardId is a root).
    this.dropForRoot(cardId, "card removed");
    // Bound elsewhere.
    for (const [rootId, entry] of this.queue) {
      if (entry.submitted) continue;
      if (entry.progressAnchor === cardId) {
        this.dropForRoot(rootId, "progress-anchor card removed");
        continue;
      }
      for (const row of entry.bindings) {
        if (row.includes(cardId)) {
          this.dropForRoot(rootId, `bound card ${cardId} removed`);
          break;
        }
      }
    }
  }

  private scheduleTimer(rootId: number): void {
    this.cancelTimer(rootId);
    const entry = this.queue.get(rootId);
    if (!entry || entry.submitted) return;
    entry.scheduledAt = performance.now();
    const handle = setTimeout(() => {
      this.timers.delete(rootId);
      this.fireAction(rootId);
    }, entry.delayMs);
    this.timers.set(rootId, handle);
  }

  private cancelTimer(rootId: number): void {
    const handle = this.timers.get(rootId);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.timers.delete(rootId);
    }
  }

  /** Submit the queued action for `rootId` via
   *  `ctx.reducers.proposeAction`.
   *
   *  Re-evaluates the chain one last time at fire-time as a safety
   *  net. The stack-change subscription should have caught any
   *  invalidating mutations already, but this final check makes the
   *  guarantee structural: the action only proposes against current
   *  state. If the chain no longer matches, `evaluateRoot` drops the
   *  queue and the subsequent `this.queue.get(rootId)` lookup
   *  returns undefined — we bail before sending. */
  private fireAction(rootId: number): void {
    this.evaluateRoot(rootId);
    const action = this.queue.get(rootId);
    if (!action || action.submitted) return;
    // Pre-flight gate: if this root is currently being predicted as
    // slot-held by an in-flight propose round-trip we dispatched, the
    // server's `validate_bindings` will reject this one too. Skip the
    // round trip entirely — the existing `evaluateRoot` slot-held gate
    // catches server-acknowledged holds, but not predictions, since
    // predictions live in this manager's sidecar (not in `Card.flags`).
    // Drop the queue entry so a future chain mutation can re-evaluate
    // cleanly after the in-flight action completes.
    if (this.predSlotHold.has(rootId)) {
      this.queue.delete(rootId);
      this.ctx.cards?.get(action.progressAnchor)?.layoutCard.invalidate();
      return;
    }
    action.submitted = true;
    // `progressFor` returns null for submitted entries — force the
    // anchor card to re-layout so the bar clears immediately rather
    // than freezing at the last drawn fraction.
    this.ctx.cards?.get(action.progressAnchor)?.layoutCard.invalidate();

    debug.log(
      ["actions"],
      `[ActionManager] proposeAction recipe=${action.recipeId} root=${rootId} bindings=${JSON.stringify(action.bindings)}`,
      4,
    );

    // Stamp `predict_slot_hold` / `predict_position_hold` on every card
    // the recipe will claim, bridging the round-trip window where the
    // server's `slot_hold` / `position_hold_count` writes haven't yet
    // arrived. Without this, a card whose lifecycle has it scheduled
    // to die at T can race the proposeAction round-trip: client marks
    // it dead, animation starts, the server's slot_hold (which would
    // have deferred death) arrives after the card has already been
    // removed from the scene. The predicted bits give the client the
    // same deferral signal immediately.
    this.applyPredictedHolds(action);

    const cleanup = () => {
      // Clear the predicted holds before dropping the entry. By the
      // time the reducer event arrives, the server's authoritative
      // `slot_hold` / `position_hold_count` writes have already
      // landed in `cardsLocal` via the subscription (the SDK delivers
      // row updates before firing the reducer callback), so dropping
      // the prediction here doesn't leave a gap.
      this.clearPredictedHolds(action);
      // Once the round trip resolves, drop the entry so a future
      // chain mutation can re-evaluate. Check identity in case
      // a different mutation has already replaced the queue slot.
      if (this.queue.get(rootId) === action) {
        this.queue.delete(rootId);
      }
    };

    this.ctx.reducers
      .proposeAction({
        recipeId: action.recipeId,
        surface: action.surface,
        macroZone: action.macroZone,
        microLocation: action.microLocation,
        root: action.looseRootId,
        bindings: action.bindings,
      })
      .then(() => {
        debug.log(
          ["actions"],
          `[ActionManager] proposeAction accepted: recipe=${action.recipeId} root=${rootId}`,
          3,
        );
        // Delete the entry so a genuinely new assembly can re-evaluate, but
        // KEEP the predicted holds: they make the matcher read the claimed cards
        // as absent across the window between accept and the server's `slot_hold`
        // landing in `cardsLocal`. Clearing them here (the old behavior) reopened
        // that window — a recheck saw the cards still available and re-proposed
        // the SAME recipe (a second cut_tree right after the first). The
        // predictions now clear when the server hold lands
        // (`reconcilePredictedHolds`, on the card update) or the card is consumed
        // (the `removed` subscription). Rejection still clears them (see catch).
        if (this.queue.get(rootId) === action) this.queue.delete(rootId);
      })
      .catch((err: unknown) => {
        const errStr = String(err);
        // `time_drift:client_ahead_by=N` means the client's clock estimate
        // overshot the server's; the row this action depends on exists in
        // the future of the server's wall-clock. Wait N ms for the server
        // to catch up, then re-evaluate and resubmit. Capped at
        // `MAX_TIME_DRIFT_RETRIES` to keep a catastrophically-skewed
        // client from looping forever.
        const drift = TIME_DRIFT_RE.exec(errStr);
        if (
          drift &&
          drift[1] === "ahead" &&
          action.retryCount < MAX_TIME_DRIFT_RETRIES
        ) {
          const gapMs = Number.parseInt(drift[2], 10);
          const delayMs = gapMs + TIME_DRIFT_RETRY_PAD_MS;
          debug.log(
            ["actions"],
            `[ActionManager] proposeAction time-drift rejected: recipe=${action.recipeId} root=${rootId} ahead_by=${gapMs}ms retry=${action.retryCount + 1}/${MAX_TIME_DRIFT_RETRIES} in ${delayMs}ms`,
            4,
          );
          this.clearPredictedHolds(action);
          action.submitted = false;
          action.retryCount += 1;
          // Re-fire after the server should have caught up. `fireAction`
          // re-runs `evaluateRoot` at the top so a chain mutation between
          // submit and retry (card died, slot_hold acquired, root moved)
          // drops the entry cleanly rather than resubmitting stale state.
          const handle = setTimeout(() => {
            this.timers.delete(rootId);
            this.fireAction(rootId);
          }, delayMs);
          this.timers.set(rootId, handle);
          return;
        }
        debug.log(
          ["actions"],
          `[ActionManager] proposeAction rejected: recipe=${action.recipeId} root=${rootId} err=${errStr}`,
          4,
        );
        cleanup();
      });
  }

  /** Walk the recipe's iterators + root anchor and add `cardId`s to
   *  the prediction sets according to the iterator's tokens (the
   *  parser's per-statement `borrow` / `share` / `claim` / `use`
   *  prefixes aggregated into `Iterator.slotHold` / `positionHold`).
   *  Root gets the union of `recipe.rootSlotHold`/`rootPositionHold`
   *  and any promotion path (root appearing in an iterator's
   *  bindings inherits that iter's tokens). Mirrors `apply_locks` in
   *  `spacetime/server/modules/shard/src/actions.rs` so the client
   *  prediction matches the server's eventual flag writes. */
  private applyPredictedHolds(action: QueuedAction): void {
    const recipe = this.ctx.definitions.recipeMetaById(action.recipeId);
    if (recipe === null) return;

    let rootSlot = recipe.root && recipe.rootSlotHold;
    let rootPos = recipe.root && recipe.rootPositionHold;
    const rootId = action.looseRootId;
    recipe.iterators.forEach((it, i) => {
      const row = action.bindings[i];
      if (!row || !row.includes(rootId)) return;
      if (it.slotHold) rootSlot = true;
      if (it.positionHold) rootPos = true;
    });
    if (rootId !== 0 && (rootSlot || rootPos)) {
      this.setPrediction(rootId, rootSlot, rootPos);
    }

    recipe.iterators.forEach((it, iterId) => {
      if (!it.slotHold && !it.positionHold) return;
      const row = action.bindings[iterId];
      if (!row) return;
      for (const cardId of row) {
        if (cardId === 0 || cardId === rootId) continue;
        this.setPrediction(cardId, it.slotHold, it.positionHold);
      }
    });
  }

  /** Companion to `applyPredictedHolds` — clears the same predictions
   *  on the same set of cards. Walks recipe + bindings + root
   *  identically so we don't have to snapshot the touched-card set at
   *  fire time. */
  private clearPredictedHolds(action: QueuedAction): void {
    const rootId = action.looseRootId;
    if (rootId !== 0) this.clearPrediction(rootId);
    for (const row of action.bindings) {
      for (const cardId of row) {
        if (cardId === 0 || cardId === rootId) continue;
        this.clearPrediction(cardId);
      }
    }
  }

  /** Add `cardId` to the slot/position prediction sets (whichever the
   *  recipe declares) and re-fire the card's local-row listeners so
   *  consumers re-consult the merged held-state via
   *  [`isSlotHeld`] / [`isPositionHeld`]. No-op if the requested
   *  predictions are already present. */
  private setPrediction(cardId: number, slot: boolean, pos: boolean): void {
    const wasSlot = this.predSlotHold.has(cardId);
    const wasPos = this.predPositionHold.has(cardId);
    const wantSlot = wasSlot || slot;
    const wantPos = wasPos || pos;
    if (wantSlot === wasSlot && wantPos === wasPos) return;
    if (wantSlot) this.predSlotHold.add(cardId);
    if (wantPos) this.predPositionHold.add(cardId);
    this.notifyCard(cardId);
  }

  /** Remove `cardId` from both prediction sets and re-fire its
   *  local-row listeners. No-op if nothing was set. */
  private clearPrediction(cardId: number): void {
    const had = this.predSlotHold.delete(cardId);
    const had2 = this.predPositionHold.delete(cardId);
    if (!had && !had2) return;
    this.notifyCard(cardId);
  }

  /** Retire a card's predicted hold once the server's AUTHORITATIVE hold lands
   *  on its row. Predicted holds are kept past `proposeAction` accept (they gate
   *  the matcher across the round-trip window — see `fireAction`); this clears
   *  each the moment the real hold appears, so the matcher transitions from
   *  predicted to server state without reopening a re-queue gap. Per-axis: a
   *  slot prediction clears on server `slot_hold`, a position prediction on
   *  server `position_hold`. */
  private reconcilePredictedHolds(cardId: number, row: LocalCard): void {
    const hadSlot = this.predSlotHold.has(cardId);
    const hadPos = this.predPositionHold.has(cardId);
    if (!hadSlot && !hadPos) return;
    let changed = false;
    if (hadSlot) {
      const slotHeld =
        (this.ctx.definitions.cardFlagFieldValueIn("cards_bk", row.flagsBk, "slot_hold_count") ?? 0) > 0;
      if (slotHeld) {
        this.predSlotHold.delete(cardId);
        changed = true;
      }
    }
    if (hadPos) {
      const posHeld =
        (this.ctx.definitions.cardFlagFieldValueAny(row.flagsState, row.flagsBk, "position_hold_count") ?? 0) > 0;
      if (posHeld) {
        this.predPositionHold.delete(cardId);
        changed = true;
      }
    }
    if (changed) this.notifyCard(cardId);
  }

  /** Re-fire the local-row listeners for `cardId` so subscribers
   *  re-evaluate against the updated prediction sets. The row's flags
   *  are unchanged — predictions live in this manager's sets, not in
   *  `Card.flags`. `setLocalCard` requires a fresh row reference to
   *  treat the call as an update; a shallow clone is the cheapest way
   *  to get one. */
  private notifyCard(cardId: number): void {
    const row = this.ctx.data.cardsLocal.get(cardId);
    if (!row) return;
    this.ctx.data.setLocalCard(cardId, { ...row });
  }
}

/** Find a tile-card (`card_type == 7`) whose hex resolves to
 *  `(surface, macroZone, q, r)` (q/r as local within-zone coords).
 *
 *  Tile-cards may be in any stacked state — `chain_stitch` repacks
 *  `microZone` to `[position:4 | direction:2 | state:2]` when a
 *  recipe binds the tile, losing the original (q, r) bits. To find
 *  the card by hex we walk the parent-pointer chain to the first
 *  Free ancestor and read (q, r) from THAT card. Orphans (Free
 *  ancestor reaped before the tile-card demoted) return `null` and
 *  the caller falls back to zone data — staleness resolves on the
 *  next server write. See [docs/TILE_AS_CARD.md](../../../../docs/TILE_AS_CARD.md). */
function findFreeTileCardAt(
  cardsLocal: Map<number, LocalCard>,
  surface: number,
  macroZone: bigint,
  q: number,
  r: number,
): LocalCard | null {
  const TILE_CARD_TYPE = 7;
  for (const row of cardsLocal.values()) {
    if (row.macroZone.surface !== surface) continue;
    if (row.macroZone.packed !== macroZone) continue;
    const cardType = (row.packedDefinition >> 12) & 0xf;
    if (cardType !== TILE_CARD_TYPE) continue;
    const hex = resolveTileCardHex(cardsLocal, row);
    if (hex === null) continue;
    if (hex.q !== q || hex.r !== r) continue;
    return row;
  }
  return null;
}

/** Walk a tile-card's chain to the first Free ancestor and return
 *  its `microZone`-encoded (q, r). Mirrors
 *  `LayoutWorld.resolveTileCardHex`. */
function resolveTileCardHex(
  cardsLocal: Map<number, LocalCard>,
  row: LocalCard,
): { q: number; r: number } | null {
  let cur: LocalCard | undefined = row;
  for (let depth = 0; depth < 32 && cur !== undefined; depth++) {
    // A loose card carries its cell in `microLocation`; a member hops to its
    // root (one step in the flat model). Return the loose root's cell.
    if (!microIsCard(cur.flagsBk)) {
      const { localQ, localR } = microLooseCell(cur.microLocation);
      return { q: localQ, r: localR };
    }
    cur = cardsLocal.get(cur.microLocation);
  }
  return null;
}

/** Bindings array equality — same lengths, same card_ids in same
 *  positions. Compared cell-by-cell since the typical bindings
 *  array is small (~3 rows of ~3 cards) and Array.prototype.toString
 *  would mis-equate `[1,2]` and `[12]`. */
function bindingsEqual(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i];
    const rb = b[i];
    if (ra.length !== rb.length) return false;
    for (let j = 0; j < ra.length; j++) {
      if (ra[j] !== rb[j]) return false;
    }
  }
  return true;
}
