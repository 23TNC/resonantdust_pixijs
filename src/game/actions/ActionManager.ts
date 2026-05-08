import { debug } from "../../debug";
import type { GameContext } from "../../GameContext";
import type { Card } from "../cards/Card";
import {
  getStackedState,
  STACKED_LOOSE,
  STACKED_ON_HEX,
} from "../cards/cardData";

/** Bound on chain walks — defensive against pointer cycles or pathological
 *  stacks. Mirrors `FIND_ROOT_MAX_DEPTH` in CardManager. */
const CHAIN_MAX_DEPTH = 64;

/** Default fire-after-match delay. Matches stay queued for this long
 *  before being submitted to the server, giving the player a window to
 *  break the chain (drag a card off, etc.) and abort. */
const DEFAULT_DELAY_MS = 5000;

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

/** A recipe match the client has detected on a chain segment. The queue
 *  is keyed on `(subRootId, direction)`. A "sub-root" is the first
 *  non-held card of a segment — either the loose root itself, or the
 *  first card after a `slot_hold` block in the larger chain. The
 *  matcher's actor-sliding handles intra-segment shifting so we only
 *  enqueue one entry per segment per direction.
 *
 *  Sub-roots that aren't the loose root carry `hexParentId = 0` /
 *  `hasHex = false` since they aren't anchored to a hex. */
export interface QueuedAction {
  /** First card of the matched segment (`chain[0]`). */
  subRootId: number;
  /** Loose root of the larger chain this segment belongs to. Used by
   *  `evaluateRoot` to scope cluster-pruning to its own loose root. */
  looseRootId: number;
  /** Which side of `subRootId` the segment extends. */
  direction: StackDirection;
  /** Stable packed recipe id (`u16`). */
  recipeIndex: number;
  /** Card ids in segment order: `[subRoot, slot0, slot1, …]`. The slot
   *  window the recipe matched is `[slotStart, slotStart + slotCount)`. */
  chain: readonly number[];
  /** `card_id` of the hex card the loose root is stacked on, or `0` if
   *  the segment isn't anchored on a hex (which is the case for any
   *  sub-root past a held block, plus loose roots not on a hex). */
  hexParentId: number;
  /** Start index of the matched slot window within `chain`. */
  slotStart: number;
  /** Number of cards in the matched slot window. */
  slotCount: number;
  /** Whether the recipe pins a `root` definition. */
  hasRoot: boolean;
  /** Whether the recipe pins a `hex` definition. */
  hasHex: boolean;
  /** True between `proposeAction` dispatch and its round-trip
   *  resolution. While submitted, `evaluateRoot` and the
   *  cluster-pruning paths leave the entry alone — the user has
   *  committed to the action and the client may not cancel or
   *  upgrade it. The `.then` / `.catch` handlers clean up. */
  submitted: boolean;
}

