import { client_cards, observer_id, viewed_id } from "@/spacetime/Data";
import { LayoutRoot } from "@/ui/layout/LayoutRoot";
import { LayoutLayers } from "@/ui/layout/LayoutLayers";
import { LayoutObject } from "@/ui/layout/LayoutObject";
import { LayoutHorizontal, LayoutVertical } from "@/ui/layout/LayoutLinear";
import { InputManager } from "@/ui/input/InputManager";
import { Panel } from "./Panel";
import { World } from "./World";
import { ViewTitle } from "./ViewTitle";
import { FrameRate } from "./FrameRate";
import { Inventory } from "./Inventory";
import { DragManager } from "./DragManager";

/**
 * Top-level game view for a single soul card.
 *
 * viewed_id (from Data) identifies the soul card being observed. On each
 * sync() call, World is centred on that soul's world position and the zone
 * set is reconciled with client_zones.
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
 * Call sync() after any subscription update or when viewed_id changes.
 * sync() should be called after the first tick() so that World's innerRect is
 * valid and centerOnHex produces a correctly centred camera.
 */
export class GameView extends LayoutRoot {
  private readonly _layers:      LayoutLayers;
  private readonly _input:       InputManager;
  private readonly _dragManager: DragManager;
  private readonly _world:       World;
  private readonly _viewTitle:   ViewTitle;
  private readonly _inventory:   Inventory;

  constructor() {
    super();

    this._layers = new LayoutLayers({ layers: ["world", "game", "overlay"] });
    this.addLayoutChild(this._layers);

    const TILE_R  = 70;
    const CARD_W  = TILE_R;
    const CARD_H  = Math.round(TILE_R * 4 / 3);

    this._world = new World({ tileRadius: TILE_R, stackWidth: CARD_W, cardHeight: CARD_H });

    const PAD = 4;

    // ── Left column ──────────────────────────────────────────────────────
    const leftCol = new LayoutVertical();
    leftCol.addItem(new LayoutObject(), { weight: 1 });
    leftCol.addItem(new Panel({ padding: PAD }), { weight: 1 });
    
    // ── Center column ─────────────────────────────────────────────────────
    const centerCol = new LayoutVertical();
    centerCol.addItem(new LayoutObject(),          { weight: 4 });
    centerCol.addItem(new Panel({ padding: PAD }), { weight: 1 });

    // ── Right column ───────────────────────────────────────────────────────
    this._inventory = new Inventory({ observer_id, viewed_id, card_types: [1, 2, 3, 4], stackWidth: CARD_W, cardHeight: CARD_H });
    const inventoryPanel = new Panel({ padding: PAD });
    inventoryPanel.addLayoutChild(this._inventory);

    const rightCol = new LayoutVertical();
    rightCol.addItem(new Panel({ padding: PAD }), { weight: 1 });
    rightCol.addItem(inventoryPanel,              { weight: 2 });

    // ── Main row ──────────────────────────────────────────────────────────
    const mainRow = new LayoutHorizontal();
    mainRow.addItem(leftCol,  { weight: 2 });
    mainRow.addItem(centerCol, { weight: 5 });
    mainRow.addItem(rightCol,   { weight: 3 });

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

    // ── Input & drag overlay ──────────────────────────────────────────────
    this._input = new InputManager(this);

    this._world.setInput(this._input);

    this._dragManager = new DragManager({
      input:      this._input,
      stackWidth: CARD_W,
      cardHeight: CARD_H,
    });
    this._layers.add(this._dragManager, "overlay");
  }

  override destroy(options?: Parameters<LayoutRoot["destroy"]>[0]): void {
    this._input.destroy();
    super.destroy(options);
  }

  // ─── Sync ────────────────────────────────────────────────────────────────

  /**
   * Reconcile the World with the current viewed_id and client data.
   * Resolves the soul's z layer and world position, syncs zones, and recentres
   * the camera.  Best called after the first tick() so innerRect is valid.
   */
  sync(): void {
    const soul = client_cards[viewed_id];

    if (soul) {
      this._world.setZ(soul.z);
      this._world.syncZones();
      this._world.centerOnHex(soul.world_q, soul.world_r);
    } else {
      this._world.syncZones();
    }
    this._viewTitle.sync();
    this._inventory.invalidateLayout();
  }

  getWorld(): World { return this._world; }
}
