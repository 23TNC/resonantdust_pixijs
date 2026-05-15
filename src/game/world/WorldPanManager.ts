import type { GameContext } from "../../GameContext";
import { WORLD_HEX_RADIUS } from "./hexSize";
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
 * 3/2 * r) * WORLD_HEX_RADIUS`. Inverting:
 *
 *   dr = (2/3) * dy / WORLD_HEX_RADIUS
 *   dq = dx / (WORLD_HEX_RADIUS * sqrt(3)) - dr / 2
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
/** Exponential-lerp factor for the viewport recenter tween. Same
 *  shape as `LayoutCard.tweenTo` — each frame moves
 *  `(target - current) * TWEEN_LERP` toward the goal, so the
 *  approach is fast at the start and softens as it lands. */
const TWEEN_LERP = 0.18;

/** Snap radius (in hex units) at which the tween treats itself as
 *  done and writes the final anchor exactly. Prevents the
 *  exponential approach from infinite-asymptoting near the goal. */
const TWEEN_SNAP_HEX = 0.01;

export class WorldPanManager {
  private active = false;
  private startPointerX = 0;
  private startPointerY = 0;
  private startViewQ = 0;
  private startViewR = 0;

  /** Active recenter tween, or `null` when idle. Cancelled
   *  immediately on any new pan-drag start so the player can grab
   *  the world to redirect even mid-snap. */
  private tween: { targetQ: number; targetR: number } | null = null;

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
      // Drag wins over an in-flight recenter tween — the player's
      // active grab takes precedence over the snap-back animation.
      this.tween = null;
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

  /** Kick off a smooth recenter to world hex `(q, r)`. Replaces any
   *  in-flight tween. Cancels itself if a pan-drag starts mid-snap
   *  (`active = true` short-circuits the tween branch in `update`).
   *
   *  Call site: `GameScene`'s Space-key handler, which resolves the
   *  soul's current hex from `ctx.souls.getSoul()` and passes it
   *  here. */
  tweenTo(q: number, r: number): void {
    this.tween = { targetQ: q, targetR: r };
  }

  /** Called once per frame by `GameScene.update`. Three branches:
   *   - Active pan drag → read pointer, push fresh anchor.
   *   - Active recenter tween → exponential-lerp the anchor toward
   *     the tween target, snapping when within `TWEEN_SNAP_HEX`.
   *   - Idle → no-op.
   *  Pan wins over tween: any new drag clears the tween (see the
   *  drag-start listener). */
  update(): void {
    if (this.active) {
      const input = this.ctx.input;
      if (!input) return;
      const dx = input.lastPointer.x - this.startPointerX;
      const dy = input.lastPointer.y - this.startPointerY;
      const dr = (2 / 3) * dy / WORLD_HEX_RADIUS;
      const dq = dx / (WORLD_HEX_RADIUS * Math.sqrt(3)) - dr / 2;
      // Subtract: the world moves with the cursor, so the viewport
      // anchor (which stays fixed under the cursor's start point)
      // shifts opposite to the cursor's pixel drag.
      this.ctx.zones.setAnchor(
        "viewport",
        this.startViewQ - dq,
        this.startViewR - dr,
      );
      return;
    }
    if (this.tween !== null) {
      const anchor = this.ctx.zones.viewportAnchor;
      const dq = this.tween.targetQ - anchor.q;
      const dr = this.tween.targetR - anchor.r;
      if (Math.hypot(dq, dr) < TWEEN_SNAP_HEX) {
        // Snap to the exact target and end the tween. Without the
        // snap the exponential lerp would asymptote forever.
        this.ctx.zones.setAnchor("viewport", this.tween.targetQ, this.tween.targetR);
        this.tween = null;
        return;
      }
      this.ctx.zones.setAnchor(
        "viewport",
        anchor.q + dq * TWEEN_LERP,
        anchor.r + dr * TWEEN_LERP,
      );
    }
  }

  dispose(): void {
    this.unsubDragStart();
    this.unsubDragStop();
    this.active = false;
  }
}
