import { client_cards, viewed_id } from "@/spacetime/Data";
import { LayoutRoot } from "@/ui/layout/LayoutRoot";
import { LayoutHorizontal, LayoutVertical } from "@/ui/layout/LayoutLinear";
import { Panel } from "./Panel";
import { World } from "./World";

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
 *   │           │       World         │           │  weight 4
 *   │  weight 2 │                     │  weight 2 │
 *   │           ├─────────────────────┤           │
 *   │           │                     │           │  weight 1
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
  private readonly _world: World;

  constructor() {
    super();

    this._world = new World({ tileRadius: 24 });

    const PAD = 4;

    // ── Left column ───────────────────────────────────────────────────────
    const leftCol = new LayoutVertical();
    leftCol.addItem(new Panel({ padding: PAD }), { weight: 1 });
    leftCol.addItem(new Panel({ padding: PAD }), { weight: 1 });
    leftCol.addItem(new Panel({ padding: PAD }), { weight: 1 });

    // ── Center column ─────────────────────────────────────────────────────
    const worldPanel = new Panel({ padding: PAD, radius: 0 });
    worldPanel.addLayoutChild(this._world);
    const centerCol = new LayoutVertical();
    centerCol.addItem(worldPanel,              { weight: 4 });
    centerCol.addItem(new Panel({ padding: PAD }), { weight: 1 });

    // ── Right column ──────────────────────────────────────────────────────
    const rightCol = new LayoutVertical();
    rightCol.addItem(new Panel({ padding: PAD }), { weight: 1 });
    rightCol.addItem(new Panel({ padding: PAD }), { weight: 1 });

    // ── Main row ──────────────────────────────────────────────────────────
    const mainRow = new LayoutHorizontal();
    mainRow.addItem(leftCol,   { weight: 2 });
    mainRow.addItem(centerCol, { weight: 5 });
    mainRow.addItem(rightCol,  { weight: 2 });

    // ── Outer column ──────────────────────────────────────────────────────
    const outerCol = new LayoutVertical();
    outerCol.addItem(new Panel({ padding: PAD }), { weight: 1 });
    outerCol.addItem(mainRow,                     { weight: 9 });

    this.addLayoutChild(outerCol);
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
  }

  getWorld(): World { return this._world; }
}
