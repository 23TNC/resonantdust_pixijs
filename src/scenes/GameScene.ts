import { Ticker } from 'pixi.js';
import type { Scene } from './SceneManager';
import { GameView } from '@/ui/components';

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
  }

  public update(_ticker: Ticker): void {
    this.view.updateTree();
  }

  public destroy(): void {
    this.view.destroy({ children: true });
  }
}
