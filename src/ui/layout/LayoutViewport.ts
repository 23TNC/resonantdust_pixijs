import { Container, Point, Rectangle, ScissorMask } from "pixi.js";
import { LayoutRect, type LayoutRectOptions } from "./LayoutRect";

export interface LayoutViewportOptions extends LayoutRectOptions {
  scissorClipping?: boolean;
  cull?: boolean;
}

export interface ViewportChildRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class LayoutViewport extends LayoutRect {
  private viewOffsetX = 0;
  private viewOffsetY = 0;
  private readonly childRects = new Map<LayoutRect, ViewportChildRect>();
  private readonly scissorClipArea: Container;
  private readonly scissorClipMask: ScissorMask;
  private scissorClippingEnabled: boolean;
  private cullEnabled: boolean;

  public constructor(options: LayoutViewportOptions = {}) {
    super(options);

    this.scissorClippingEnabled = options.scissorClipping ?? true;
    this.cullEnabled = options.cull ?? true;
    this.scissorClipArea = new Container();
    this.scissorClipArea.renderable = false;
    this.scissorClipMask = new ScissorMask(this.scissorClipArea);

    this.addChild(this.scissorClipArea);
    this.updateScissorClipArea();
    this.applyScissorClipping();
  }

  public addLayoutItem<T extends LayoutRect>(
    child: T,
    x: number,
    y: number,
    width = child.getOuterRect().width,
    height = child.getOuterRect().height,
  ): T {
    return this.addViewportChild(child, x, y, width, height);
  }

  public addViewportChild<T extends LayoutRect>(
    child: T,
    x: number,
    y: number,
    width = child.getOuterRect().width,
    height = child.getOuterRect().height,
  ): T {
    this.childRects.set(child, { x, y, width, height });
    this.invalidateLayout();
    return this.addLayoutChild(child);
  }

  public removeLayoutItem<T extends LayoutRect>(child: T): T {
    return this.removeViewportChild(child);
  }

  public removeViewportChild<T extends LayoutRect>(child: T): T {
    this.childRects.delete(child);
    this.invalidateLayout();
    return this.removeLayoutChild(child);
  }

  public setChildWorldRect(
    child: LayoutRect,
    x: number,
    y: number,
    width = child.getOuterRect().width,
    height = child.getOuterRect().height,
  ): void {
    if (!this.childRects.has(child)) {
      return;
    }

    this.childRects.set(child, { x, y, width, height });
    this.invalidateLayout();
  }

  public getChildWorldRect(child: LayoutRect): ViewportChildRect | null {
    const rect = this.childRects.get(child);
    return rect ? { ...rect } : null;
  }

  public setViewOffset(x: number, y: number): void {
    this.viewOffsetX = x;
    this.viewOffsetY = y;
    this.invalidateLayout();
  }

  public panBy(dx: number, dy: number): void {
    this.setViewOffset(this.viewOffsetX + dx, this.viewOffsetY + dy);
  }

  public getViewOffset(): Point {
    return new Point(this.viewOffsetX, this.viewOffsetY);
  }

  public viewportToWorld(x: number, y: number): Point {
    const localX = x - this.innerRect.x;
    const localY = y - this.innerRect.y;

    return new Point(localX + this.viewOffsetX, localY + this.viewOffsetY);
  }

  public worldToViewport(x: number, y: number): Point {
    return new Point(
      this.innerRect.x + x - this.viewOffsetX,
      this.innerRect.y + y - this.viewOffsetY,
    );
  }

  public setScissorClippingEnabled(enabled: boolean): void {
    this.scissorClippingEnabled = enabled;
    this.applyScissorClipping();
  }

  public getScissorClippingEnabled(): boolean {
    return this.scissorClippingEnabled;
  }

  public setCullEnabled(enabled: boolean): void {
    this.cullEnabled = enabled;
    this.invalidateLayout();
  }

  public getCullEnabled(): boolean {
    return this.cullEnabled;
  }

  public getVisibleWorldRect(): Rectangle {
    return new Rectangle(
      this.viewOffsetX,
      this.viewOffsetY,
      this.innerRect.width,
      this.innerRect.height,
    );
  }

  public override updateRects(): void {
    super.updateRects();
    this.updateScissorClipArea();
  }

  public override hitTestLayout(globalX: number, globalY: number): LayoutRect | null {
    const local = this.toLocal(new Point(globalX, globalY));

    if (!this.innerRect.contains(local.x, local.y)) {
      return null;
    }

    for (const child of [...this.getLayoutChildren()].reverse()) {
      if (!child.visible) {
        continue;
      }

      const hit = child.hitTestLayout(globalX, globalY);

      if (hit) {
        return hit;
      }
    }

    return this;
  }

  protected override layoutChildren(): void {
    const visibleWorldRect = this.getVisibleWorldRect();

    for (const child of this.getLayoutChildren()) {
      const rect = this.childRects.get(child);

      if (!rect) {
        continue;
      }

      child.visible = !this.cullEnabled || this.intersects(rect, visibleWorldRect);

      if (!child.visible) {
        continue;
      }

      const viewportPosition = this.worldToViewport(rect.x, rect.y);
      child.setLayout(
        viewportPosition.x,
        viewportPosition.y,
        rect.width,
        rect.height,
      );
    }

    this.layoutDirty = false;
  }

  private updateScissorClipArea(): void {
    this.scissorClipArea.position.set(this.innerRect.x, this.innerRect.y);
    this.scissorClipArea.boundsArea = new Rectangle(
      0,
      0,
      this.innerRect.width,
      this.innerRect.height,
    );
  }

  private applyScissorClipping(): void {
    this.effects = this.scissorClippingEnabled ? [this.scissorClipMask] : undefined;
  }

  private intersects(a: ViewportChildRect, b: Rectangle): boolean {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  }
}
