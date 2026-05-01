import {
  client_cards,
  stacked_up_children,
  stacked_down_children,
  moveClientCard,
  stackClientCardUp,
  stackClientCardDown,
  type CardId,
  type MacroZone,
  type MicroZone,
  type MicroLocation,
} from "@/spacetime/Data";
import { deathState, isAnimating, isDragging } from "@/model/CardModel";
import { isBottomTitleByDef } from "@/definitions/CardDefinitions";

const MAX_STACK_DEPTH = 64;

/**
 * Hard cap on chain length per branch — the participants u8 on Action
 * encodes 4 bits per direction, so the matcher can't claim past index 15.
 * Reject attach calls that would push the chain to this depth or beyond.
 */
const MAX_BRANCH_LENGTH = 15;

export type StackDirection = "up" | "down";

export interface ChainWalkOptions {
  /** Treat dragging/animating cards as breaking the chain. Default: false. */
  excludeDragState?: boolean;
  /** Treat dying (dead===1) cards as breaking the chain. Default: false. */
  excludeDying?:     boolean;
  /** Maximum chain length. Default: 64. */
  maxDepth?:         number;
}

/**
 * Typed handle over the stack rooted at `rootId`.
 *
 * All chain walks and attach / detach mutations route through this class so
 * the rest of the codebase stays out of the `stacked_*_children` indexes and
 * the `stackClientCard*` helpers.
 *
 * `rootId === 0` is a valid sentinel — every chain method returns an empty
 * array and every `has*` predicate returns false.
 *
 * Walk semantics:
 *   - `upChain` / `downChain`  — single-walker, follows the first child per
 *     hop.  Matches the rendering/walker semantics in CardStack.
 *   - `collectBranch`          — BFS, includes every descendant in one
 *     direction (handles branching index entries).  Matches the historical
 *     `collectUpChain` / `collectDownChain` helpers.
 *   - `participants`           — BFS over both directions, including root.
 */
export class Stack {
  constructor(public readonly rootId: CardId) {}

  // ─── Chain reads ─────────────────────────────────────────────────────────

  /** Single-walker walk of the up branch from rootId.  Excludes rootId. */
  upChain(opts?: ChainWalkOptions): CardId[] {
    return this._walk(stacked_up_children, opts);
  }

  /** Single-walker walk of the down branch from rootId.  Excludes rootId. */
  downChain(opts?: ChainWalkOptions): CardId[] {
    return this._walk(stacked_down_children, opts);
  }

  /**
   * BFS walk of one direction starting at rootId.  Includes rootId.
   * Mirrors the historical `collectUpChain`/`collectDownChain` shape used
   * by recipe-activation sync.
   */
  collectBranch(direction: StackDirection): CardId[] {
    if (this.rootId === 0) return [];
    const index = direction === "up" ? stacked_up_children : stacked_down_children;
    const ids: CardId[] = [];
    const seen = new Set<CardId>();
    const queue: CardId[] = [this.rootId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      ids.push(current);
      const children = index.get(current);
      if (children) for (const child of children) queue.push(child);
    }
    return ids;
  }

  /** [rootId, ...all descendants] via BFS over both indexes. */
  participants(): CardId[] {
    if (this.rootId === 0) return [];
    const ids: CardId[] = [];
    const seen = new Set<CardId>();
    const queue: CardId[] = [this.rootId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      ids.push(current);
      const up = stacked_up_children.get(current);
      if (up) for (const child of up) queue.push(child);
      const down = stacked_down_children.get(current);
      if (down) for (const child of down) queue.push(child);
    }
    return ids;
  }

  /** Last card on the up branch — ignores drag state and dying cards. */
  upLeaf(): CardId {
    return Stack._walkToLeaf(this.rootId, stacked_up_children);
  }

  /** Last card on the down branch — ignores drag state and dying cards. */
  downLeaf(): CardId {
    return Stack._walkToLeaf(this.rootId, stacked_down_children);
  }

  hasUpChildren(): boolean {
    return (stacked_up_children.get(this.rootId)?.size ?? 0) > 0;
  }

  hasDownChildren(): boolean {
    return (stacked_down_children.get(this.rootId)?.size ?? 0) > 0;
  }

  /** Direct children stacked on rootId in the given direction (snapshot). */
  directChildren(direction: StackDirection): CardId[] {
    const idx = direction === "up" ? stacked_up_children : stacked_down_children;
    const set = idx.get(this.rootId);
    return set ? [...set] : [];
  }

  /**
   * Walk the down branch through consecutive cards whose *definition* is
   * top-title.  Returns [rootId, child, ...] — stops just before any card
   * whose definition is bottom-title.  Used by inventory-drop logic to pick
   * the new root for a top-title source stack.
   */
  naturalTopChain(): CardId[] {
    if (this.rootId === 0) return [];
    const chain: CardId[] = [this.rootId];
    const seen  = new Set<CardId>([this.rootId]);
    let current = this.rootId;
    while (true) {
      const children = stacked_down_children.get(current);
      if (!children || children.size === 0) break;
      const next = children.values().next().value!;
      if (seen.has(next)) break;
      if (!client_cards[next]) break;
      if (isBottomTitleByDef(next)) break;
      seen.add(next);
      chain.push(next);
      current = next;
    }
    return chain;
  }

