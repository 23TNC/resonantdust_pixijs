import { ActionManager } from "../../game/actions/ActionManager";
import { ParticleManager } from "../../assets/ParticleManager";
import { CardManager } from "../../game/cards/CardManager";
import { LogManager } from "../../game/chat/LogManager";
import { GameInventory } from "../../game/inventory/InventoryGame";
import { GameManager } from "./GameManager";
import type { GameContext } from "../../GameContext";
import { DragManager } from "../../game/input/DragManager";
import { InputManager } from "../../game/input/InputManager";
import { LayoutManager } from "../../game/layout/LayoutManager";
import { WorldPanManager } from "../../game/world/WorldPanManager";
import { packZoneId, unpackMacroZone, unpackMicroZone } from "../../server/data/packing";
import { LayoutCard } from "../../game/cards/layout/CardLayout";
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
  private worldPanManager!: WorldPanManager;
  private particleManager!: ParticleManager;
  private logManager!: LogManager;
  private releaseCards: (() => void) | null = null;
  private releaseKeys: (() => void) | null = null;
  private releaseSoulPan: (() => void) | null = null;
  private ctxRef: GameContext | null = null;

  onEnter(ctx: GameContext): void {
    const player = ctx.playerSession.getPlayer();
    if (!player) {
      throw new Error("GameScene entered without a logged-in player");
    }

    this.ctxRef = ctx;
    this.layoutManager = new LayoutManager();
    ctx.layout = this.layoutManager;

    // Inventory subscription is keyed on the soul the player picked
    // at character select — `SoulManager.getSoulId()` returns the
    // override set by `CharacterSelectScene.handlePlay`. Each soul
    // owns its own inventory bucket at
    // `(surface=INVENTORY_LAYER, macro_zone=soul_card_id)`. The
    // active soul is a client-side construct now (no server
    // persistence), so it MUST have been set before GameScene
    // entered — otherwise we'd subscribe to nothing useful.
    const soulCardId = ctx.souls.getSoulId();
    if (soulCardId === null) {
      throw new Error(
        "GameScene entered without an active soul — go through CharacterSelectScene first",
      );
    }
    const inventoryZoneId = packZoneId(soulCardId, INVENTORY_LAYER);
    this.gameLayout = new GameLayout(
      ctx,
      player.name,
      this.layoutManager,
      inventoryZoneId,
    );
    this.gameLayout.setContext(ctx);
    this.layoutManager.overlay = this.gameLayout.overlay;
    this.layoutManager.worldView = this.gameLayout.worldView;
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

    // Client-only flavor-text feed. Empty at scene-enter; populated
    // as game systems call `ctx.logs.push(...)` when interesting
    // things happen. Rendered by `ChatPanel`'s `logs` tab.
    this.logManager = new LogManager();
    ctx.logs = this.logManager;
    // Temporary seed entry so the logs tab isn't blank on first load
    // — remove once real game event sources (card spawns, recipe
    // completions, etc.) push their own entries.
    this.logManager.push("Entered the world.");

    // WorldPanManager listens on the InputManager — must come after it.
    // Doesn't need ctx-binding (no consumers reach for the pan
    // controller through GameContext); the GameScene owns it
    // directly and disposes it on exit.
    this.worldPanManager = new WorldPanManager(ctx, this.gameLayout.worldView);

    // Pan to the soul's world position as soon as the soul row is
    // available. SoulManager.on fires immediately (synchronously) if
    // the soul is already present, so we check soulPanDone before
    // deciding whether to keep the subscription open.
    let soulPanDone = false;
    const unsubSoulPan = ctx.souls.on((soul) => {
      if (!soul || soulPanDone) return;
      soulPanDone = true;
      this.recenterOnSoul(ctx);
    });
    this.releaseSoulPan = soulPanDone ? null : unsubSoulPan;
    if (soulPanDone) unsubSoulPan();

    this.particleManager = new ParticleManager();
    void this.particleManager.init();

    this.releaseCards = ctx.zones.ensure(inventoryZoneId);
    const releaseKeyDown = this.inputManager.onKey("key_down", ({ code }) => {
      if (code === "KeyE") {
        this.gameInventory.snapToGrid();
        this.gameLayout.inventoryView.showGrid(true);
      } else if (code === "Space") {
        this.recenterOnSoul(ctx);
      }
    });
    const releaseKeyUp = this.inputManager.onKey("key_up", ({ code }) => {
      if (code === "KeyE") this.gameLayout.inventoryView.showGrid(false);
    });
    const releaseDetailsClick = this.inputManager.on("left_click", (data) => {
      const hit = data.up.hit;
      if (hit instanceof LayoutCard) {
        this.gameLayout.detailsPanel.show(hit.cardId, ctx);
        return;
      }
      if (!this.gameLayout.detailsPanel.handleClick(hit)) {
        this.gameLayout.detailsPanel.hide();
      }
    });
    this.releaseKeys = () => { releaseKeyDown(); releaseKeyUp(); releaseDetailsClick(); };
  }

  /** Tween the viewport anchor back to the player's soul tile.
   *  Reads the soul's current row from `SoulManager` (set by
   *  `CharacterSelectScene.handlePlay` and kept fresh by the soul
   *  subscription); decodes its `(macro_zone, micro_zone)` into a
   *  world-hex `(q, r)` and hands it to `WorldPanManager.tweenTo`.
   *
   *  No-op when the soul row hasn't landed yet, or when the soul
   *  isn't on a world surface (e.g. in transit between worlds —
   *  not a real case today, but cheap to guard). */
  private recenterOnSoul(ctx: GameContext): void {
    const soul = ctx.souls.getSoul();
    if (!soul) return;
    const { zoneQ, zoneR } = unpackMacroZone(soul.macroZone);
    const { localQ, localR } = unpackMicroZone(soul.microZone);
    this.worldPanManager.tweenTo(zoneQ + localQ, zoneR + localR);
  }

  onExit(): void {
    this.releaseKeys?.();
    this.releaseKeys = null;
    this.releaseCards?.();
    this.releaseCards = null;
    this.releaseSoulPan?.();
    this.releaseSoulPan = null;

    this.particleManager.destroy();
    this.worldPanManager.dispose();
    this.actionManager.dispose();
    this.dragManager.dispose();
    this.inputManager.dispose();
    this.gameManager.dispose();
    this.cardManager.dispose();
    this.logManager.dispose();
    this.gameLayout.destroy();
    this.layoutManager.dispose();

    if (this.ctxRef) {
      this.ctxRef.cards = null;
      this.ctxRef.layout = null;
      this.ctxRef.game = null;
      this.ctxRef.input = null;
      this.ctxRef.actions = null;
      this.ctxRef.logs = null;
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
    this.worldPanManager.update();
    const drawCalls = this.ctxRef?.drawCallCounter.readAndReset() ?? 0;
    this.gameLayout.titleBar.updateStats(deltaMS, drawCalls);
    this.gameLayout.layoutIfDirty();
  }
}
