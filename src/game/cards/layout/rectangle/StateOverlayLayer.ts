// ════════════════════════════════════════════════════════════════════════
// LEGACY — non-generic render pipeline. DISABLED: no longer instantiated now
// that every card renders through the generic PrimList pipeline (LayoutGenericCard
// + the `^`-prim DSL builders). Kept for reference; MARKED FOR CLEANUP — delete
// once the generic pipeline is fully stable.
// ════════════════════════════════════════════════════════════════════════
import { Graphics } from "pixi.js";

export interface StateOverlayState {
  selected: boolean;
  hovered: boolean;
  pending: boolean;
}

/**
 * Rect-card hover / selected / pending decoration. Three independent
 * indicators on a single shared `Graphics`:
 *
 * - `selected` — solid 3px yellow stroke flush with the card edges.
 * - `hovered`  — 1px white stroke offset 2px outward, 50% alpha, so
 *                the cursor reads as "next to" without obscuring
 *                content.
 * - `pending`  — 3px-tall orange bar across the top edge, used by the
 *                action pipeline to signal "your propose is in flight".
 *
 * Stateless beyond its `Graphics` node — host calls `update(state,
 * cardWidth, cardHeight)` each layout pass with the current
 * `LayoutCard.state` and card dimensions.
 */
export class StateOverlayLayer {
  readonly graphics = new Graphics();

  update(state: StateOverlayState, cardWidth: number, cardHeight: number): void {
    this.graphics.clear();
    if (state.selected) {
      this.graphics
        .rect(0, 0, cardWidth, cardHeight)
        .stroke({ color: 0xffff00, width: 3 });
    }
    if (state.hovered) {
      this.graphics
        .rect(-2, -2, cardWidth + 4, cardHeight + 4)
        .stroke({ color: 0xffffff, width: 1, alpha: 0.5 });
    }
    if (state.pending) {
      this.graphics.rect(0, 0, cardWidth, 3).fill({ color: 0xff8800 });
    }
  }
}
