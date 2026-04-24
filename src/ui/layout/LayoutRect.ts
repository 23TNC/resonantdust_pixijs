import { Container, Graphics, Point, Rectangle } from "pixi.js";

interface LayoutRectOptions {
  originX?: number;
  originY?: number;
  alignX?: number;
  alignY?: number;
  layoutId?: string;
}

export class LayoutRect extends Container {
  public outerRect: Rectangle;
  public innerRect: Rectangle;
  public originX: number;
  public originY: number;
  public alignX: number;
  public alignY: number;
  public depth: number;
  public layoutId?: string;

  private padding: number;
  private debugGraphics: Graphics | null;
  private layoutChildren: LayoutRect[];

  constructor(
    x: number,
    y: number,
    width: number,
    height: number,
    padding = 0,
    options: LayoutRectOptions = {},
  ) {
    super();

    this.padding = padding;
    this.originX = options.originX ?? 0;
    this.originY = options.originY ?? 0;
    this.alignX = options.alignX ?? 0;
    this.alignY = options.alignY ?? 0;
    this.layoutId = options.layoutId;
    this.depth = 0;

    this.outerRect = new Rectangle(0, 0, width, height);
    this.innerRect = new Rectangle(0, 0, 0, 0);
    this.hitArea = this.innerRect;
    this.debugGraphics = null;
    this.layoutChildren = [];

    this.position.set(x, y);
    this.updateRects();
  }

  public setLayout(x: number, y: number, width: number, height: number): void {
    this.position.set(x, y);
    this.outerRect.width = width;
    this.outerRect.height = height;
    this.updateRects();
  }

  public setPadding(padding: number): void {
    this.padding = padding;
    this.updateRects();
  }

  public setOrigin(originX: number, originY: number): void {
    this.originX = originX;
    this.originY = originY;
    this.updateRects();
  }

  public setDepth(depth: number): void {
    this.depth = depth;

    if (this.parent instanceof LayoutRect) {
      this.parent.sortLayoutChildren();
    }
  }

  public addLayoutChild(child: LayoutRect): LayoutRect {
    if (!this.layoutChildren.includes(child)) {
      this.layoutChildren.push(child);
    }

    if (child.parent !== this) {
      this.addChild(child);
    }

    this.sortLayoutChildren();
    return child;
  }

  public removeLayoutChild(child: LayoutRect): LayoutRect {
    this.layoutChildren = this.layoutChildren.filter((item) => item !== child);

    if (child.parent === this) {
      this.removeChild(child);
    }

    return child;
  }

  public containsGlobalPoint(globalX: number, globalY: number): boolean {
    const localPoint = this.toLocal(new Point(globalX, globalY));
    return this.innerRect.contains(localPoint.x, localPoint.y);
  }

  public hitTestLayout(globalX: number, globalY: number): LayoutRect | null {
    if (!this.containsGlobalPoint(globalX, globalY)) {
      return null;
    }

    for (let index = this.layoutChildren.length - 1; index >= 0; index -= 1) {
      const child = this.layoutChildren[index];
      const hit = child.hitTestLayout(globalX, globalY);

      if (hit) {
        return hit;
      }
    }

    return this;
  }

  public updateRects(): void {
    this.outerRect.x = 0;
    this.outerRect.y = 0;

    this.innerRect.x = this.padding;
    this.innerRect.y = this.padding;
    this.innerRect.width = this.outerRect.width - (this.padding * 2);
    this.innerRect.height = this.outerRect.height - (this.padding * 2);

    this.pivot.set(
      this.outerRect.width * this.originX,
      this.outerRect.height * this.originY,
    );

    this.redrawDebug();
  }

  public getOuterRect(): Rectangle {
    return this.outerRect;
  }

  public getInnerRect(): Rectangle {
    return this.innerRect;
  }

  public setDebug(enabled: boolean): void {
    if (enabled) {
      if (!this.debugGraphics) {
        this.debugGraphics = new Graphics();
        this.addChild(this.debugGraphics);
      }

      this.redrawDebug();
      return;
    }

    if (!this.debugGraphics) {
      return;
    }

    this.removeChild(this.debugGraphics);
    this.debugGraphics.destroy();
    this.debugGraphics = null;
  }

  private redrawDebug(): void {
    if (!this.debugGraphics) {
      return;
    }

    this.debugGraphics.clear();

    this.debugGraphics
      .rect(
        this.outerRect.x,
        this.outerRect.y,
        this.outerRect.width,
        this.outerRect.height,
      )
      .stroke({
        color: 0x00a3ff,
        width: 1,
        alpha: 1,
      });

    this.debugGraphics
      .rect(
        this.innerRect.x,
        this.innerRect.y,
        this.innerRect.width,
        this.innerRect.height,
      )
      .stroke({
        color: 0x00ff88,
        width: 1,
        alpha: 1,
      });
  }

  private sortLayoutChildren(): void {
    this.layoutChildren.sort((a, b) => a.depth - b.depth);

    for (let index = 0; index < this.layoutChildren.length; index += 1) {
      this.addChild(this.layoutChildren[index]);
    }
  }
}
