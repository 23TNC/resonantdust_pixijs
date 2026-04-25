import { Container } from "pixi.js"
import type { Scene } from './SceneManager';
import type { SceneManager } from './SceneManager';
import { GameScene } from './GameScene';

import { setPlayerName, setPlayerId } from '@/spacetime/data'; // adjust path if needed

export class LoginScene implements Scene {
  public readonly view = new Container();

  private readonly sceneManager: SceneManager;
  private initialized = false;

  public constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
  }

  public update(): void {
    if (this.initialized) return;
    this.initialized = true;

    // temp login stub
    setPlayerName('player1');
    setPlayerId(1); // :contentReference[oaicite:0]{index=0}

    // transition immediately
    this.sceneManager.setScene(
      new GameScene({
        viewId: 1,
        width: 0,
        height: 0,
      }),
    );
  }

  public destroy(): void {
    this.view.destroy({ children: true });
  }
}