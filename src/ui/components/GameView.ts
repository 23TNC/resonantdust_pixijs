import { client_cards, observer_id, viewed_id } from "@/spacetime/Data";
import { LayoutRoot } from "@/ui/layout/LayoutRoot";
import { LayoutLayers } from "@/ui/layout/LayoutLayers";
import { LayoutObject } from "@/ui/layout/LayoutObject";
import { LayoutHorizontal, LayoutVertical } from "@/ui/layout/LayoutLinear";
import { InputManager } from "@/ui/input/InputManager";
import { getApp } from "@/app";
import { Panel } from "./Panel";
import { World } from "./World";
import { ViewTitle } from "./ViewTitle";
import { FrameRate } from "./FrameRate";
import { Inventory } from "./Inventory";
import { DragManager } from "./DragManager";
import { ParticleManager } from "@/ui/effects/ParticleManager";

/**
 * Top-level game view for a single soul card.
 *
 * viewed_id (from Data) identifies the soul card being observed.  At
 * construction the World is initialised at the soul's z layer and its zones
 * are synced with client_zones.
 *
 * Layout (weights, not fixed sizes — scales with window):
 *
 *   ┌─────────────────────────────────────────────┐  weight 1  (top bar)
 *   ├───────────┬─────────────────────┬───────────┤
 *   │           │                     │           │
 *   │ Inventory │       World         │           │  weight 4
 *   │  weight 2 │                     │  weight 2 │
 *   │           ├─────────────────────┤           │
 *   ├───────────┤                     │           │  weight 1
 *   │  weight 1 │                     │           │
 *   └───────────┴─────────────────────┴───────────┘
 *     weight 2        weight 5          weight 2
 *                   (center column)
 *
 * Call tick() each frame (add to the PixiJS ticker).
 *
 * Children update reactively from client_cards / client_zones — there is no
 * external sync() entry point.  ViewTitle refreshes on a ticker; Inventory
 * and World re-resolve their displayed sets every layout pass.  The only
 * one-shot action is centerCameraOnViewedSoul(), which the host scene calls
 * after the first tick() so World.innerRect is valid.
 */
export class GameView extends LayoutRoot {
  private readonly _layers:      LayoutLayers;
  private readonly _input:       InputManager;
  private readonly _world:       World;
  private readonly _viewTitle:   ViewTitle;
  private readonly _inventory:   Inventory;
  private readonly _dragManager:        DragManager;
  private readonly _particleManager:    ParticleManager;
  private readonly _boundParticleTick:  (ticker: { deltaMS: number }) => void;

  constructor() {
    super();

    this._layers = new LayoutLayers({ layers: ["world", "game", "overlay"] });
    this.addLayoutChild(this._layers);

    // InputManager is constructed first so child views can subscribe to its
    // events (key_down for Inventory's grid-snap, etc.) at their own
    // construction time.
    this._input = new InputManager(this);

    const TILE_R  = 96;
    const CARD_W  = 72;
    const CARD_H  = Math.round(CARD_W * 4 / 3);
    const TITLE_H = 24;

    const soul = client_cards[viewed_id];
    this._world = new World({
      z:           soul?.layer ?? 1,
      tileRadius:  TILE_R,
      stackWidth:  CARD_W,
      cardHeight:  CARD_H,
      titleHeight: TITLE_H,
    });
    this._world.setInput(this._input);
    this._world.syncZones();

    const PAD = 4;

    // ── Left column ──────────────────────────────────────────────────────
    const leftCol = new LayoutVertical();
    leftCol.addItem(new LayoutObject(), { weight: 1 });
    leftCol.addItem(new Panel({ padding: PAD }), { weight: 1 });
    
    // ── Center column ─────────────────────────────────────────────────────
    const centerCol = new LayoutVertical();
    centerCol.addItem(new LayoutObject(),          { weight: 4 });
    centerCol.addItem(new LayoutObject(), { weight: 1 });

    // ── Right column ───────────────────────────────────────────────────────
    this._inventory = new Inventory({
      observer_id, viewed_id,
      card_types:  [1, 2, 3, 4],
      stackWidth:  CARD_W,
      cardHeight:  CARD_H,
      titleHeight: TITLE_H,
      input:       this._input,
    });
    const inventoryPanel = new Panel({ padding: PAD });
    inventoryPanel.addLayoutChild(this._inventory);

    const rightCol = new LayoutVertical();
    rightCol.addItem(new Panel({ padding: PAD }), { weight: 1 });
    rightCol.addItem(inventoryPanel,              { weight: 5 });

    // ── Main row ──────────────────────────────────────────────────────────
    const mainRow = new LayoutHorizontal();
    mainRow.addItem(inventoryPanel,  { weight: 3});
    mainRow.addItem(centerCol, { weight: 6 });
    mainRow.addItem(leftCol,   { weight: 2 });

    // ── Top bar ───────────────────────────────────────────────────────────
    this._viewTitle = new ViewTitle();
    const topBar = new LayoutHorizontal();
    topBar.addItem(this._viewTitle, { weight: 1 });
    topBar.addItem(new LayoutObject(), { weight: 1 });
    topBar.addItem(new FrameRate(),   { weight: 1 });
    const topPanel = new Panel({ padding: PAD });
    topPanel.addLayoutChild(topBar);

    // ── Outer column ──────────────────────────────────────────────────────
    const outerCol = new LayoutVertical();
    outerCol.addItem(topPanel, { weight: 1 });
    outerCol.addItem(mainRow,  { weight: 19 });

    this._layers.add(this._world, "world");
    this._layers.add(outerCol, "game");

    // ── Drag overlay ──────────────────────────────────────────────────────
    this._dragManager = new DragManager({
      input:       this._input,
      stackWidth:  CARD_W,
      cardHeight:  CARD_H,
      titleHeight: TITLE_H,
    });
    this._layers.add(this._dragManager, "overlay");
    this._dragManager.setInventory(this._inventory);

    this._particleManager   = new ParticleManager();
    this._boundParticleTick = e => this._particleManager.tick(e.deltaMS);
    void this._particleManager.init();
    this._layers.add(this._particleManager, "overlay");
    getApp().ticker.add(this._boundParticleTick, this);
  }

  override destroy(options?: Parameters<LayoutRoot["destroy"]>[0]): void {
    getApp().ticker.remove(this._boundParticleTick, this);
    this._input.destroy();
    super.destroy(options);
  }

  // ─── Camera ──────────────────────────────────────────────────────────────

  /**
   * Pan the world view so the currently-viewed soul is centred. One-shot
   * action — call after the first tick() so World.innerRect is valid, and
   * again whenever you want to recentre (e.g. on viewed_id change).
   */
  centerCameraOnViewedSoul(): void {
    const soul = client_cards[viewed_id];
    if (!soul) return;
    this._world.centerOnHex(soul.world_q, soul.world_r);
  }

  getWorld(): World { return this._world; }
}
