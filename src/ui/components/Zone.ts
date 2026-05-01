import {
  client_cards,
  macro_zone_cards,
  client_zones,
  zoneKey,
  type CardId,
  type MacroZone,
  ZONE_SIZE,
} from "@/spacetime/Data";
import { LayoutHex } from "@/ui/layout/LayoutHex";
import { type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import { Tile } from "./Tile";

export interface ZoneOptions extends LayoutObjectOptions {
  /** Zone macro_zone (packed `[zone_q:i16][zone_r:i16]` u32). */
  zone_id?: MacroZone;
  /** Layer the zone sits on (world layer, e.g. WORLD_LAYER_GROUND). */
  layer?:   number;
}

/**
 * Renders an 8×8 pointy-top hex grid driven by a ClientZone.
 *
 * For each tile at grid position (q, r):
 *   - Hidden                     when tile_definition_ids[r][q] === 0 (empty cell)
 *   - card_id passed to Tile     when a card with the same card_type as the zone
 *                                occupies that local position
 *   - packed definition passed   otherwise (tile_definitions[r][q])
 *
 * Hit testing is handled by LayoutHex.  Non-tile game objects (players,
 * animating cards) that may span zone boundaries are owned by World and
 * hit-tested there before falling through to Zone → Tile.
 *
 * `(layer, zone_id)` jointly identify the ClientZone row.
 */
export class Zone extends LayoutHex {
  private _zone_id: MacroZone;
  private _layer:   number;
  private readonly _tiles: Tile[][];  // [r][q]

  constructor(options: ZoneOptions = {}) {
    super(options);
    this._zone_id = options.zone_id ?? 0;
    this._layer   = options.layer   ?? 0;

    this._tiles = [];
    for (let r = 0; r < ZONE_SIZE; r++) {
      const row: Tile[] = [];
      for (let q = 0; q < ZONE_SIZE; q++) {
        const tile = this.addItem(new Tile(), q, r);
        tile.visible = false;
        row.push(tile);
      }
      this._tiles.push(row);
    }
  }

  // ─── Zone ID ─────────────────────────────────────────────────────────────

  setZoneId(zone_id: MacroZone, layer: number): void {
    if (this._zone_id === zone_id && this._layer === layer) return;
    this._zone_id = zone_id;
    this._layer   = layer;
    this.invalidateRender();
  }

  getZoneId(): MacroZone { return this._zone_id; }
  getLayer():  number    { return this._layer;   }

  // ─── Render ──────────────────────────────────────────────────────────────

  protected override redraw(): void {
    const zone = client_zones.get(zoneKey(this._layer, this._zone_id));

    // Build (local_q, local_r) → card_id for cards whose card_type matches the
    // zone.  These take priority over the default tile definition.
    const cardAtPos = new Map<number, CardId>();
    if (zone) {
      const ids = macro_zone_cards.get(this._zone_id);
      if (ids) {
        for (const card_id of ids) {
          const card = client_cards[card_id];
          if (card && card.layer === this._layer && card.card_type === zone.card_type) {
            cardAtPos.set(card.local_q * ZONE_SIZE + card.local_r, card_id);
          }
        }
      }
    }

    for (let r = 0; r < ZONE_SIZE; r++) {
      for (let q = 0; q < ZONE_SIZE; q++) {
        const tile  = this._tiles[r][q];
        const rawId = zone?.tile_definition_ids[r]?.[q] ?? 0;

        if (rawId === 0) {
          tile.visible = false;
          continue;
        }

        tile.visible = true;
        tile.setCoords(
          zone!.zone_q * ZONE_SIZE + q,
          zone!.zone_r * ZONE_SIZE + r,
        );

        const card_id = cardAtPos.get(q * ZONE_SIZE + r);
        if (card_id !== undefined) {
          tile.setCardId(card_id);
        } else {
          tile.setDefinition(zone!.tile_definitions[r][q]);
        }
      }
    }
  }
}
