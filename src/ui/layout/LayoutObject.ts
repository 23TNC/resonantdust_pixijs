import { Container, Point, Rectangle } from "pixi.js";

export type LayoutPadding =
  | number
  | { top?: number; right?: number; bottom?: number; left?: number };

export interface LayoutObjectOptions {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  padding?: LayoutPadding;
}

interface LayoutEntry {
  object: LayoutObject;
  depth: number;
}

/**
 * Base node for the layout tree. Handles position/size, dirty propagation,
 * recursive update and render, and hit-testing.
 *
 * Children are ordered by depth (ascending). Lower depth renders first (behind);
 * higher depth renders last (in front) and is hit-tested first.
 *
 * Non-layout visual elements (Graphics, Sprites, etc.) should be added via
 * addDisplay() so they are kept below layout children in the display list.
 */
export class LayoutObject extends Container {
  readonly outerRect = new Rectangle();
  readonly innerRect = new Rectangle();

  private _padding = { top: 0, right: 0, bottom: 0, left: 0 };
  private _layoutDirty = true;
  private _renderDirty = true;
  private _parentLayout: LayoutObject | null = null;
  private _layoutChildren: LayoutEntry[] = [];
  private _displayCount = 0;

  constructor(options: LayoutObjectOptions = {}) {
    super();
    this.position.set(options.x ?? 0, options.y ?? 0);
    this.outerRect.width = Math.max(0, options.width ?? 0);
    this.outerRect.height = Math.max(0, options.height ?? 0);
    this._applyPadding(options.padding ?? 0);
    this._syncInnerRect();
    this.hitArea = this.innerRect;
  }

  // ─── Dimensions ──────────────────────────────────────────────────────────

  /**
   * Called by a parent layout to position and size this object.
   * Sets position in the parent's local space and updates outer/inner rects.
   */
  setLayout(x: number, y: number, width: number, height: number): void {
    this.position.set(x, y);
    this.outerRect.width = Math.max(0, width);
    this.outerRect.height = Math.max(0, height);
    this._syncInnerRect();
    this._layoutDirty = true;
    this._renderDirty = true;
    this._parentLayout?.invalidateRender();
  }

  setPadding(padding: LayoutPadding): void {
    this._applyPadding(padding);
    this._syncInnerRect();
    this.invalidateLayout();
  }

  getPadding(): Readonly<{ top: number; right: number; bottom: number; left: number }> {
    return { ...this._padding };
  }

  // ─── Dirty state ─────────────────────────────────────────────────────────

  /**
   * Mark this node and all ancestors as needing a layout + render pass.
   * Invalidating layout always implies invalidating render.
   */
  invalidateLayout(): void {
    this._layoutDirty = true;
    this._renderDirty = true;
    this._parentLayout?.invalidateLayout();
  }

  /**
   * Mark this node and all ancestors as needing a render pass only.
   * Use this when visual content changes but positions/sizes are unchanged.
   */
  invalidateRender(): void {
    this._renderDirty = true;
    this._parentLayout?.invalidateRender();
  }

  isLayoutDirty(): boolean {
    return this._layoutDirty;
  }