  // ─── Mutations ───────────────────────────────────────────────────────────

  /**
   * Walk every descendant on the OPPOSITE branch and re-stack it onto its
   * existing parent in `direction`.  Without this, a pre-existing chain on
   * one branch is orphaned when the root moves to the other branch.
   *
   * Children are snapshotted per parent so iteration doesn't observe its
   * own mutations.
   */
  flipDescendants(direction: StackDirection): void {
    const oppositeIndex = direction === "down" ? stacked_up_children : stacked_down_children;
    const flipFn        = direction === "down" ? stackClientCardDown : stackClientCardUp;

    const queue: CardId[] = [this.rootId];
    const seen  = new Set<CardId>([this.rootId]);

    while (queue.length > 0) {
      const current  = queue.shift()!;
      const children = oppositeIndex.get(current);
      if (!children || children.size === 0) continue;
      for (const childId of [...children]) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        flipFn(childId, current);
        queue.push(childId);
      }
    }
  }

  // ─── Static lookups ──────────────────────────────────────────────────────

  /** Walk stacked_on_id upward from cardId; return the unstacked root, or 0 on cycle/missing. */
  static findRoot(cardId: CardId): CardId {
    const seen = new Set<CardId>();
    let current = cardId;
    while (current !== 0) {
      if (seen.has(current)) return 0;
      seen.add(current);
      const c = client_cards[current];
      if (!c) return 0;
      if (c.stacked_on_id === 0) return current;
      current = c.stacked_on_id;
    }
    return 0;
  }

  // ─── Static mutations ────────────────────────────────────────────────────
  // Convenience wrappers around the Data.ts helpers.  Kept static because
  // attaching / detaching is rarely scoped to a particular stack instance —
  // callers usually have raw card ids.

  /**
   * Attach `childId` onto `ontoId`'s up branch.  Rejects if the resulting
   * chain length would exceed `MAX_BRANCH_LENGTH` — the adjacency encoding
   * (u4 per direction in `Action.participants`) cannot represent positions
   * past index 15.
   */
  static attachUp(childId: CardId, ontoId: CardId): boolean {
    const root = Stack.findRoot(ontoId);
    if (root !== 0) {
      const branchLen = new Stack(root).collectBranch("up").length;
      // collectBranch returns [root, ...descendants]; the +1 we'd add via
      // attaching would push descendants count to (length).  Reject when
      // descendants would exceed MAX_BRANCH_LENGTH.
      if (branchLen >= MAX_BRANCH_LENGTH + 1) return false;
    }
    stackClientCardUp(childId, ontoId);
    return true;
  }

  /** Attach `childId` onto `ontoId`'s down branch.  Same length cap as `attachUp`. */
  static attachDown(childId: CardId, ontoId: CardId): boolean {
    const root = Stack.findRoot(ontoId);
    if (root !== 0) {
      const branchLen = new Stack(root).collectBranch("down").length;
      if (branchLen >= MAX_BRANCH_LENGTH + 1) return false;
    }
    stackClientCardDown(childId, ontoId);
    return true;
  }

  /** Move a card to a free location (panel pixel or world hex), clearing stacked flags. */
  static detach(
    cardId:         CardId,
    layer:          number,
    macro_zone:     MacroZone,
    micro_zone:     MicroZone,
    micro_location: MicroLocation,
  ): void {
    moveClientCard(cardId, layer, macro_zone, micro_zone, micro_location);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _walk(
    index: Map<CardId, Set<CardId>>,
    opts?: ChainWalkOptions,
  ): CardId[] {
    if (this.rootId === 0) return [];
    const max = opts?.maxDepth ?? MAX_STACK_DEPTH;
    const chain: CardId[] = [];
    const seen  = new Set<CardId>([this.rootId]);
    let current = this.rootId;

    while (chain.length < max) {
      const children = index.get(current);
      if (!children || children.size === 0) break;
      const next = children.values().next().value!;
      if (seen.has(next)) break;
      if (!Stack._accept(next, opts)) break;
      seen.add(next);
      chain.push(next);
      current = next;
    }
    return chain;
  }

  private static _accept(cardId: CardId, opts?: ChainWalkOptions): boolean {
    if (!client_cards[cardId]) return false;
    const dead = deathState(cardId);
    if (dead >= 2) return false;                                       // always exclude finalized
    if (opts?.excludeDying     && dead >= 1) return false;
    if (opts?.excludeDragState && (isDragging(cardId) || isAnimating(cardId))) return false;
    return true;
  }

  private static _walkToLeaf(rootId: CardId, index: Map<CardId, Set<CardId>>): CardId {
    if (rootId === 0) return 0;
    const seen = new Set<CardId>([rootId]);
    let current = rootId;
    let steps   = 0;
    while (steps < MAX_STACK_DEPTH) {
      const children = index.get(current);
      if (!children || children.size === 0) break;
      const next = children.values().next().value!;
      if (seen.has(next)) break;
      seen.add(next);
      current = next;
      steps++;
    }
    return current;
  }
}
