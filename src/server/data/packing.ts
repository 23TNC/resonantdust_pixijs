/** Packing helpers for SpacetimeDB row keys, zone IDs, and card-row
 *  bit-packed fields.
 *
 *  Encoding schemes here all match the server's wire format:
 *
 *  1. **Valid-at u64 row keys.** Every server table uses a u64 primary key
 *     whose high 48 bits hold the row's absolute-millisecond unix
 *     timestamp at which the row becomes valid, and whose low 16 bits
 *     hold an opaque global sequence number that disambiguates
 *     same-millisecond writes. The row's logical id (`card_id`,
 *     `zone_id`, `player_id`) lives on a separate column and should
 *     be read from there — not derived from the key. Multiple rows
 *     per id can coexist; the client picks the row whose validAt is
 *     the largest one that has elapsed.
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
 *     - **Stack layout** — `state == STACKED_ON_ROOT` AND `surface < 64`:
 *       ```
 *       [position: u5 | direction: u1 | stackedState: u2]
 *       ```
 *       `position` is the card's 1-indexed place in its chain from the
 *       root (`1..31`; `0` reserved). `direction` is `0 = up / top` or
 *       `1 = down / bottom`. The "server is forcing this position"
 *       signal moved out of `microZone` and lives in `flags`
 *       (`force_position` at bit 11) — see `content/cards/flags.json`.
 *
 *     - **Legacy layout** — everything else (`Free`, state-1 reserved,
 *       `OnHex`, world surfaces ≥ 64):
 *       ```
 *       [localQ: u3 | localR: u3 | stackedState: u2]
 *       ```
 *       The legacy `localQ === 0` rule on inventory-loose cards still
 *       gates the client-owns-position preserve; see `mirrorCard`.
 *
 *  5. **`microLocation` u32 — interpretation depends on stackedState:**
 *
 *     - `STACKED_LOOSE`   → encoded `(x: i16, y: i16)` loose XY
 *     - state value 1     → RESERVED for an upcoming slot-pinning mode
 *                            (microLocation will hold the immediate parent
 *                            card_id, not the root). Unused today.
 *     - `STACKED_ON_ROOT` → ROOT card_id of the rect chain
 *     - `STACKED_ON_HEX`  → parent hex card_id (walk up via
 *                            microLocation; hex chains aren't migrated
 *                            to the (root_id, position) model)
 *
 *  Rect chains use the `(root_id, position, direction)` model; hex
 *  chains keep parent-pointer walking. Rect-on-hex must be a leaf — no
 *  rect chain hangs off it. See `docs/STACK_LAYOUT_MIGRATION.md`. */

const SEQ_SHIFT = 16n;
const SEQ_MASK = 0xffffn;

/** Packed `(time_ms_u48 << 16) | sequence_u16` matching the server's
 *  u64 primary key. */
export type ValidAt = bigint;

/** Pack a `validAtMs` (u48) + `sequence` (u16) into the u64 PK. The
 *  client mostly only reads this — the only writer is tests / mocks. */
export function packValidAt(validAtMs: number, sequence: number): ValidAt {
  return (BigInt(validAtMs) << SEQ_SHIFT) | (BigInt(sequence) & SEQ_MASK);
}

/** Extract the row's `validAt` (in absolute unix milliseconds) from
 *  the packed u64 PK. The sequence portion is opaque and discarded. */
export function validAtOf(packed: ValidAt): number {
  return Number(packed >> SEQ_SHIFT);
}

const LAYER_RANGE = 256;

/** Packed `(macroZone: u32, layer: u8)` zone identifier. */
export type ZoneId = number;

/** Layer value for world zones. World ZoneIds are
 *  `packZoneId(macroZone, WORLD_LAYER)`; inventory/card zones use
 *  `layer < 64`. */
export const WORLD_LAYER = 64;

/** Surface band for a deployed mini_zone's contents — its `Zone`
 *  tile bytes plus any cards placed on its tiles. The anchor card
 *  lives at `surface == WORLD_LAYER`; its `card_id` is the
 *  `macro_zone` value used by the mini_zone's `Zone` row and by
 *  any cards on its tiles. Mirrors the server-side constant in
 *  `spacetime/server/spacetimedb/src/packed.rs`. */
export const MINI_ZONE_LAYER = 63;

/** Surface band for a pocket dimension — a private interior
 *  carried by an anchor card. `macro_zone` is the anchor's
 *  `card_id`, same convention as `MINI_ZONE_LAYER`. */
export const POCKET_DIMENSION_LAYER = 32;

/** Surface band for player inventory. `macro_zone` is the owning
 *  soul card's `card_id`. */
export const INVENTORY_LAYER = 1;

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

/** Pack `(position, direction, stackedState)` into a u8 microZone under
 *  the **stack** layout (`[position: u5 | direction: u1 | state: u2]`).
 *
 *  `position` is the card's 1-indexed place in its chain from the root
 *  (saturates at 31). `direction` is `0 = up / top` or `1 = down /
 *  bottom`. The "server is forcing this position" signal moved out of
 *  microZone and now lives in `flags` (`force_position` bit 11) — set
 *  / clear that bit on `Card.flags` instead.
 *
 *  Only valid for `stackedState == STACKED_ON_ROOT` (= 2) and
 *  `surface < WORLD_LAYER`. Use [`packMicroZone`] for everything else. */
export function packStackMicroZone(
  position: number,
  direction: number,
  stackedState: number,
): number {
  const pos = position & 0x1f;
  const dir = direction & 0x1;
  return (pos << 3) | (dir << 2) | (stackedState & 0x3);
}

/** Inverse of [`packStackMicroZone`]. The caller is responsible for
 *  knowing the byte was packed under the stack layout — reading a
 *  legacy-layout byte through here gives nonsense for `position` and
 *  `direction`. Use [`isStackLayout`] to dispatch. */
export function unpackStackMicroZone(microZone: number): {
  position: number;
  direction: number;
  stackedState: number;
} {
  return {
    position: (microZone >> 3) & 0x1f,
    direction: (microZone >> 2) & 0x1,
    stackedState: microZone & 0x3,
  };
}

/** Whether the **stack layout** applies to this `(state, surface)` pair.
 *  True iff the card is rect-stacked on inventory (state is
 *  `STACKED_ON_ROOT` AND `surface < WORLD_LAYER`). False for loose /
 *  on-hex / world-surface cards — those keep the legacy `(localQ,
 *  localR)` layout. `STACKED_SLOT` (state 1) has its own preserve
 *  branch in `mirrorCard` (same `force_position` gate as stack
 *  layout); it doesn't go through this discriminator. */
export function isStackLayout(stackedState: number, surface: number): boolean {
  return surface < WORLD_LAYER && stackedState === 2;
}

/** Pack a `microZone` byte for a `STACKED_SLOT` row (parent-pointer
 *  mode). Layout matches the stack layout
 *  (`[position: u5 | direction: u1 | state: u2]`) but with `position
 *  = 0` since position from root is implicit (walk parent pointers
 *  via `microLocation`). Direction is stored explicitly so chain
 *  walks and parent-resolves don't have to climb to derive it.
 *
 *  Server-only — the client never writes Slot rows. Provided here
 *  for symmetry with `packStackMicroZone` and so the bit layout has
 *  one canonical implementation. */
export function packSlotMicroZone(direction: number): number {
  const dir = direction & 0x1;
  return (dir << 2) | 0x1; // state value 1 = STACKED_SLOT
}