/**
 * Scene-scoped recipe pre-filter and submission queue.
 *
 * Listens to stack-change events from `CardManager`. For each affected
 * loose root, walks the chain in both stack directions, partitions on
 * `slot_hold` cards (which are part of an in-flight or accepted recipe
 * and must not participate in further matching), and asks the wasm
 * `matchStackRecipe` whether each non-held segment matches a recipe.
 *
 * - **New / updated match**: a queue entry is added or replaced under
 *   `(subRootId, direction)` and a fire timer is (re)started.
 * - **No match**: any prior entry under that key is cleared and its
 *   timer cancelled — a stack that *was* matching but no longer does
 *   drops off the queue, so we never submit a stale recipe.
 * - **Submitted entries are locked**: once `proposeAction` has been
 *   dispatched, the queue entry is marked `submitted` and is no
 *   longer touched by `evaluateRoot` or cluster-pruning. The promise's
 *   `then` / `catch` handlers remove the entry on round-trip
 *   resolution.
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

  /** Number of queued actions across all sub-roots and directions. */
  pendingCount(): number {
    return this.queue.size;
  }

  /** Re-evaluate the chain anchored at `looseRootId`.
   *
   *  Algorithm:
   *  - The loose root is *the* root. It evaluates in BOTH directions —
   *    its top stack (cards above, walked bounded by held) is matched
   *    against `Stack(Up)` recipes; its bottom stack is matched against
   *    `Stack(Down)` recipes. Each direction is one matcher call: rooted
   *    *and* root-as-slot recipes are evaluated together inside the
   *    matcher via actor-sliding (see `recipe_core::match_stack_recipe`).
   *    Up recipes are NEVER matched against the bottom stack and vice
   *    versa.
   *  - Sub-roots past held blocks: the first non-held card on the far
   *    side of a held block is a sub-root, but only in the direction
   *    extending *away* from the block. A card whose neighbour
   *    immediately below is held is an "up" sub-root only; one whose
   *    neighbour immediately above is held is a "down" sub-root only.
   *    This keeps the same physical segment from being evaluated as
   *    both an up-chain AND a mirror down-chain (which is what was
   *    producing duplicate corpus_up + corpus_down hits previously).
   *  - The loose root, if held, contributes no matches; its cluster's
   *    sub-roots past held blocks are still evaluated. */
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

    const wanted = new Map<string, QueuedAction>();

    // Loose root — both directions (only this card walks both ways).
    if (!this.isHeld(looseRootId)) {
      const hexParentId =
        getStackedState(rootRow.microZone) === STACKED_ON_HEX
          ? rootRow.microLocation
          : 0;
      const hexDef =
        hexParentId !== 0
          ? this.ctx.data.cardsLocal.get(hexParentId)?.packedDefinition ?? 0
          : 0;
      this.matchAtRoot({
        rootCard: looseRoot,
        rootDef: rootRow.packedDefinition,
        hexDef,
        hexParentId,
        directions: ["up", "down"] as const,
        looseRootId,
        wanted,
      });
    }

    // Held-block sub-roots — only the direction extending away from
    // the held block. Walk up from the loose root looking for held →
    // non-held transitions: each transition's non-held card is an
    // up-only sub-root. Symmetrically walking down yields down-only
    // sub-roots.
    this.findHeldBlockSubRoots(looseRoot, looseRootId, "up", wanted);
    this.findHeldBlockSubRoots(looseRoot, looseRootId, "down", wanted);

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
          `[ActionManager] queue ${existing ? "update" : "add"}: subRoot=${action.subRootId} dir=${action.direction} recipe=${action.recipeIndex} chain=[${action.chain.join(",")}] window=[${action.slotStart},${action.slotStart + action.slotCount})${action.hexParentId ? ` hex=${action.hexParentId}` : ""}`,
          2,
        );
      }
    }
  }

  /** For each `direction`, walk a stack from `rootCard` bounded by held
   *  cards, run the matcher on the resulting slot list, and populate
   *  `wanted` with any match. The chain handed to the matcher is
   *  `[rootCard, ...slots]` — actor sliding inside the matcher decides
   *  whether the recipe's `root` binds to `rootCard` (rooted recipe) or
   *  whether `rootCard` itself fills `slots[0]` (rootless recipe). */
  private matchAtRoot(args: {
    rootCard: Card;
    rootDef: number;
    hexDef: number;
    hexParentId: number;
    directions: readonly StackDirection[];
    looseRootId: number;
    wanted: Map<string, QueuedAction>;
  }): void {
    const { rootCard, rootDef, hexDef, hexParentId, directions, looseRootId, wanted } = args;
    for (const direction of directions) {
      const stack = this.walkBoundedByHeld(rootCard, direction);
      if (stack.length === 0) continue;
      const slotDefs = stack.map((c) => {
        return this.ctx.data.cardsLocal.get(c.cardId)?.packedDefinition ?? 0;
      });
      const match = this.ctx.definitions.matchStackRecipe(
        hexDef,
        rootDef,
        slotDefs,
        direction,
      );
      if (match === null) continue;
      wanted.set(this.queueKey(rootCard.cardId, direction), {
        subRootId: rootCard.cardId,
        looseRootId,
        direction,
        recipeIndex: match.recipeIndex,
        chain: [rootCard.cardId, ...stack.map((c) => c.cardId)],
        hexParentId,
        slotStart: match.slotStart,
        slotCount: match.slotCount,
        hasRoot: match.hasRoot,
        hasHex: match.hasHex,
        submitted: false,
      });
    }
  }

  /** Walk from `from` in `walkDir` looking for held → non-held
   *  transitions. Each non-held card immediately past a held block is
   *  a sub-root, evaluated *only* in `walkDir` (so an up-walk only
   *  produces up sub-roots, and they only match up recipes against
   *  their top stack). Sub-roots are not on hexes, so `hexDef` and
   *  `hexParentId` are zero. */
  private findHeldBlockSubRoots(
    from: Card,
    looseRootId: number,
    walkDir: StackDirection,
    wanted: Map<string, QueuedAction>,
  ): void {
    const cards = this.ctx.cards;
    if (!cards) return;
    let current = from;
    let lastWasHeld = this.isHeld(from.cardId);
    for (let i = 0; i < CHAIN_MAX_DEPTH; i++) {
      const nextId = walkDir === "up" ? current.stackedTop : current.stackedBottom;
      if (nextId === 0) return;
      const next = cards.get(nextId);
      if (!next) return;
      const nextHeld = this.isHeld(next.cardId);
      if (!nextHeld && lastWasHeld) {
        const subRow = this.ctx.data.cardsLocal.get(next.cardId);
        if (subRow) {
          this.matchAtRoot({
            rootCard: next,
            rootDef: subRow.packedDefinition,
            hexDef: 0,
            hexParentId: 0,
            directions: [walkDir],
            looseRootId,
            wanted,
          });
        }
      }
      lastWasHeld = nextHeld;
      current = next;
    }
  }

  /** Walk in `direction` from `start` along `stackedTop` / `stackedBottom`
   *  pointers, stopping at the first held card (which is excluded from
   *  the result) or end-of-chain. Returns the slots above (up) or below
   *  (down) `start`, NOT including `start` itself. Bounded by
   *  `CHAIN_MAX_DEPTH` against pointer cycles. */
  private walkBoundedByHeld(start: Card, direction: StackDirection): Card[] {
    const cards = this.ctx.cards;
    if (!cards) return [];
    const chain: Card[] = [];
    let current = start;
    for (let i = 0; i < CHAIN_MAX_DEPTH; i++) {
      const nextId = direction === "up" ? current.stackedTop : current.stackedBottom;
      if (nextId === 0) break;
      const next = cards.get(nextId);
      if (!next) break;
      if (this.isHeld(next.cardId)) break;
      chain.push(next);
      current = next;
    }
    return chain;
  }

  /** Whether `cardId`'s row carries the `slot_hold` flag — i.e. it's a
   *  slot in an in-flight or accepted recipe and must not participate
   *  in further matching. False if the row is missing or the flag bit
   *  is undefined in the registry (in which case nothing is ever held,
   *  matching the current pre-flag-system behavior). */
  private isHeld(cardId: number): boolean {
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

  /** Drop every queue entry that names `cardId` as either its sub-root
   *  or its cluster's loose root — used when the card itself is removed
   *  from `cardsLocal`. Submitted entries are dropped too: with the card
   *  gone there's nothing to clean up against, and the server side has
   *  already resolved one way or another. */
  private dropForCard(cardId: number): void {
    const toDelete: string[] = [];
    for (const [key, entry] of this.queue) {
      if (entry.subRootId === cardId || entry.looseRootId === cardId) {
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
   *  than fire on the original schedule. */
  private scheduleTimer(key: string): void {
    this.cancelTimer(key);
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

    const subRootRow = this.ctx.data.cardsLocal.get(action.subRootId);
    if (!subRootRow) {
      debug.log(
        ["actions"],
        `[ActionManager] fire abort: subRoot=${action.subRootId} dir=${action.direction} (sub-root row gone)`,
        2,
      );
      this.queue.delete(key);
      return;
    }

    const slots = action.chain.slice(
      action.slotStart,
      action.slotStart + action.slotCount,
    );
    const hex = action.hasHex ? action.hexParentId : 0;
    const root = action.hasRoot ? action.subRootId : 0;

    const submittedEntry: QueuedAction = { ...action, submitted: true };
    this.queue.set(key, submittedEntry);

    debug.log(
      ["actions"],
      `[ActionManager] attempting action: recipe=${action.recipeIndex} root=${root} hex=${hex} slots=[${slots.join(",")}] dir=${action.direction}`,
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
        surface: subRootRow.surface,
        macroZone: subRootRow.macroZone,
        microZone: subRootRow.microZone,
        microLocation: subRootRow.microLocation,
        recipeId: action.recipeIndex,
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

  private queueKey(subRootId: number, direction: StackDirection): string {
    return `${subRootId}:${direction}`;
  }
}

function queueActionDiffers(a: QueuedAction, b: QueuedAction): boolean {
  return (
    a.recipeIndex !== b.recipeIndex ||
    a.slotStart !== b.slotStart ||
    a.slotCount !== b.slotCount ||
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
