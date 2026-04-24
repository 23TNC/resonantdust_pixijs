import { Application } from "pixi.js";

interface GameViewOptions {
  app: Application;
  viewedId: number;
}

export class GameView {
  constructor(options: GameViewOptions) {
  }
  
  resize(width: number, height: number): void {
  }

  render(): void {
  }
}
