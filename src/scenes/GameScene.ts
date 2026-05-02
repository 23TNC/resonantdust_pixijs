import { CardManager } from "../cards/CardManager";
import { GameInventory } from "../game/GameInventory";
import { GameManager } from "../game/GameManager";
import type { GameContext } from "../GameContext";
import { DragManager } from "../input/DragManager";
import { InputManager } from "../input/InputManager";
import { LayoutManager } from "../layout/LayoutManager";
import { packZoneId } from "../zones/zoneId";
import { GameLayout } from "./game/GameLayout";
import { Scene } from "./Scene";

const INVENTORY_LAYER = 1;

export class GameScene extends Scene {
  private gameLayout!: GameLayout;
  private cardManager!: CardManager;
  private layoutManager!: LayoutManager;
  private gameManager!: GameManager;
  private gameInventory!: GameInventory;
  private inputManager!: InputManager;
  private dragManager!: DragManager;
  private releaseCards: (() => void) | null = null;
  private ctxRef: GameContext | null = null;

  onEnter(ctx: GameContext): void {
    const player = ctx.playerSession.getPlayer();
    if (!player) {
      throw new Error("GameScene entered without a logged-in player");
    }

    this.ctxRef = ctx;
    this.layoutManager = new LayoutManager();
    ctx.layout = this.layoutManager;

    const inventoryZoneId = packZoneId(player.playerId, INVENTORY_LAYER);
    this.gameLayout = new GameLayout(
      player.name,
      this.layoutManager,
      inventoryZoneId,
    );
    this.gameLayout.setContext(ctx);
    this.layoutManager.overlay = this.gameLayout.overlay;
    this.root.addChild(this.gameLayout.container);

    this.cardManager = new CardManager(ctx);
    ctx.cards = this.cardManager;

    this.gameManager = new GameManager(ctx);
    ctx.game = this.gameManager;

    this.gameInventory = new GameInventory(ctx, inventoryZoneId);
    this.gameManager.add(this.gameInventory);

    this.inputManager = new InputManager(ctx.app.canvas, this.gameLayout);
    ctx.input = this.inputManager;

    this.dragManager = new DragManager(ctx);

    this.releaseCards = ctx.zones.ensure(inventoryZoneId);
  }

  onExit(): void {
    this.releaseCards?.();
    this.releaseCards = null;

    this.dragManager.dispose();
    this.inputManager.dispose();
    this.gameManager.dispose();
    this.cardManager.dispose();
    this.gameLayout.destroy();
    this.layoutManager.dispose();

    if (this.ctxRef) {
      this.ctxRef.cards = null;
      this.ctxRef.layout = null;
      this.ctxRef.game = null;
      this.ctxRef.input = null;
      this.ctxRef = null;
    }
  }

  onResize(width: number, height: number): void {
    this.gameLayout.setBounds(0, 0, width, height);
    this.gameLayout.layoutIfDirty();
  }

  update(deltaMS: number): void {
    this.gameManager.tick(deltaMS);
    this.gameLayout.titleBar.updateFps(deltaMS);
    this.gameLayout.layoutIfDirty();
  }
}
