import { Container, Ticker } from "pixi.js";
import { getApp } from "@/app/AppContext";

export interface Scene {
  readonly view: Container;

  resize?(width: number, height: number): void;
  update?(ticker: Ticker): void;
  destroy?(): void;
}

export class SceneManager {
  private currentScene: Scene | null = null;
  private readonly stage: Container;

  public constructor() {
    this.stage = getApp().stage;
  }

  public setScene(scene: Scene): void {
    if (this.currentScene) {
      this.stage.removeChild(this.currentScene.view);
      this.currentScene.destroy?.();
    }

    this.currentScene = scene;
    this.stage.addChild(scene.view);
  }

  public resize(width: number, height: number): void {
    this.currentScene?.resize?.(width, height);
  }

  public update(ticker: Ticker): void {
    this.currentScene?.update?.(ticker);
  }

  public destroy(): void {
    if (!this.currentScene) return;

    this.stage.removeChild(this.currentScene.view);
    this.currentScene.destroy?.();
    this.currentScene = null;
  }

  public get scene(): Scene | null {
    return this.currentScene;
  }
}