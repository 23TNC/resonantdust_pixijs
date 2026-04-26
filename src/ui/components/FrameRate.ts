import { type Ticker } from "pixi.js";
import { getApp } from "@/app";
import { LayoutLabel, type LayoutLabelOptions } from "@/ui/layout/LayoutLabel";

export interface FrameRateOptions extends LayoutLabelOptions {
  /** How many ticks between label refreshes. Default: 20 (~3×/s at 60 fps). */
  updateInterval?: number;
}

/**
 * Displays the current frames-per-second, sampled from the PixiJS ticker.
 * The label refreshes every updateInterval ticks rather than every frame so
 * the number is readable without flickering.
 */
export class FrameRate extends LayoutLabel {
  private readonly _updateInterval: number;
  private          _frameCount = 0;

  constructor(options: FrameRateOptions = {}) {
    super({ align: "center", valign: "middle", ...options, text: "-- fps" });
    this._updateInterval = options.updateInterval ?? 20;
    getApp().ticker.add(this._onTick, this);
  }

  override destroy(options?: Parameters<InstanceType<typeof LayoutLabel>["destroy"]>[0]): void {
    getApp().ticker.remove(this._onTick, this);
    super.destroy(options);
  }

  private _onTick(ticker: Ticker): void {
    if (++this._frameCount < this._updateInterval) return;
    this._frameCount = 0;
    this.setText(`${Math.round(ticker.FPS)} fps`);
  }
}
