export type ZoneId = number;

const LAYER_RANGE = 256;

/**
 * Packs `(macroZone: u32, layer: u8)` into a single `ZoneId`:
 *
 *   zoneId = macroZone * 256 + layer
 *
 * Equivalent to `macroZone << 8 | layer` but written with `*` / `%` so
 * macroZone values above `2 ** 23` survive (JS bitwise ops are 32-bit signed).
 * Result fits in 40 bits — well inside the 53-bit safe-integer range.
 */
export function packZoneId(macroZone: number, layer: number): ZoneId {
  return macroZone * LAYER_RANGE + (layer % LAYER_RANGE);
}

export function unpackZoneId(zoneId: ZoneId): {
  macroZone: number;
  layer: number;
} {
  return {
    macroZone: Math.floor(zoneId / LAYER_RANGE),
    layer: zoneId % LAYER_RANGE,
  };
}
