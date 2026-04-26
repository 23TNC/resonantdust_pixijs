import { Graphics } from "pixi.js";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";

export interface PanelOptions extends LayoutObjectOptions {
  fill?: number;
  stroke?: number;
  strokeWidth?: number;
  radius?: number;
  alpha?: number;
}

/**
 * A LayoutObject that draws a rounded rectangle background sized to its inner rect.
 * Layout children added to a Panel are sized to fill the inner rect.
 */
export class Panel extends LayoutObject {
  private readonly _bg = new Graphics();

  private _fill: number;
  private _stroke: number;
  private _strokeWidth: number;
  private _radius: number;
  private _alpha: number;

  constructor(options: PanelOptions = {}) {
    super(options);

    this._fill        = options.fill        ?? 0x111111;
    this._stroke      = options.stroke      ?? 0x333333;
    this._strokeWidth = options.strokeWidth ?? 1;
    this._radius      = options.radius      ?? 12;
    this._alpha       = options.alpha       ?? 1;

    this.addDisplay(this._bg);
    this.invalidateRender();
  }

  setStyle(options: Partial<Omit<PanelOptions, keyof LayoutObjectOptions>>): void {
    if (options.fill        !== undefined) this._fill        = options.fill;
    if (options.stroke      !== undefined) this._stroke      = options.stroke;
    if (options.strokeWidth !== undefined) this._strokeWidth = options.strokeWidth;
    if (options.radius      !== undefined) this._radius      = options.radius;
    if (options.alpha       !== undefined) this._alpha       = options.alpha;
    this.invalidateRender();
  }

  protected override redraw(): void {
    const { x, y, width, height } = this.innerRect;

    this._bg.clear();
    this._bg
      .roundRect(x, y, width, height, this._radius)
      .fill({ color: this._fill, alpha: this._alpha });

    if (this._strokeWidth > 0) {
      this._bg.stroke({ color: this._stroke, width: this._strokeWidth });
    }
  }

  protected override updateLayoutChildren(): void {
    for (const child of this.getLayoutChildren()) {
      child.setLayout(
        this.innerRect.x,
        this.innerRect.y,
        this.innerRect.width,
        this.innerRect.height,
      );
    }
  }
}
