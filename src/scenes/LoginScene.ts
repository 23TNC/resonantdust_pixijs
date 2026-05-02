import { Text } from "pixi.js";
import type { GameContext } from "../GameContext";
import { GameScene } from "./GameScene";
import { Scene } from "./Scene";

const PLAYER_NAME = "Player1";

export class LoginScene extends Scene {
  private status!: Text;
  private exited = false;

  onEnter(ctx: GameContext): void {
    this.status = new Text({
      text: `Logging in as ${PLAYER_NAME}…`,
      style: {
        fill: 0xffffff,
        fontFamily: "sans-serif",
        fontSize: 32,
      },
    });
    this.status.anchor.set(0.5);
    this.root.addChild(this.status);

    void this.runLogin(ctx);
  }

  onExit(): void {
    this.exited = true;
  }

  onResize(width: number, height: number): void {
    this.status?.position.set(width / 2, height / 2);
  }

  private async runLogin(ctx: GameContext): Promise<void> {
    try {
      await ctx.playerSession.claimOrLogin(PLAYER_NAME);
      if (this.exited) return;
      ctx.scenes.change(new GameScene()).catch((err) => {
        console.error("[LoginScene] scene change failed", err);
      });
    } catch (err) {
      if (this.exited) return;
      const message = err instanceof Error ? err.message : String(err);
      this.status.text = `Login failed: ${message}`;
      console.error("[LoginScene] login failed", err);
    }
  }
}
