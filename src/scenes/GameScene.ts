import { Ticker } from "pixi.js";
import { getApp } from "@/app/AppContext";
import type { Scene } from "./SceneManager";
import { GameView } from "@/ui/components";

export interface GameSceneOptions {
  viewId: number;
  width: number;
  height: number;
}

export class GameScene implements Scene {
  public readonly view: GameView;

  public constructor(options: GameSceneOptions) {
    this.view = new GameView({
      viewId: options.viewId,
      width: options.width,
      height: options.height,
    });

    const app = getApp();
    app.stage.addChild(this.view);
    app.ticker.add(this.update, this);
  }

  public update(_ticker: Ticker): void {
    this.view.updateLayout();
    this.view.renderLayout();
  }

  public destroy(): void {
    const app = getApp();

    app.ticker.remove(this.update, this);

    if (this.view.parent) {
      this.view.parent.removeChild(this.view);
    }

    this.view.destroy({ children: true });
  }
}
