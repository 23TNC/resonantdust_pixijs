import { Container, Graphics, Point, Rectangle } from "pixi.js";

export type LayoutPadding =
  | number
  | {
      top?: number;
      right?: number;
      bottom?: number;
      left?: number;
    };

export interface LayoutRectPaddingValues {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface LayoutRectOptions {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  originX?: number;
  originY?: number;
  padding?: LayoutPadding;
  debug?: boolean;
}

type LayoutRectConstructor<T extends LayoutRect> = abstract new (...args: never[]) => T;

export class LayoutRect extends Container {
  public readonly outerRect = new Rectangle();
  public readonly innerRect = new Rectangle();

  public originX: number;
  public originY: number;

  protected layoutDirty = true;
  protected renderDirty = true;
  protected parentLayout: LayoutRect | null = null;

  private padding: LayoutRectPaddingValues = {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };

  private debugGraphics: Graphics | null = null;

  public constructor(options: LayoutRectOptions = {}) {
    super();

    this.originX = options.originX ?? 0;
    this.originY = options.originY ?? 0;

    this.position.set(options.x ?? 0, options.y ?? 0);
    this.outerRect.x = 0;
    this.outerRect.y = 0;
    this.outerRect.width = Math.max(0, options.width ?? 0);
    this.outerRect.height = Math.max(0, options.height ?? 0);
    this.hitArea = this.innerRect;

    this.setPaddingValues(options.padding ?? 0);
    this.updateRects();

    if (options.debug) {
      this.setDebug(true);
    }
  }

  public setLayout(x: number, y: number, width: number, height: number): void {
    this.position.set(x, y);
    this.setOuterRect(0, 0, width, height);
  }

  public setOuterRect(x: number, y: number, width: number, height: number): void {
    this.outerRect.x = x;
    this.outerRect.y = y;
    this.outerRect.width = Math.max(0, width);
    this.outerRect.height = Math.max(0, height);

    this.updateRects();
    this.invalidateLayout();
  }

  public setPadding(padding: LayoutPadding): void {
    this.setPaddingValues(padding);
    this.updateRects();
    this.invalidateLayout();
  }

  public getPadding(): LayoutRectPaddingValues {
    return { ...this.padding };
  }

  public setOrigin(originX: number, originY: number): void {
    this.originX = originX;
    this.originY = originY;

    this.updateRects();
    this.invalidateLayout();
  }

  public updateRects(): void {
    const top = Math.max(0, this.padding.top);
    const right = Math.max(0, this.padding.right);
    const bottom = Math.max(0, this.padding.bottom);
    const left = Math.max(0, this.padding.left);

    this.innerRect.x = this.outerRect.x + left;
    this.innerRect.y = this.outerRect.y + top;
    this.innerRect.width = Math.max(0, this.outerRect.width - left - right);
    this.innerRect.height = Math.max(0, this.outerRect.height - top - bottom);

    this.pivot.set(
      this.outerRect.width * this.originX,
      this.outerRect.height * this.originY,
    );

    this.redrawDebug();
  }

  public invalidateLayout(): void {
    this.layoutDirty = true;
    this.invalidateRender();
    this.parentLayout?.invalidateLayout();
  }

  public invalidateRender(): void {
    this.renderDirty = true;
    this.parentLayout?.invalidateRender();
  }

  public isLayoutDirty(): boolean {
    return this.layoutDirty;
  }

  public isRenderDirty(): boolean {
    return this.renderDirty;
  }

  public updateLayout(): void {
    if (!this.layoutDirty) {
      return;
    }

    this.layoutChildren();
    this.layoutDirty = false;
  }

  public renderLayout(): void {
    if (!this.renderDirty) {
      return;
    }

    this.redraw();
    this.redrawDebug();
    this.renderDirty = false;
  }

  protected redraw(): void {}

  protected layoutChildren(): void {
    // Subclasses arrange layout children here.
  }

  public addLayoutChild<T extends LayoutRect>(child: T): T {
    child.parentLayout = this;

    if (child.parent !== this) {
      this.addChild(child);
    }

    this.invalidateLayout();
    return child;
  }

  public removeLayoutChild<T extends LayoutRect>(child: T): T {
    if (child.parentLayout === this) {
      child.parentLayout = null;
    }

    if (child.parent === this) {
      this.removeChild(child);
    }

    this.invalidateLayout();
    return child;
  }

  public getParentLayout(): LayoutRect | null {
    return this.parentLayout;
  }

  public getLayoutAncestors(): LayoutRect[] {
    const ancestors: LayoutRect[] = [];
    let current = this.parentLayout;

    while (current) {
      ancestors.push(current);
      current = current.parentLayout;
    }

    return ancestors;
  }

  public findParentLayout<T extends LayoutRect>(
    type: LayoutRectConstructor<T>,
  ): T | null {
    let current = this.parentLayout;

    while (current) {
      if (current instanceof type) {
        return current;
      }

      current = current.parentLayout;
    }

    return null;
  }

  public getLayoutChildren(): LayoutRect[] {
    return this.children.filter(
      (child): child is LayoutRect => child instanceof LayoutRect,
    );
  }

  public containsGlobalPoint(globalX: number, globalY: number): boolean {
    const local = this.toLocal(new Point(globalX, globalY));
    return this.innerRect.contains(local.x, local.y);
  }

  public hitTestLayout(globalX: number, globalY: number): LayoutRect | null {
    if (!this.containsGlobalPoint(globalX, globalY)) {
      return null;
    }

    const children = this.getLayoutChildren();

    for (let i = children.length - 1; i >= 0; i--) {
      const hit = children[i].hitTestLayout(globalX, globalY);

      if (hit) {
        return hit;
      }
    }

    return this;
  }

  public bringLayoutChildToFront(child: LayoutRect): void {
    if (child.parent === this) {
      this.setChildIndex(child, this.children.length - 1);
      this.invalidateRender();
    }
  }

  public sendLayoutChildToBack(child: LayoutRect): void {
    if (child.parent === this) {
      this.setChildIndex(child, 0);
      this.invalidateRender();
    }
  }

  public getOuterRect(): Rectangle {
    return this.outerRect;
  }

  public getInnerRect(): Rectangle {
    return this.innerRect;
  }

  public setDebug(enabled: boolean): void {
    if (enabled) {
      this.debugGraphics ??= this.addChild(new Graphics());
      this.redrawDebug();
      this.invalidateRender();
      return;
    }

    this.debugGraphics?.destroy();
    this.debugGraphics = null;
    this.invalidateRender();
  }

  private setPaddingValues(padding: LayoutPadding): void {
    if (typeof padding === "number") {
      const value = Math.max(0, padding);
      this.padding = {
        top: value,
        right: value,
        bottom: value,
        left: value,
      };

      return;
    }

    this.padding = {
      top: Math.max(0, padding.top ?? this.padding.top),
      right: Math.max(0, padding.right ?? this.padding.right),
      bottom: Math.max(0, padding.bottom ?? this.padding.bottom),
      left: Math.max(0, padding.left ?? this.padding.left),
    };
  }

  private redrawDebug(): void {
    if (!this.debugGraphics) {
      return;
    }

    this.debugGraphics.clear();

    this.debugGraphics
      .rect(this.outerRect.x, this.outerRect.y, this.outerRect.width, this.outerRect.height)
      .stroke({ color: 0x00a3ff, width: 1, alpha: 1 });

    this.debugGraphics
      .rect(this.innerRect.x, this.innerRect.y, this.innerRect.width, this.innerRect.height)
      .stroke({ color: 0x00ff88, width: 1, alpha: 1 });
  }
}
