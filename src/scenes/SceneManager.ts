import type { Application, Ticker } from "pixi.js";
import type { GameContext } from "../GameContext";
import { Scene } from "./Scene";

export class SceneManager {
  private current: Scene | null = null;
  private context: GameContext | null = null;
  private transitionChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly tickerCallback: (ticker: Ticker) => void;
  private readonly resizeListener: () => void;

  constructor(private readonly app: Application) {
    this.tickerCallback = (ticker) => {
      this.current?.update(ticker.deltaMS);
    };
    this.resizeListener = () => {
      this.app.resize();
      this.current?.resize(
        this.app.renderer.width,
        this.app.renderer.height,
      );
    };
    app.ticker.add(this.tickerCallback);
    window.addEventListener("resize", this.resizeListener);
  }

  setContext(context: GameContext): void {
    if (this.context) {
      throw new Error("SceneManager: context already set");
    }
    this.context = context;
  }

  change(scene: Scene): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("SceneManager: disposed"));
    }
    this.transitionChain = this.transitionChain
      .catch(() => undefined)
      .then(() => this.performChange(scene));
    return this.transitionChain;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.transitionChain.catch(() => undefined);
    if (this.current) {
      const previous = this.current;
      this.current = null;
      try {
        await previous.onExit();
      } finally {
        previous.root.destroy({ children: true });
      }
    }
    this.app.ticker.remove(this.tickerCallback);
    window.removeEventListener("resize", this.resizeListener);
  }

  private async performChange(scene: Scene): Promise<void> {
    if (this.disposed) return;
    if (!this.context) {
      throw new Error("SceneManager.change called before setContext");
    }

    const previous = this.current;
    if (previous) {
      this.current = null;
      try {
        await previous.onExit();
      } finally {
        previous.root.destroy({ children: true });
      }
    }

    if (this.disposed) {
      scene.root.destroy({ children: true });
      return;
    }

    await scene.onEnter(this.context);

    if (this.disposed) {
      scene.root.destroy({ children: true });
      return;
    }

    this.app.stage.addChild(scene.root);
    scene.resize(this.app.renderer.width, this.app.renderer.height);
    this.current = scene;
  }
}
