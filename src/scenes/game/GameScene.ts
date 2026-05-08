import { ActionManager } from "../../game/actions/ActionManager";
import { ParticleManager } from "../../assets/ParticleManager";
import { CardManager } from "../../game/cards/CardManager";
import { GameInventory } from "../../game/inventory/InventoryGame";
import { GameManager } from "./GameManager";
import type { GameContext } from "../../GameContext";
import { DragManager } from "../../game/input/DragManager";
import { InputManager } from "../../game/input/InputManager";
import { LayoutManager } from "../../game/layout/LayoutManager";
// import { WorldPanManager } from "../world/WorldPanManager";
import { packZoneId } from "../../server/data/packing";
import { GameLayout } from "./GameLayout";
import { Scene } from "../Scene";

const INVENTORY_LAYER = 1;

export class GameScene extends Scene {
  private gameLayout!: GameLayout;
  private cardManager!: CardManager;
  private layoutManager!: LayoutManager;
  private gameManager!: GameManager;
  private gameInventory!: GameInventory;
  private inputManager!: InputManager;
  private dragManager!: DragManager;
  private actionManager!: ActionManager;
  // private worldPanManager!: WorldPanManager;
  private particleManager!: ParticleManager;
  private releaseCards: (() => void) | null = null;
  private releaseKeys: (() => void) | null = null;
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
      ctx,
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

    // ActionManager must come after CardManager — it subscribes to
    // CardManager's stack-change events and reads the card overlay.
    this.actionManager = new ActionManager(ctx);
    ctx.actions = this.actionManager;

    // this.worldPanManager = new WorldPanManager(ctx, this.gameLayout.worldView);
    // ctx.world = this.gameLayout.worldView;

    this.particleManager = new ParticleManager();
    void this.particleManager.init();

    this.releaseCards = ctx.zones.ensure(inventoryZoneId);
    const releaseKeyDown = this.inputManager.onKey("key_down", ({ code }) => {
      if (code === "KeyE") {
        this.gameInventory.snapToGrid();
        this.gameLayout.inventoryView.showGrid(true);
      }
    });
    const releaseKeyUp = this.inputManager.onKey("key_up", ({ code }) => {
      if (code === "KeyE") this.gameLayout.inventoryView.showGrid(false);
    });
    this.releaseKeys = () => { releaseKeyDown(); releaseKeyUp(); };
  }

  onExit(): void {
    this.releaseKeys?.();
    this.releaseKeys = null;
    this.releaseCards?.();
    this.releaseCards = null;

    this.particleManager.destroy();
    // this.worldPanManager.dispose();
    this.actionManager.dispose();
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
      this.ctxRef.actions = null;
      // this.ctxRef.world = null;
      this.ctxRef = null;
    }
  }

  onResize(width: number, height: number): void {
    this.gameLayout.setBounds(0, 0, width, height);
    this.gameLayout.layoutIfDirty();
  }

  update(deltaMS: number): void {
    this.gameManager.tick(deltaMS);
    this.particleManager.tick(deltaMS);
    // this.worldPanManager.update();
    const drawCalls = this.ctxRef?.drawCallCounter.readAndReset() ?? 0;
    this.gameLayout.titleBar.updateStats(deltaMS, drawCalls);
    this.gameLayout.layoutIfDirty();
  }
}
