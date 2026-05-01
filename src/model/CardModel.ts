import { type CardId } from "@/spacetime/Data";

export type DeathState = 0 | 1 | 2;

/**
 * Per-card UI / lifecycle state, kept separate from `ClientCard` so that
 * `ClientCard` can stay strictly the decoded server row.
 *
 *   dragging  — picked up by DragController; views skip rendering at origin
 *   animating — DragOverlay tween in flight (drop tween or return tween)
 *   hidden    — view-suppressed (e.g. dragged-onto blocks the source view)
 *   dead      — death lifecycle: 0 alive · 1 dying (animation playing) · 2 ready to finalize
 *
 * Owners (writers):
 *   • DragController:    dragging, animating
 *   • DragOverlay:       animating (clears on tween completion)
 *   • DeathCoordinator:  dead
 *
 * Everyone else reads via the convenience accessors below.  Direct writes
 * outside the named coordinators are a smell — they almost certainly mean
 * the local state model is the wrong fit and a coordinator should own the
 * transition instead.
 */
export interface LocalCardState {
  dragging:  boolean;
  animating: boolean;
  hidden:    boolean;
  dead:      DeathState;
}

const DEFAULT_STATE: LocalCardState = {
  dragging: false, animating: false, hidden: false, dead: 0,
};

const _state = new Map<CardId, LocalCardState>();

// ─── Generic API ────────────────────────────────────────────────────────────

/** Returns the local state for a card, lazily creating it with defaults. */
export function getLocalState(cardId: CardId): LocalCardState {
  let s = _state.get(cardId);
  if (!s) { s = { ...DEFAULT_STATE }; _state.set(cardId, s); }
  return s;
}

/** Update one or more local fields atomically. */
export function setLocalState(cardId: CardId, partial: Partial<LocalCardState>): void {
  const s = getLocalState(cardId);
  Object.assign(s, partial);
}

/** Drop the entry — call from `removeClientCard` to keep the map bounded. */
export function dropLocalState(cardId: CardId): void {
  _state.delete(cardId);
}

/** Reset everything.  Called from bootstrap / reset paths. */
export function clearAllLocalState(): void {
  _state.clear();
  _orphanedRoots.clear();
}

// ─── Orphaned roots ─────────────────────────────────────────────────────────
// One-shot signal: a card just orphaned from a dying stack should render
// behind existing inventory stacks the next time Inventory adds it.  Set by
// the orphaning code path; consumed (set + cleared) by Inventory when it
// instantiates the new CardStack.

const _orphanedRoots = new Set<CardId>();

/** Mark `cardId` as freshly orphaned — Inventory will render it behind
 *  existing stacks on its next add. */
export function markOrphaned(cardId: CardId): void {
  _orphanedRoots.add(cardId);
}

/** Returns true and clears the flag if the card was marked orphaned.
 *  Returns false otherwise.  Single-use — the flag is consumed by the read. */
export function consumeOrphaned(cardId: CardId): boolean {
  if (!_orphanedRoots.has(cardId)) return false;
  _orphanedRoots.delete(cardId);
  return true;
}

// ─── Convenience read accessors ──────────────────────────────────────────────
// Defaults match a never-touched card, so callers can read without
// pre-checking.  `_state.get` rather than `getLocalState` so reads don't
// allocate a default entry as a side effect.

export function isDragging(cardId: CardId):  boolean { return _state.get(cardId)?.dragging  ?? false; }
export function isAnimating(cardId: CardId): boolean { return _state.get(cardId)?.animating ?? false; }
export function isHidden(cardId: CardId):    boolean { return _state.get(cardId)?.hidden    ?? false; }
export function deathState(cardId: CardId):  DeathState { return _state.get(cardId)?.dead   ?? 0; }

// ─── Convenience write accessors ─────────────────────────────────────────────

export function setDragging(cardId: CardId, v: boolean): void  { setLocalState(cardId, { dragging:  v }); }
export function setAnimating(cardId: CardId, v: boolean): void { setLocalState(cardId, { animating: v }); }
export function setHidden(cardId: CardId, v: boolean): void    { setLocalState(cardId, { hidden:    v }); }
export function setDeathState(cardId: CardId, v: DeathState): void { setLocalState(cardId, { dead:   v }); }
