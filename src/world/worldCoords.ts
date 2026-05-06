import type { Zone } from "../server/bindings/types";
import { DefinitionManager, type CardDefinition } from "../definitions/DefinitionManager";
import { debug } from "../debug";

/**
 * Each Zone covers an 8×8 block of hex positions.
 * Within a zone, t_index (0-7) maps to local_r (row), and byte_index (0-7)
 * within that u64 maps to local_q (column). Row-major: t[r][q].
 */
export const ZONE_SIZE = 8;

/** Pointy-top hex tile: distance from center to corner, in pixels. */
export const TILE_SIZE = 80;

/**
 * Layer value for world zones. World ZoneIds are packed as
 * packZoneId(macroZone, WORLD_LAYER). Inventory/card zones use layer < 64.
 */
export const WORLD_LAYER = 64;

// Server packs macro_zone as: ((zone_q as i16 as u16) << 16) | (zone_r as i16 as u16)
// where zone_q/zone_r are the chunk indices (signed, not biased).
// zoneQ/zoneR parameters here are tile origins (multiples of ZONE_SIZE).

export function packMacroZone(zoneQ: number, zoneR: number): number {
  const chunkQ = Math.floor(zoneQ / ZONE_SIZE);
  const chunkR = Math.floor(zoneR / ZONE_SIZE);
  return (((chunkQ & 0xFFFF) << 16) | (chunkR & 0xFFFF)) >>> 0;
}

export function unpackMacroZone(macroZone: number): { zoneQ: number; zoneR: number } {
  const rawQ = (macroZone >>> 16) & 0xFFFF;
  const rawR = macroZone & 0xFFFF;
  const chunkQ = rawQ >= 0x8000 ? rawQ - 0x10000 : rawQ;
  const chunkR = rawR >= 0x8000 ? rawR - 0x10000 : rawR;
  return { zoneQ: chunkQ * ZONE_SIZE, zoneR: chunkR * ZONE_SIZE };
}

/** Extract a tile byte at `byteIndex` (0-7) from a u64 t-field (BigInt). The
 *  byte itself packs `definition_id:u5` (low 5 bits) + `height:u3` (high 3
 *  bits); use `getTileDefId` / `getTileHeight` to split. */
function extractTByte(t: bigint, byteIndex: number): number {
  return Number((t >> BigInt(byteIndex * 8)) & 0xFFn);
}

const TILE_DEF_MASK     = 0x1F;
const TILE_HEIGHT_SHIFT = 5;

/** Tile definition_id (u5, 0..31). `0` means the slot is empty. */
export function getTileDefId(tileByte: number): number {
  return tileByte & TILE_DEF_MASK;
}

/** Tile height (u3, 0..7). Stacked above the base hex level. */
export function getTileHeight(tileByte: number): number {
  return (tileByte >>> TILE_HEIGHT_SHIFT) & 0x07;
}

export interface ZoneTile {
  q: number;
  r: number;
  height: number;
  definition: CardDefinition;
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
  const { zoneQ, zoneR } = unpackMacroZone(zone.macroZone);
  const typeId     = (zone.packedDefinition >> 4) & 0xF;
  const categoryId =  zone.packedDefinition       & 0xF;
  const ts: bigint[] = [zone.t0, zone.t1, zone.t2, zone.t3,
                        zone.t4, zone.t5, zone.t6, zone.t7];

  debug.log(["zone"],
    `[decodeZoneTiles] macroZone=${zone.macroZone} → zoneQ=${zoneQ} zoneR=${zoneR}` +
    ` packedDef=0x${zone.packedDefinition.toString(16).padStart(2,"0")}` +
    ` typeId=${typeId} categoryId=${categoryId}` +
    ` t=[${ts.map(t => "0x" + t.toString(16)).join(", ")}]`,
  );

  const result: ZoneTile[] = [];
  let missCount = 0;
  for (let tIndex = 0; tIndex < 8; tIndex++) {
    const t = ts[tIndex];
    if (t === 0n) continue;
    for (let byteIndex = 0; byteIndex < 8; byteIndex++) {
      const tileByte = extractTByte(t, byteIndex);
      const definitionId = getTileDefId(tileByte);
      if (definitionId === 0) continue;
      const height = getTileHeight(tileByte);
      const packed = DefinitionManager.pack(typeId, categoryId, definitionId);
      const def = definitions.decode(packed);
      if (!def) {
        debug.warn(["zone"],
          `[decodeZoneTiles] no def for packed=0x${packed.toString(16)}` +
          ` (typeId=${typeId} categoryId=${categoryId} definitionId=${definitionId})` +
          ` at tIndex=${tIndex} byteIndex=${byteIndex} height=${height}`,
        );
        missCount++;
        continue;
      }
      result.push({ q: zoneQ + byteIndex, r: zoneR + tIndex, height, definition: def });
    }
  }

  debug.log(["zone"], `[decodeZoneTiles] → ${result.length} tiles decoded, ${missCount} definition misses`);
  return result;
}

/**
 * All zone origins (multiples of ZONE_SIZE) that cover the hex area within
 * `radius` zone-rings of anchor hex position (aq, ar).
 */
export function zonesAroundAnchor(
  aq: number,
  ar: number,
  radius: number,
): { zoneQ: number; zoneR: number }[] {
  const centerChunkQ = Math.floor(aq / ZONE_SIZE);
  const centerChunkR = Math.floor(ar / ZONE_SIZE);
  const results: { zoneQ: number; zoneR: number }[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const r1 = Math.max(-radius, -dq - radius);
    const r2 = Math.min(radius, -dq + radius);
    for (let dr = r1; dr <= r2; dr++) {
      results.push({
        zoneQ: (centerChunkQ + dq) * ZONE_SIZE,
        zoneR: (centerChunkR + dr) * ZONE_SIZE,
      });
    }
  }
  return results;
}
