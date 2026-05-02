import { Container } from "pixi.js";
import type { GameContext } from "../GameContext";

export abstract class Scene {
  readonly root = new Container();
  width = 0;
  height = 0;

  /** Called by SceneManager. Subclasses override `onResize` for layout. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.onResize(width, height);
  }

  onEnter(_ctx: GameContext): void | Promise<void> {}

  onExit(): void | Promise<void> {}

  onResize(_width: number, _height: number): void {}

  /** deltaMS = real-time milliseconds since last frame (PIXI Ticker.deltaMS); canonical timebase for all scene logic. */
  update(_deltaMS: number): void {}
}
