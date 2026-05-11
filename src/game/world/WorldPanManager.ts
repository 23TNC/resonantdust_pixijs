import type { GameContext } from "../../GameContext";
import { HEX_RADIUS } from "../cards/layout/hexagon/HexVisual";
import { LayoutWorld } from "./LayoutWorld";

/**
 * Drag-to-pan controller for the world view.
 *
 * Subscribes to `InputManager.left_drag_start` / `left_drag_stop`. When a
 * drag begins with the hit-test landing on `LayoutWorld` itself — i.e.
 * empty world space, not a card mounted on the world — pan mode
 * activates: every subsequent `update()` tick reads the current
 * pointer position, computes the pixel delta from the gesture start,
 * converts that to a hex (q, r) delta, and pushes a fresh viewport
 * anchor into `ZoneManager.setAnchor("viewport", ...)`.
 *
 * The anchor change fans out through `ZoneManager.onAnchorChange`:
 * - `LayoutWorld` updates its `(viewQ, viewR)` and re-renders tiles.
 * - `ZoneManager.recomputeWorldZones()` re-walks the surrounding
 *   `anchorRadius` ring and adds / removes zones from the "active"
 *   tier accordingly, which `main.ts` translates into
 *   `subscribeWorldZone` / `unsubscribeWorldZone` SDK calls.
 *
 * Pan math: pointy-top hex to pixel is `(sqrt(3) * q + sqrt(3)/2 * r,
 * 3/2 * r) * HEX_RADIUS`. Inverting:
 *
 *   dr = (2/3) * dy / HEX_RADIUS
 *   dq = dx / (HEX_RADIUS * sqrt(3)) - dr / 2
 *
 * The pan moves the viewport in the opposite direction of the cursor
 * drag (grab-and-drag feel) — so `newAnchor = startAnchor - hexDelta`.
 *
 * The `LayoutWorld`-as-hit check naturally excludes card drags: cards
 * are children of `worldCardSurface` whose `hitTestLayout` returns
 * the actual card LayoutNode for a hit on the card body, falling
 * through to `LayoutWorld` only for empty space. `DragManager` and
 * `WorldPanManager` are mutually exclusive for the same gesture.
 */
export class WorldPanManager {
  private active = false;
  private startPointerX = 0;
  private startPointerY = 0;
  private startViewQ = 0;
  private startViewR = 0;

  private readonly unsubDragStart: () => void;
  private readonly unsubDragStop: () => void;

  constructor(
    private readonly ctx: GameContext,
    private readonly worldView: LayoutWorld,
  ) {
    if (!ctx.input) {
      throw new Error("[WorldPanManager] ctx.input is null — InputManager must exist");
    }
    const input = ctx.input;

    this.unsubDragStart = input.on("left_drag_start", (data) => {
      // Pan only when the gesture started on empty world space.
      // `worldCardSurface.hitTestLayout` returns null for empty area,
      // which lets `LayoutNode.hitTestLayout` walk back up and return
      // the surface's own parent — `LayoutWorld` — as the hit. A drag
      // started on a card returns the card's LayoutNode, not
      // LayoutWorld, so this branch correctly stays out of DragManager's
      // way.
      if (data.hit !== this.worldView) return;
      this.active = true;
      this.startPointerX = data.x;
      this.startPointerY = data.y;
      const anchor = ctx.zones.viewportAnchor;
      this.startViewQ = anchor.q;
      this.startViewR = anchor.r;
    });

    this.unsubDragStop = input.on("left_drag_stop", () => {
      // Always clear — even if drag_stop fires for a non-pan drag
      // (card drop, etc.) we want to reset state. Cheaper than
      // tracking whether this exact stop matches our own start.
      this.active = false;
    });
  }

  /** Called once per frame by `GameScene.update`. No-op when not
   *  panning; otherwise reads `input.lastPointer` and pushes a fresh
   *  viewport anchor. */
  update(): void {
    if (!this.active) return;
    const input = this.ctx.input;
    if (!input) return;
    const dx = input.lastPointer.x - this.startPointerX;
    const dy = input.lastPointer.y - this.startPointerY;
    const dr = (2 / 3) * dy / HEX_RADIUS;
    const dq = dx / (HEX_RADIUS * Math.sqrt(3)) - dr / 2;
    // Subtract: the world moves with the cursor, so the viewport
    // anchor (which stays fixed under the cursor's start point)
    // shifts opposite to the cursor's pixel drag.
    this.ctx.zones.setAnchor(
      "viewport",
      this.startViewQ - dq,
      this.startViewR - dr,
    );
  }

  dispose(): void {
    this.unsubDragStart();
    this.unsubDragStop();
    this.active = false;
  }
}
