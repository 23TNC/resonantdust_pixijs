/** Packing helpers for SpacetimeDB row keys, zone IDs, and card-row
 *  bit-packed fields.
 *
 *  Encoding schemes here all match the server's wire format:
 *
 *  1. **Valid-at u64 row keys.** Every server table uses a u64 primary key
 *     whose high 32 bits hold the row's id (e.g. `card_id`, `zone_id`) and
 *     whose low 32 bits hold the absolute-second unix timestamp at which
 *     the row becomes valid. Multiple rows per id can coexist; the client
 *     picks the row whose valid_at is the largest one that has elapsed.
 *
 *  2. **`ZoneId` = `macroZone * 256 + layer`** packed as a JS `number`
 *     (40 bits, well inside safe-integer range). World zones use
 *     `WORLD_LAYER`; inventory/card zones use `layer < 64`.
 *
 *  3. **`macroZone` = `(chunkQ << 16) | chunkR`** packed as a u32, where
 *     each chunk is `ZONE_SIZE` × `ZONE_SIZE` hexes wide. Q/R are signed
 *     16-bit; the unpack restores the sign.
 *
 *  4. **`microZone` u8 — TWO INTERPRETATIONS, gated on (state, surface):**
 *
 *     - **Stack layout** — `state ∈ {STACKED_ON_RECT_X, STACKED_ON_RECT_Y}`
 *       AND `surface < 64`:
 *       ```
 *       [position: u5 | force_flag: u1 | stackedState: u2]
 *       ```
 *       `position` is the card's 1-indexed place in its chain from the
 *       root (`1..31`; `0` reserved). `force_flag = 1` means the server
 *       is forcing this position; the client mirror takes the server's
 *       position verbatim and bumps any client-only cards in the same
 *       `(root_id, direction)` group whose position ≥ the forced one.
 *
 *     - **Legacy layout** — everything else (`Free`, `OnHex`, world
 *       surfaces ≥ 64):
 *       ```
 *       [localQ: u3 | localR: u3 | stackedState: u2]
 *       ```
 *       The legacy `localQ === 0` rule on inventory-loose cards still
 *       gates the client-owns-position preserve; see `mirrorCard`.
 *
 *  5. **`microLocation` u32 — interpretation depends on stackedState:**
 *
 *     - `Free`                    → encoded `(x: i16, y: i16)` loose XY
 *     - `STACKED_ON_RECT_X / _Y`  → ROOT card_id of the rect chain
 *     - `STACKED_ON_HEX`          → parent hex card_id (walk up via
 *                                    microLocation; hex chains aren't
 *                                    migrated to the (root_id, position)
 *                                    model)
 *
 *  Rect chains use the new `(root_id, position)` model; hex chains keep
 *  parent-pointer walking. Rect-on-hex must be a leaf — no rect chain
 *  hangs off it. See `docs/STACK_LAYOUT_MIGRATION.md` for the migration
 *  history. */

const SHIFT = 32n;
const LOW32 = 0xffffffffn;

/** Packed `(id, validAt)` matching the server's u64 primary key. */
export type ValidAt = bigint;

export function packValidAt(id: number, validAtSeconds: number): ValidAt {
  return (BigInt(id) << SHIFT) | (BigInt(validAtSeconds) & LOW32);
}

export function unpackValidAt(packed: ValidAt): {
  id: number;
  validAt: number;
} {
  return {
    id: Number(packed >> SHIFT),
    validAt: Number(packed & LOW32),
  };
}

export function idOf(packed: ValidAt): number {
  return Number(packed >> SHIFT);
}

export function validAtOf(packed: ValidAt): number {
  return Number(packed & LOW32);
}

const LAYER_RANGE = 256;

/** Packed `(macroZone: u32, layer: u8)` zone identifier. */
export type ZoneId = number;

/** Layer value for world zones. World ZoneIds are
 *  `packZoneId(macroZone, WORLD_LAYER)`; inventory/card zones use
 *  `layer < 64`. */
export const WORLD_LAYER = 64;

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

/** Each macroZone covers an 8×8 block of hex positions. */
export const ZONE_SIZE = 8;

