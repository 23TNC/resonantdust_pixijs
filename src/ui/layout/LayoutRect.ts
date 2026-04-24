import { Container, Graphics, Rectangle } from "pixi.js";

interface LayoutRectOptions {
  originX?: number;
  originY?: number;
  alignX?: number;
  alignY?: number;
}

export class LayoutRect extends Container {
  public outerRect: Rectangle;
  public innerRect: Rectangle;
  public originX: number;
  public originY: number;
  public alignX: number;
  public alignY: number;

  private padding: number;
  private debugGraphics: Graphics | null;

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

    this.outerRect = new Rectangle(0, 0, width, height);
    this.innerRect = new Rectangle(0, 0, 0, 0);
    this.hitArea = this.innerRect;
    this.debugGraphics = null;

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
}
