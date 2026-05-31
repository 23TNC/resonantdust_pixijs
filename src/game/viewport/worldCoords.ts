import type { Zone } from "../../server/spacetime/bindings/types";
import { DefinitionManager, type CardDefinition } from "../definitions/DefinitionManager";
import { debug } from "../../debug";

/**
 * Each Zone covers an 8×8 block of hex positions.
 * Within a zone, t_index (0-7) maps to local_r (row), and byte_index (0-7)
 * within that u64 maps to local_q (column). Row-major: t[r][q].
 */
export const ZONE_SIZE = 8;

/** Pointy-top hex tile: distance from center to corner, in pixels. */
export const TILE_SIZE = 80;

/** `WORLD_LAYER` is a server-protocol constant — its canonical home is
 *  `server/data/packing`. Re-exported here for game-code callers that
 *  already import other world-coord helpers from this module. */
export { WORLD_LAYER } from "../../server/data/packing";
import { WORLD_LAYER } from "../../server/data/packing";
import type { ZoneId } from "../../server/data/packing";

// A row's decoded `macroZone: MacroZone` already carries the tile-origin
// coords (`zoneQ` / `zoneR`) and the packed `bigint` key — read them directly;
// pack/unpack helpers are no longer needed here. See `server/data/packing.ts`.

/** Number of u64 tile-data fields on a `Zone` row. Mirrors
 *  `ZONE_TILE_U64_COUNT` in `content/src/packed.rs`. */
const ZONE_TILE_U64_COUNT = 16;

/** Bits per tile in the packed zone storage. 64 tiles × 16 bits =
 *  1024 bits = 16 u64. Per-tile layout:
 *  `[ def_id:u12 | stock0:u2 | stock1:u2 ]`. */
const ZONE_TILE_BITS = 16;

/** Maximum stock value per slot — 2 bits = `0x3`. Mirrors
 *  `ZONE_TILE_STOCK_MAX` in `content/src/packed.rs`. */
export const ZONE_TILE_STOCK_MAX = 0x3;

/** Decoded tile slot: def_id plus the two row-mutable stock counters.
 *  Stock semantics live in [docs/TILE_ASPECTS.md] — each slot is a
 *  u2 counter for the aspect declared at the same index of the tile
 *  def's `stock` block. */
export interface TileSlot {
  defId: number;
  stock0: number;
  stock1: number;
}

/** Read tile `idx` (0..64) from the zone's 16-u64 packed tile array.
 *  Each u64 holds 4 contiguous u16 tile slots; no slot straddles a
 *  u64 boundary. Mirrors `tile_full` in `content/src/packed.rs`. */
function tileAt(packed: readonly bigint[], idx: number): TileSlot {
  const u64Idx = idx >> 2;
  const bitOffset = (idx & 0x3) * 16;
  const slot = Number((packed[u64Idx] >> BigInt(bitOffset)) & 0xFFFFn);
  return {
    defId: slot & 0x0FFF,
    stock0: (slot >> 12) & 0x3,
    stock1: (slot >> 14) & 0x3,
  };
}

/** Collect the 16 u64 tile-data fields on a `Zone` row into a flat
 *  array suitable for [`tileAt`]. */
function zoneTilesArray(zone: Zone): bigint[] {
  return [
    zone.t0, zone.t1, zone.t2, zone.t3,
    zone.t4, zone.t5, zone.t6, zone.t7,
    zone.t8, zone.t9, zone.t10, zone.t11,
    zone.t12, zone.t13, zone.t14, zone.t15,
  ];
}

export interface ZoneTile {
  q: number;
  r: number;
  definition: CardDefinition;
  /** Packed `(typeId, categoryId, definitionId)` — recomputed alongside
   *  the definition lookup so callers (LayoutWorld) can pass it to
   *  `TextureManager.getHexTexture(def, packed)` without re-packing. */
  packed: number;
  /** Row-mutable stock counters for the two aspect slots declared by
   *  the tile def. Both fall in `0..=ZONE_TILE_STOCK_MAX`. Renderers
   *  use these to vary object instances per remaining stock; matchers
   *  read them as the row value for `Entity::Aspect`. */
  stock0: number;
  stock1: number;
}

/**
 * Decode all non-empty tile slots in a zone row into world-absolute hex
 * positions paired with their CardDefinition. Slots with definition_id = 0
 * are empty and skipped.
 */
