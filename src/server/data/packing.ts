/** Packing helpers for SpacetimeDB row keys, zone IDs, and card-row
 *  bit-packed fields.
 *
 *  **Source of truth:** [`content/src/packed.rs`](../../../../content/src/packed.rs).
 *  The same definitions are re-exported into the shard and chat
 *  modules via `pub use resonantdust_content::packed::*;`, and the
 *  individual helpers (`packMacroZone`, `unpackMicroZone`,
 *  `isStackLayout`, `worldLayer`, etc.) are exposed through the
 *  wasm pkg (`content/pkg/resonantdust_content.js`) for cold-path
 *  callers and tests that want the canonical implementation.
 *
 *  The native TS mirrors below exist for **hot-path performance** —
 *  these functions are called per zone decode / card sync, and the
 *  wasm-crossing overhead adds up. If you change any bit layout
 *  here, change the matching helper in
 *  [`content/src/packed.rs`](../../../../content/src/packed.rs) in
 *  the same patch. There is no compile-time drift check; the
 *  discipline is "same file, same PR."
 *
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
 *  2. **`ZoneId` = the full packed `macroZone` u64** held as a `bigint`
 *     (the SDK wire type). It identifies a zone uniquely by owner +
 *     surface + coords; it's `MacroZone.packed`. World zones carry
 *     `WORLD_LAYER` in the surface band; inventory/card zones use a
 *     `surface < 64`.
 *
 *  3. **`macroZone`** = `[owner_card_id:u32 | surface:u8 | chunkQ:i12 | chunkR:i12]`
 *     (high → low), where each chunk is `ZONE_SIZE` × `ZONE_SIZE` hexes wide.
 *     `owner` is bits 32-63 (the owning card_id; `0` = WORLD), `surface` bits
 *     24-31, `chunkQ` bits 12-23, `chunkR` bits 0-11; the two coords are signed
 *     12-bit (±2047), the unpack restores the sign.
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
 *       (`pos_need` / `pos_want` — see `content/cards/flags.json`).
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
 *     - `STACKED_LOOSE`     → encoded `(x: i16, y: i16)` loose XY
 *     - `STACKED_SLOT`      → IMMEDIATE parent's card_id
 *                              (server-written parent-pointer chain)
 *     - `STACKED_ON_ROOT`   → ROOT card_id of the rect chain
 *     - `STACKED_DEFERRED`  → HOST card_id (or 0 if no host) — anchor
 *                              for mirror-time resolution. Fallback
 *                              (q, r) lives in `microZone`. Used by
 *                              recipe outputs like `stack.N.create`.
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

/** Zone identifier — the full packed `macro_zone` u64
 *  `[owner_card_id:u32 | surface:u8 | i12 | i12]`, as a `bigint` (the SDK wire
 *  type). The single value identifies a zone (owner + surface + coords)
 *  uniquely; it's `MacroZone.packed`. */
export type ZoneId = bigint;

/** Surface band for world zones. World `macroZone`s carry `WORLD_LAYER`
 *  in bits 24-31 with owner `0`; inventory/card zones use a `surface < 64`. */
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

/** Surface band for per-soul inventory. `macro_zone` is the
 *  owning soul card's `card_id`. */
export const INVENTORY_LAYER = 1;

/** Surface band for the player's account-wide inventory bucket,
 *  shared across all of that player's souls (for permanent /
 *  account-scoped items). Same bucket convention as
 *  `INVENTORY_LAYER` but `macro_zone = player_id` instead of
 *  `soul.card_id`. */
export const PLAYER_INVENTORY_LAYER = 2;

/** Each macroZone covers an 8×8 block of hex positions. */
export const ZONE_SIZE = 8;

/** The decoded `macro_zone` a client row carries — the full packed `bigint`
 *  key together with its unpacked parts, derived together so reads never
 *  pack/unpack and it's clear when `packed` must be rebuilt (only via
 *  [`makeMacroZone`]). Layout: `[owner:u32 | surface:u8 | i12 zoneQ | i12 zoneR]`.
 *  - `packed`: the full u64 — the subscription / equality / `ZoneId` key.
 *  - `owner`: the owning card_id (bits 32-63); `0` is the WORLD sentinel.
 *  - `surface`: the band (bits 24-31).
 *  - `zoneQ` / `zoneR`: tile-origin coords (chunk × `ZONE_SIZE`, signed) — read
 *    as `(q, r)` or `(x, y)` per surface; `(0, 0)` for single-chunk surfaces. */
