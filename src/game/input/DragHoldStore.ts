/** Client-side sidecar tracking "I'm currently mid-drag on this card."
 *
 *  Same pattern as `ActionManager`'s prediction store: per-card state
 *  that's purely client-local (the server has no concept of drags) and
 *  shouldn't leak into `Card.flags` / `Card.flags`. The drop
 *  resolver consults this in addition to the server's
 *  `drop_hold_count > 0` so a card mid-drag rejects incoming local
 *  drops without round-tripping to the server.
 *
 *  Lifecycle: `mark(cardId)` on drag start, `clear(cardId)` on drag
 *  end (commit, cancel, snap-back — any path that leaves the drag
 *  state). `clearAll()` on scene teardown.
 *
 *  Listener re-fire: callers that need consumers (RectCard's drop
 *  preview overlay, future visual indicators) to re-evaluate when the
 *  mark/clear lands should pass a `notify` callback that re-fires the
 *  card's local subscribers. The pattern mirrors `ActionManager`'s
 *  `setLocalCard(id, {...row})` re-trigger. */

import type { GameContext } from "../../GameContext";

export class DragHoldStore {
  private readonly held = new Set<number>();

  /** True if `cardId` is currently being dragged locally. */
  has(cardId: number): boolean {
    return this.held.has(cardId);
  }

  /** Mark `cardId` as drag-held. Re-fires the card's local subscribers
   *  so consumers (drop-preview overlays, target gates) re-evaluate. */
  mark(cardId: number, ctx: GameContext): void {
    if (this.held.has(cardId)) return;
    this.held.add(cardId);
    this.notify(cardId, ctx);
  }

  /** Clear the drag-hold for `cardId`. No-op if not held. Re-fires
   *  subscribers on actual transition. */
  clear(cardId: number, ctx: GameContext): void {
    if (!this.held.delete(cardId)) return;
    this.notify(cardId, ctx);
  }

  /** Drop every entry — scene teardown, login flip, etc. */
  clearAll(): void {
    this.held.clear();
  }

  /** Re-fire the card's local subscribers so consumers re-consult
   *  the merged drop-blocked state via `isStackTargetBlocked`. The
   *  card's flag values are unchanged — the drag-hold lives only
   *  in this set — so a shallow clone forces `setLocalCard` to
   *  treat it as an update (it compares by reference). */
  private notify(cardId: number, ctx: GameContext): void {
    const row = ctx.data.cardsLocal.get(cardId);
    if (!row) return;
    ctx.data.setLocalCard(cardId, { ...row });
  }
}
