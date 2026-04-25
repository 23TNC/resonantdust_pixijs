// pixijs/src/ui/components/Panel.ts
import { Graphics } from "pixi.js";
import { LayoutRect, type LayoutRectOptions } from "@/ui/layout/LayoutRect";

export interface PanelOptions extends LayoutRectOptions {
  backgroundColor?: number;
  borderColor?: number;
  borderWidth?: number;
  cornerRadius?: number;
  alpha?: number;
}

export class Panel extends LayoutRect {
  protected readonly background = new Graphics();

  protected backgroundColor: number;
  protected borderColor: number;
  protected borderWidth: number;
  protected cornerRadius: number;
  protected panelAlpha: number;

  public constructor(options: PanelOptions = {}) {
    super(options);

    this.backgroundColor = options.backgroundColor ?? 0x111111;
    this.borderColor = options.borderColor ?? 0x333333;
    this.borderWidth = options.borderWidth ?? 1;
    this.cornerRadius = options.cornerRadius ?? 12;
    this.panelAlpha = options.alpha ?? 1;

    this.addChildAt(this.background, 0);
    this.invalidateRender();
  }

  public override redraw(): void {
    this.background.clear();

    this.background
      .roundRect(
        this.outerRect.x,
        this.outerRect.y,
        this.outerRect.width,
        this.outerRect.height,
        this.cornerRadius,
      )
      .fill({
        color: this.backgroundColor,
        alpha: this.panelAlpha,
      });

    if (this.borderWidth > 0) {
      this.background.stroke({
        color: this.borderColor,
        width: this.borderWidth,
      });
    }

    super.redraw();
  }

  public setPanelStyle(options: Partial<PanelOptions>): void {
    if (options.backgroundColor !== undefined) this.backgroundColor = options.backgroundColor;
    if (options.borderColor !== undefined) this.borderColor = options.borderColor;
    if (options.borderWidth !== undefined) this.borderWidth = options.borderWidth;
    if (options.cornerRadius !== undefined) this.cornerRadius = options.cornerRadius;
    if (options.alpha !== undefined) this.panelAlpha = options.alpha;

    this.invalidateRender();
  }
}