  isRenderDirty(): boolean {
    return this._renderDirty;
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  /**
   * Drive the layout pass. Calls updateLayoutChildren() to position/size all
   * children, clears the layout flag, then recurses into each child.
   */
  updateLayout(): void {
    if (!this._layoutDirty) return;
    this.updateLayoutChildren();
    this._layoutDirty = false;
    for (const { object } of this._layoutChildren) {
      object.updateLayout();
    }
  }

  /** Override to position and size layout children according to this node's rules. */
  protected updateLayoutChildren(): void {}

  // ─── Render ──────────────────────────────────────────────────────────────

  /**
   * Drive the render pass. Calls redraw() on self, clears the render flag,
   * then recurses into visible children in depth order.
   */
  renderLayout(): void {
    if (!this._renderDirty) return;
    this.redraw();
    this._renderDirty = false;
    for (const { object } of this._layoutChildren) {
      if (object.visible) object.renderLayout();
    }
  }

  /** Override to update this node's own visual representation (Graphics, etc.). */
  protected redraw(): void {}

  // ─── Hit test ────────────────────────────────────────────────────────────

  /**
   * Returns the deepest visible layout node whose innerRect contains the point,
   * checking children from highest depth to lowest before falling back to self.
   */
  hitTestLayout(globalX: number, globalY: number): LayoutObject | null {
    const local = this.toLocal(new Point(globalX, globalY));
    if (!this.innerRect.contains(local.x, local.y)) return null;

    for (let i = this._layoutChildren.length - 1; i >= 0; i--) {
      const { object } = this._layoutChildren[i];
      if (!object.visible) continue;
      const hit = object.hitTestLayout(globalX, globalY);
      if (hit) return hit;
    }

    return this;
  }

  // ─── Layout children ─────────────────────────────────────────────────────

  addLayoutChild<T extends LayoutObject>(child: T, depth = 0): T {
    if (child._parentLayout === this) {
      this._setDepthInternal(child, depth);
      return child;
    }

    child._parentLayout?.removeLayoutChild(child);
    child._parentLayout = this;

    this._insertSorted({ object: child, depth });

    this._adoptChild(child);
    this._syncPixiOrder();
    this.invalidateLayout();
    return child;
  }

  /**
   * Place a newly adopted layout child into the PixiJS display list.
   * Override in subclasses that redirect children to an inner container
   * (e.g. LayoutViewport, which places children in _world).
   */
  protected _adoptChild(child: LayoutObject): void {
    if (child.parent !== this) this.addChild(child);
  }

  removeLayoutChild<T extends LayoutObject>(child: T): T | null {
    const index = this._layoutChildren.findIndex(e => e.object === child);
    if (index < 0) return null;

    this._layoutChildren.splice(index, 1);
    child._parentLayout = null;

    if (child.parent === this) this.removeChild(child);
    this.invalidateLayout();
    return child;
  }

  destroyLayoutChild(child: LayoutObject): void {
    this.removeLayoutChild(child);
    child.destroy({ children: true });
  }

  setChildDepth(child: LayoutObject, depth: number): void {
    this._setDepthInternal(child, depth);
  }

  getChildDepth(child: LayoutObject): number | null {
    return this._layoutChildren.find(e => e.object === child)?.depth ?? null;
  }

  /** Returns layout children in depth order (ascending — lowest depth first). */
  getLayoutChildren(): LayoutObject[] {
    return this._layoutChildren.map(e => e.object);
  }

  getParentLayout(): LayoutObject | null {
    return this._parentLayout;
  }

  findParentOfType<T extends LayoutObject>(ctor: abstract new (...args: never[]) => T): T | null {
    let current = this._parentLayout;
    while (current) {
      if (current instanceof ctor) return current as T;
      current = current._parentLayout;
    }
    return null;
  }

  // ─── Display children ────────────────────────────────────────────────────

  /**
   * Add a non-layout visual element (Graphics, Sprite, etc.) that is not part
   * of the layout tree. Display children are always inserted below layout
   * children in the PixiJS display list.
   */
  protected addDisplay<T extends Container>(child: T): T {
    this.addChildAt(child, this._displayCount++);
    return child;
  }

  protected removeDisplay<T extends Container>(child: T): T {
    if (child.parent === this) {
      const idx = this.getChildIndex(child);
      if (idx < this._displayCount) this._displayCount--;
      this.removeChild(child);
    }
    return child;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _syncInnerRect(): void {
    const { top, right, bottom, left } = this._padding;
    this.innerRect.x = left;
    this.innerRect.y = top;
    this.innerRect.width = Math.max(0, this.outerRect.width - left - right);
    this.innerRect.height = Math.max(0, this.outerRect.height - top - bottom);
  }

  private _applyPadding(padding: LayoutPadding): void {
    if (typeof padding === "number") {
      const v = Math.max(0, padding);
      this._padding = { top: v, right: v, bottom: v, left: v };
    } else {
      this._padding = {
        top: Math.max(0, padding.top ?? this._padding.top),
        right: Math.max(0, padding.right ?? this._padding.right),
        bottom: Math.max(0, padding.bottom ?? this._padding.bottom),
        left: Math.max(0, padding.left ?? this._padding.left),
      };
    }
  }

  private _insertSorted(entry: LayoutEntry): void {
    let lo = 0;
    let hi = this._layoutChildren.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      this._layoutChildren[mid].depth <= entry.depth ? (lo = mid + 1) : (hi = mid);
    }
    this._layoutChildren.splice(lo, 0, entry);
  }

  private _setDepthInternal(child: LayoutObject, depth: number): void {
    const index = this._layoutChildren.findIndex(e => e.object === child);
    if (index < 0) return;
    if (this._layoutChildren[index].depth === depth) return;
    const [entry] = this._layoutChildren.splice(index, 1);
    entry.depth = depth;
    this._insertSorted(entry);
    this._syncPixiOrder();
    this.invalidateRender();
  }

  /**
   * Keep the PixiJS display list order consistent with the depth-sorted
   * _layoutChildren array. Display children occupy indices 0.._displayCount-1;
   * layout children follow at _displayCount onward.
   */
  private _syncPixiOrder(): void {
    const base = this._displayCount;
    for (let i = 0; i < this._layoutChildren.length; i++) {
      const child = this._layoutChildren[i].object;
      if (child.parent === this && this.getChildIndex(child) !== base + i) {
        this.setChildIndex(child, base + i);
      }
    }
  }
}
