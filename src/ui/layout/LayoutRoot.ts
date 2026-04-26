import { getApp } from "@/app";
import { LayoutObject, type LayoutObjectOptions } from "./LayoutObject";

/**
 * Top-level layout node that sizes itself to the PixiJS renderer screen and
 * re-layout whenever the window resizes. Each layout child is sized to fill
 * the full inner rect, making this the entry point for full-screen views.
 */
export class LayoutRoot extends LayoutObject {
  private readonly _onResize: () => void;

  constructor(options: LayoutObjectOptions = {}) {
    super(options);

    this._onResize = () => this._syncToScreen();
    getApp().renderer.on("resize", this._onResize);
    this._syncToScreen();
  }

  override destroy(options?: Parameters<LayoutObject["destroy"]>[0]): void {
    getApp().renderer.off("resize", this._onResize);
    super.destroy(options);
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

  tick(): void {
    this.updateLayout();
    this.renderLayout();
  }

  private _syncToScreen(): void {
    const { width, height } = getApp().renderer.screen;
    this.setLayout(0, 0, width, height);
  }
}
