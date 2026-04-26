import { Container, Graphics } from "pixi.js";
import { LayoutObject, type LayoutObjectOptions } from "./LayoutObject";

export interface LayoutViewportOptions extends LayoutObjectOptions {
  cameraX?: number;
  cameraY?: number;
}

/**
 * A LayoutObject that renders its layout children in a scrollable world
 * coordinate space, clipping everything outside its inner rect.
 *
 * Children added via addLayoutChild() are positioned in world space — their
 * setLayout() x/y values are world coordinates.  The camera defines which
 * world-space origin maps to the top-left corner of the inner rect:
 *
 *   screen_pos = world_pos - camera + innerRect.origin
 *
 * Camera changes only invalidate render (not layout), so child layout passes
 * are skipped on every pan.  Layout is only re-run when sizes change.
 *
 * Clipping is a Graphics rectangle mask applied to the internal world
 * Container.  It is redrawn each render pass to track the inner rect,
 * so padding is respected automatically.
 */
export class LayoutViewport extends LayoutObject {
  /** Holds all layout children; offset by the camera each render pass. */
  private readonly _world = new Container();
  /** Rectangular mask applied to _world; redrawn to match innerRect. */
  private readonly _clip  = new Graphics();

  private _camX: number;
  private _camY: number;

  constructor(options: LayoutViewportOptions = {}) {
    super(options);
    this._camX = options.cameraX ?? 0;
    this._camY = options.cameraY ?? 0;

    // _clip must be in the display list so PixiJS can render it into the
    // stencil buffer.  Both _clip and _world share this object's local space.
    this._world.mask = this._clip;
    this.addDisplay(this._clip);
    this.addDisplay(this._world);

    this.invalidateRender();
  }

  // ─── Camera ──────────────────────────────────────────────────────────────

  setCamera(x: number, y: number): void {
    if (this._camX === x && this._camY === y) return;
    this._camX = x;
    this._camY = y;
    this.invalidateRender(); // camera is a pure visual transform; no layout pass
  }

  panBy(dx: number, dy: number): void {
    this.setCamera(this._camX + dx, this._camY + dy);
  }

  /**
   * Pan the camera so that the given world position is centred in the
   * viewport.  Requires a valid innerRect (call after layout has run).
   */
  centerOn(worldX: number, worldY: number): void {
    this.setCamera(worldX - this.innerRect.width / 2, worldY - this.innerRect.height / 2);
  }

  getCamera(): { x: number; y: number } {
    return { x: this._camX, y: this._camY };
  }

  // ─── Children ────────────────────────────────────────────────────────────

  /**
   * Add a layout child.  The child is re-parented from this container into
   * the internal _world container so that the camera transform and clip mask
   * are applied.  Its setLayout() calls should use world coordinates.
   */
  protected override _adoptChild(child: LayoutObject): void {
    if (child.parent !== this._world) this._world.addChild(child);
  }

  override addLayoutChild<T extends LayoutObject>(child: T, depth = 0): T {
    super.addLayoutChild(child, depth);
    this._syncWorldOrder();
    return child;
  }

  override removeLayoutChild<T extends LayoutObject>(child: T): T | null {
    // Remove from _world before super, because super checks child.parent === this
    // (which is false here) and would skip the PixiJS removal otherwise.
    if (child.parent === this._world) this._world.removeChild(child);
    return super.removeLayoutChild(child);
  }

  override setChildDepth(child: LayoutObject, depth: number): void {
    super.setChildDepth(child, depth);
    this._syncWorldOrder();
  }

  // ─── Layout ──────────────────────────────────────────────────────────────

  // Children are placed at world coordinates by their own setLayout() calls.
  // The camera offset is a render-time transform applied in redraw(); no
  // per-child adjustment is needed here.
  protected override updateLayoutChildren(): void {}

  // ─── Render ──────────────────────────────────────────────────────────────

  protected override redraw(): void {
    const { x, y, width, height } = this.innerRect;

    // Redraw the clip mask to the current inner rect.
    // This is a white-filled rectangle; PixiJS uses it as a stencil — only
    // pixels inside the shape pass through.
    this._clip.clear().rect(x, y, width, height).fill(0xffffff);

    // Position _world so that world origin (0, 0) lands at the inner rect's
    // top-left corner, then subtract the camera offset:
    //   screen = world + _world.position
    //          = world + (innerRect.x − camX,  innerRect.y − camY)
    this._world.position.set(x - this._camX, y - this._camY);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  /**
   * Mirror the depth-sorted _layoutChildren order into _world's PixiJS child
   * list so that lower-depth children are drawn behind higher-depth ones.
   * _syncPixiOrder() (from the base class) operates on `this`, not on _world,
   * so we maintain _world's order here separately.
   */
  private _syncWorldOrder(): void {
    const children = this.getLayoutChildren();
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.parent !== this._world) continue;
      if (this._world.getChildIndex(child) !== i) {
        this._world.setChildIndex(child, i);
      }
    }
  }
}