export interface MacroZone {
  packed: bigint;
  owner: number;
  surface: number;
  zoneQ: number;
  zoneR: number;
}

/** Decode the wire `macro_zone` (`u64` → SDK `bigint`) into a [`MacroZone`].
 *  Mirrors `pack_macro_zone_full` / the accessors in `content/src/packed.rs`. */
export function decodeMacroZone(packed: bigint): MacroZone {
  const rawQ = Number((packed >> 12n) & 0xfffn);
  const rawR = Number(packed & 0xfffn);
  const chunkQ = rawQ >= 0x800 ? rawQ - 0x1000 : rawQ;
  const chunkR = rawR >= 0x800 ? rawR - 0x1000 : rawR;
  return {
    packed,
    owner: Number((packed >> 32n) & 0xffff_ffffn),
    surface: Number((packed >> 24n) & 0xffn),
    zoneQ: chunkQ * ZONE_SIZE,
    zoneR: chunkR * ZONE_SIZE,
  };
}

/** The single write helper — build a [`MacroZone`] from its parts, packing
 *  `packed` in lockstep. `owner` is a card_id (`0` = WORLD); `zoneQ` / `zoneR`
 *  are tile origins (folded to i12 chunk coords). Mirrors
 *  `pack_macro_zone_full` in `content/src/packed.rs`. */
export function makeMacroZone(
  owner: number,
  surface: number,
  zoneQ: number,
  zoneR: number,
): MacroZone {
  const chunkQ = Math.floor(zoneQ / ZONE_SIZE);
  const chunkR = Math.floor(zoneR / ZONE_SIZE);
  const packed =
    (BigInt(owner >>> 0) << 32n) |
    (BigInt(surface & 0xff) << 24n) |
    (BigInt(chunkQ & 0xfff) << 12n) |
    BigInt(chunkR & 0xfff);
  return { packed, owner: owner >>> 0, surface: surface & 0xff, zoneQ, zoneR };
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
 *  the **stack** layout (`[position: u4 | direction: u2 | state: u2]`).
 *
 *  `position` is the card's 1-indexed place in its chain from the root
 *  (saturates at 15). `direction` is the branch number — `0 = hex /
 *  tile`, `1 = up / top`, `2 = down / bottom`. Value 3 is reserved.
 *  The "server is forcing this position" signal moved out of
 *  microZone and now lives in `flags` (`pos_need` / `pos_want`) —
 *  set / clear those bits on `Card.flags` instead.
 *
 *  Only valid for `stackedState == STACKED_ON_ROOT` (= 2) and
 *  `surface < WORLD_LAYER`. Use [`packMicroZone`] for everything else. */
export function packStackMicroZone(
  position: number,
  direction: number,
  stackedState: number,
): number {
  const pos = position & 0xf;
  const dir = direction & 0x3;
  return (pos << 4) | (dir << 2) | (stackedState & 0x3);
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
    position: (microZone >> 4) & 0xf,
    direction: (microZone >> 2) & 0x3,
    stackedState: microZone & 0x3,
  };
}

/** Whether the **stack layout** applies to this `(state, surface)` pair.
 *  True iff the card is rect-stacked on inventory (state is
 *  `STACKED_ON_ROOT` AND `surface < WORLD_LAYER`). False for loose /
 *  on-hex / world-surface cards — those keep the legacy `(localQ,
 *  localR)` layout. `STACKED_SLOT` (state 1) has its own preserve
 *  branch in `mirrorCard` (same `pos_need` / `pos_want` gate as
 *  stack layout); it doesn't go through this discriminator. */
export function isStackLayout(stackedState: number, surface: number): boolean {
  return surface < WORLD_LAYER && stackedState === 2;
}

/** Pack a `microZone` byte for a `STACKED_SLOT` row (parent-pointer
 *  mode). Layout matches the stack layout
 *  (`[position: u4 | direction: u2 | state: u2]`) but with `position
 *  = 0` since position from root is implicit (walk parent pointers
 *  via `microLocation`). Direction is the 2-bit branch number — same
 *  semantics as `packStackMicroZone`.
 *
 *  Server-only — the client never writes Slot rows. Provided here
 *  for symmetry with `packStackMicroZone` and so the bit layout has
 *  one canonical implementation. */
export function packSlotMicroZone(direction: number): number {
  const dir = direction & 0x3;
  return (dir << 2) | 0x1; // state value 1 = STACKED_SLOT
}