/** Pack `(zoneQ, zoneR)` tile origins (multiples of `ZONE_SIZE`) into a
 *  u32 macroZone. Server format: `((chunkQ as i16 as u16) << 16) | (chunkR
 *  as i16 as u16)`, where `chunkQ = zoneQ / ZONE_SIZE`. */
export function packMacroZone(zoneQ: number, zoneR: number): number {
  const chunkQ = Math.floor(zoneQ / ZONE_SIZE);
  const chunkR = Math.floor(zoneR / ZONE_SIZE);
  return (((chunkQ & 0xffff) << 16) | (chunkR & 0xffff)) >>> 0;
}

export function unpackMacroZone(macroZone: number): {
  zoneQ: number;
  zoneR: number;
} {
  const rawQ = (macroZone >>> 16) & 0xffff;
  const rawR = macroZone & 0xffff;
  const chunkQ = rawQ >= 0x8000 ? rawQ - 0x10000 : rawQ;
  const chunkR = rawR >= 0x8000 ? rawR - 0x10000 : rawR;
  return { zoneQ: chunkQ * ZONE_SIZE, zoneR: chunkR * ZONE_SIZE };
}

/** Pack `(localQ, localR, stackedState)` into a u8 microZone under the
 *  **legacy** layout. `localQ` / `localR` are 0..7 (in-chunk hex coord),
 *  `stackedState` is 0..3. Use this for `Free` / `OnHex` cards or any
 *  card on a world surface (`surface >= WORLD_LAYER`); rect-stacked
 *  cards in inventory use [`packStackMicroZone`] instead. */
export function packMicroZone(
  localQ: number,
  localR: number,
  stackedState: number,
): number {
  return ((localQ & 0x7) << 5) | ((localR & 0x7) << 2) | (stackedState & 0x3);
}

/** Inverse of [`packMicroZone`]; legacy layout. */
export function unpackMicroZone(microZone: number): {
  localQ: number;
  localR: number;
  stackedState: number;
} {
  return {
    localQ: (microZone >> 5) & 0x7,
    localR: (microZone >> 2) & 0x7,
    stackedState: microZone & 0x3,
  };
}

/** Pack `(position, forceFlag, stackedState)` into a u8 microZone under
 *  the **stack** layout (`[position: u5 | forceFlag: u1 | state: u2]`).
 *
 *  `position` is the card's 1-indexed place in its chain from the root
 *  (saturates at 31). `forceFlag = true` means the server is forcing
 *  this position — the client mirror takes the server's position verbatim
 *  and renumbers any conflicting client-only cards in the same chain.
 *
 *  Only valid for `stackedState ∈ {STACKED_ON_RECT_X, STACKED_ON_RECT_Y}`
 *  and `surface < WORLD_LAYER`. Use [`packMicroZone`] for everything
 *  else. */
export function packStackMicroZone(
  position: number,
  forceFlag: boolean,
  stackedState: number,
): number {
  const pos = position & 0x1f;
  const flag = forceFlag ? 1 : 0;
  return (pos << 3) | (flag << 2) | (stackedState & 0x3);
}

/** Inverse of [`packStackMicroZone`]. The caller is responsible for
 *  knowing the byte was packed under the stack layout — reading a
 *  legacy-layout byte through here gives nonsense for `position` and
 *  `forceFlag`. Use [`isStackLayout`] to dispatch. */
export function unpackStackMicroZone(microZone: number): {
  position: number;
  forceFlag: boolean;
  stackedState: number;
} {
  return {
    position: (microZone >> 3) & 0x1f,
    forceFlag: ((microZone >> 2) & 0x1) !== 0,
    stackedState: microZone & 0x3,
  };
}

/** Whether the **stack layout** applies to this `(state, surface)` pair.
 *  True iff the card is rect-stacked on inventory (state is
 *  `STACKED_ON_RECT_X` or `STACKED_ON_RECT_Y` AND `surface < WORLD_LAYER`).
 *  False for loose / on-hex / world-surface cards — those keep the legacy
 *  `(localQ, localR)` layout. */
export function isStackLayout(stackedState: number, surface: number): boolean {
  return surface < WORLD_LAYER && (stackedState === 1 || stackedState === 2);
}