export function decodeZoneTiles(
  zone: Zone,
  definitions: DefinitionManager,
): ZoneTile[] {
  const { zoneQ, zoneR } = zone.macroZone;
  // `zone.packedDefinition` is u8 = `[card_type:u4 | 0:u4]` after the
  // category retire. Top nibble is the type; low nibble is reserved
  // (always 0). See docs/CATEGORY_RETIRE_AND_TILE_EXPAND.md.
  const typeId = (zone.packedDefinition >> 4) & 0xF;
  const ts = zoneTilesArray(zone);

  debug.log(["zone"],
    `[decodeZoneTiles] macroZone=${zone.macroZone.packed} → zoneQ=${zoneQ} zoneR=${zoneR}` +
    ` packedDef=0x${zone.packedDefinition.toString(16).padStart(2,"0")}` +
    ` typeId=${typeId}` +
    ` t=[${ts.map(t => "0x" + t.toString(16)).join(", ")}]`,
  );

  const result: ZoneTile[] = [];
  let missCount = 0;
  // 64 tiles, row-major. Row index = tile/8, column index = tile%8.
  for (let i = 0; i < 64; i++) {
    const slot = tileAt(ts, i);
    if (slot.defId === 0) continue;
    const row = Math.floor(i / 8);
    const col = i % 8;
    const packed = DefinitionManager.pack(typeId, slot.defId);
    const def = definitions.decode(packed);
    if (!def) {
      debug.warn(["zone"],
        `[decodeZoneTiles] no def for packed=0x${packed.toString(16)}` +
        ` (typeId=${typeId} definitionId=${slot.defId})` +
        ` at row=${row} col=${col}`,
      );
      missCount++;
      continue;
    }
    result.push({
      q: zoneQ + col,
      r: zoneR + row,
      definition: def,
      packed,
      stock0: slot.stock0,
      stock1: slot.stock1,
    });
  }

  debug.log(["zone"], `[decodeZoneTiles] → ${result.length} tiles decoded, ${missCount} definition misses`);
  return result;
}

/**
 * Pull a single tile's packed definition from the zone row covering
 * `macro_zone`, at the local `(localQ, localR)` within that zone.
 *
 * Returns `0` when no zone row matches (subscription gap, off-map
 * coords), the zone's tile byte at that position is `0` (empty slot),
 * or the local coords are out of range. Callers should treat `0` as
 * "no tile here" — same convention as `EMPTY_TILE_PACKED` rendering.
 *
 * The packing is the inverse of `decodeZoneTiles`'s per-tile loop:
 *
 *   typeId       = (zone.packedDefinition >> 4) & 0xF
 *   definitionId = tileAt(zone.t0..t15, localR * 8 + localQ).defId   // u12
 *   result       = DefinitionManager.pack(typeId, definitionId)
 *
 * Used by `ActionManager.evaluateRoot` to resolve the hex tier for a
 * chain rooted at a state-3 card with no hex-Card parent — the recipe
 * matcher needs the tile's def even when no Card row exists at that
 * position.
 */
export function getZoneTileDef(
  zonesLocal: ReadonlyMap<number, Zone>,
  macroZone: ZoneId,
  localQ: number,
  localR: number,
): number {
  return getZoneTileSlot(zonesLocal, macroZone, localQ, localR).packed;
}

/**
 * Variant of [`getZoneTileDef`] that also returns the tile's two
 * row-mutable stock counters. Used by the recipe matcher to evaluate
 * `Entity::Aspect` predicates against the per-tile row value rather
 * than the def's static aspect map — see `docs/TILE_ASPECTS.md` §
 * "Recipe matching". `packed === 0` means "no tile here" (same
 * conditions as `getZoneTileDef`'s `0` return); `stock0` / `stock1`
 * are `0` in that case but callers should typically pass them as
 * `null` (no stock signal) to the matcher rather than `(0, 0)`,
 * which the matcher would interpret as "this tile has depleted
 * stock" and reject any non-zero `aspect.min` predicate.
 */
export function getZoneTileSlot(
  zonesLocal: ReadonlyMap<number, Zone>,
  macroZone: ZoneId,
  localQ: number,
  localR: number,
): { packed: number; stock0: number; stock1: number } {
  if (localQ < 0 || localQ > 7 || localR < 0 || localR > 7) {
    return { packed: 0, stock0: 0, stock1: 0 };
  }
  for (const zone of zonesLocal.values()) {
    if (zone.macroZone.packed !== macroZone) continue;
    // Skip surfaces with no tile bitfield (the inventory layer). Only
    // WORLD_LAYER (64+) is tile-bearing today.
    if (zone.macroZone.surface < WORLD_LAYER) continue;
    const typeId = (zone.packedDefinition >> 4) & 0xF;
    const slot = tileAt(zoneTilesArray(zone), localR * 8 + localQ);
    if (slot.defId === 0) return { packed: 0, stock0: 0, stock1: 0 };
    return {
      packed: DefinitionManager.pack(typeId, slot.defId),
      stock0: slot.stock0,
      stock1: slot.stock1,
    };
  }
  return { packed: 0, stock0: 0, stock1: 0 };
}

/**
 * All zone origins (multiples of ZONE_SIZE) in the square (Chebyshev) block of
 * `distance` chunk-rings around anchor hex position (aq, ar) — a `(2·distance+1)²`
 * set of chunks. Matches the rectangular viewport better than a hex disc; the
 * hex shear (a screen rect maps to a sheared chunk parallelogram) is absorbed by
 * holding whole rings. `distance` 0 = just the anchor's chunk.
 */
export function chunksAroundAnchor(
  aq: number,
  ar: number,
  distance: number,
): { zoneQ: number; zoneR: number }[] {
  const centerChunkQ = Math.floor(aq / ZONE_SIZE);
  const centerChunkR = Math.floor(ar / ZONE_SIZE);
  const results: { zoneQ: number; zoneR: number }[] = [];
  for (let dq = -distance; dq <= distance; dq++) {
    for (let dr = -distance; dr <= distance; dr++) {
      results.push({
        zoneQ: (centerChunkQ + dq) * ZONE_SIZE,
        zoneR: (centerChunkR + dr) * ZONE_SIZE,
      });
    }
  }
  return results;
}
