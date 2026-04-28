import { type Ticker } from "pixi.js";
import { getApp } from "@/app";
import { client_cards, observer_id, viewed_id } from "@/spacetime/Data";
import { LayoutLabel, type LayoutLabelOptions } from "@/ui/layout/LayoutLabel";

export interface ViewTitleOptions extends LayoutLabelOptions {
  /** Ticks between text refreshes. Default: 10 (~6×/s at 60 fps). */
  updateInterval?: number;
}

/**
 * Displays the current observer / viewed soul identifiers and the viewed
 * soul's world position.  Refreshes itself from client_cards on a ticker —
 * no external sync calls required.
 */
export class ViewTitle extends LayoutLabel {
  private readonly _updateInterval: number;
  private _frameCount = 0;

  constructor(options: ViewTitleOptions = {}) {
    super({ align: "center", valign: "middle", ...options });
    this._updateInterval = options.updateInterval ?? 10;
    this._refresh();
    getApp().ticker.add(this._onTick, this);
  }

  override destroy(options?: Parameters<InstanceType<typeof LayoutLabel>["destroy"]>[0]): void {
    getApp().ticker.remove(this._onTick, this);
    super.destroy(options);
  }

  private _onTick(_ticker: Ticker): void {
    if (++this._frameCount < this._updateInterval) return;
    this._frameCount = 0;
    this._refresh();
  }

  private _refresh(): void {
    const soul = client_cards[viewed_id];
    if (soul) {
      this.setText(
        `obs:${observer_id}  view:${viewed_id}  q:${soul.world_q}  r:${soul.world_r}  z:${soul.layer}`,
      );
    } else {
      this.setText(`obs:${observer_id}  view:${viewed_id}  —`);
    }
  }
}
