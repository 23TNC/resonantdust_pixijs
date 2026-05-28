import type { GameContext } from "../../GameContext";
import { WORLD_LAYER } from "../../server/data/packing";
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

  /** ZoneManager anchor name this pan controller drives. Singleton
   *  callers pass `"viewport"`; per-panel callers pass
   *  `"viewport:<panelId>"`. */
  readonly viewportAnchorName: string;

  /** Surface the anchor is pinned to. World viewports start at
   *  `WORLD_LAYER` (the default); non-world viewports pass their own
   *  surface. Threaded into every `setAnchor` call so the anchor's
   *  surface stays stable across drag frames — defaulting
   *  `setAnchor`'s `surface` arg would clobber a non-world anchor's
   *  surface back to world on the next pan tick.
   *
   *  Mutable via [`setSurface`] so a panel can be re-pointed at a
   *  different surface (`GameViewPanel.focusAt` calls both
   *  `LayoutWorld.setSurface` and `WorldPanManager.setSurface` so
   *  the next pan frame doesn't reset the just-changed surface). */
  surface: number;

  constructor(
    private readonly ctx: GameContext,
    private readonly worldView: LayoutWorld,
    viewportAnchorName: string = "viewport",
    surface: number = WORLD_LAYER,
  ) {
    this.viewportAnchorName = viewportAnchorName;
    this.surface = surface;
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
      // No viewport anchor set → can't compute a pan delta. Happens
      // briefly between scene-enter and the soul-row-arrived setAnchor;
      // ignoring the drag is fine, the user can try again once the
      // world has positioned itself.
      const anchor = ctx.zones.getAnchor(this.viewportAnchorName);
      if (!anchor) return;
      this.active = true;
      // Drag wins over an in-flight recenter tween — the player's
      // active grab takes precedence over the snap-back animation.
      this.tween = null;
      this.startPointerX = data.x;
      this.startPointerY = data.y;
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
   *  Call sites: `GameScene`'s Space-key handler (re-center after
   *  pan) and the initial scene-enter soul-pan (first frame of the
   *  game scene). When no viewport anchor has been set yet — typical
   *  on the very first call after entering the scene — there's
   *  nothing to lerp *from*, so we set the anchor directly instead
   *  of queuing a tween. The next call (after the user has panned
   *  or pressed Space again) will have an anchor and tween smoothly. */
  tweenTo(q: number, r: number): void {
    if (!this.ctx.zones.getAnchor(this.viewportAnchorName)) {
      this.ctx.zones.setAnchor(this.viewportAnchorName, q, r, this.surface);
      return;
    }
    this.tween = { targetQ: q, targetR: r };
  }

  /** Re-point this pan controller's anchor at a different
   *  `surface`. No state churn beyond the field write — every
   *  subsequent `setAnchor` call uses the new surface, so the next
   *  drag / tween tick re-anchors on the new layer. Pair with
   *  [`LayoutWorld.setSurface`] so the view re-registers its
   *  worldCardSurface + re-hydrates tiles for the new layer too;
   *  `GameViewPanel.focusAt` packages both. */
  setSurface(surface: number): void {
    this.surface = surface;
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
        this.viewportAnchorName,
        this.startViewQ - dq,
        this.startViewR - dr,
        this.surface,
      );
      return;
    }
    if (this.tween !== null) {
      const anchor = this.ctx.zones.getAnchor(this.viewportAnchorName) ?? null;
      // Belt-and-suspenders: `tweenTo` short-circuits to a direct
      // setAnchor when no anchor is set, so this branch should
      // only run with a live anchor. Bail safely if something
      // cleared the anchor mid-tween (no current call path does
      // this, but the cost is one null-check).
      if (anchor === null) {
        this.tween = null;
        return;
      }
      const dq = this.tween.targetQ - anchor.q;
      const dr = this.tween.targetR - anchor.r;
      if (Math.hypot(dq, dr) < TWEEN_SNAP_HEX) {
        // Snap to the exact target and end the tween. Without the
        // snap the exponential lerp would asymptote forever.
        this.ctx.zones.setAnchor(
          this.viewportAnchorName,
          this.tween.targetQ,
          this.tween.targetR,
          this.surface,
        );
        this.tween = null;
        return;
      }
      this.ctx.zones.setAnchor(
        this.viewportAnchorName,
        anchor.q + dq * TWEEN_LERP,
        anchor.r + dr * TWEEN_LERP,
        this.surface,
      );
    }
  }

  dispose(): void {
    this.unsubDragStart();
    this.unsubDragStop();
    this.active = false;
  }
}
