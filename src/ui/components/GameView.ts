import { Ticker } from "pixi.js";
import { LayoutRoot, type LayoutPadding, type LayoutRootOptions } from "@/ui/layout/LayoutRoot";

export interface GameViewOptions extends LayoutRootOptions {
  viewId: number;
  width: number;
  height: number;
  padding?: LayoutPadding;
}

export class GameView extends LayoutRoot {
  public readonly viewId: number;

  public constructor(options: GameViewOptions) {
    super(options);

    this.viewId = options.viewId;
  }

  public update(_ticker: Ticker): void {
    this.updateTree();
  }
}
