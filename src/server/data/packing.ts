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
 *  4. **`microLocation` u32 — TWO INTERPRETATIONS, gated by the
 *     `micro_is_card` flag (in `flagsBk`):**
 *
 *     - **`micro_is_card` set** → `microLocation` is a **root card_id**. The
 *       card is a flat stack member; its branch is the `stackState` flag
 *       (`STACK_DIR_HEX/UP/DOWN` or `STACK_STATE_DEFERRED`) and its slot is the
 *       `stackIndex` flag (0..15). No parent pointers — every member points
 *       straight at the root.
 *
 *     - **`micro_is_card` clear** → `microLocation` is **loose coords + offset**
 *       ```
 *       [localQ: u3 (29-31) | localR: u3 (26-28) | x: i12 (14-25) | y: i12 (2-13) | rsvd: u2]
 *       ```
 *       `localQ`/`localR` address a cell in the zone; `x`/`y` is the signed
 *       within-cell offset. The `stackState` flag is the loose kind
 *       (`LOOSE_HEX/RECT`, `SNAP_HEX/RECT`).
 *
 *     (`microZone` u8 was removed — everything it held now lives in
 *     `microLocation` + flags. Stacking is one flat root+index mechanism; see
 *     `docs/micro_location_rewrite/`.) */

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

/** Surface band for per-soul inventory. `macro_zone` is the
 *  owning soul card's `card_id`. The player's own inventory is just
 *  the inventory of their `player_soul` card on this same band — there
 *  is no separate player-inventory surface. */
export const INVENTORY_LAYER = 1;

/** Each macroZone covers an 8×8 block of hex positions. */
export const ZONE_SIZE = 8;

/** Each region covers an 8×8 block of zones (chunks) — 64 zones per region.
 *  Mirrors `REGION_SIZE` in `content/src/packed.rs`. */
export const REGION_SIZE = 8;

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

/** Map a `macro_zone` to its containing `(macroRegion, bit)`, where `bit`
 *  (`0..63`) indexes the zone's slot in the region's 64-bit
 *  presence/availability bitfields. Row-major over the region's 8×8 zones:
 *  `bit = localR * REGION_SIZE + localQ`. `owner` / `surface` carry through, so
 *  a non-world zone maps to its own owner's / surface's region. Mirror of
 *  `content/src/packed.rs::region_of_zone`. */
export function regionOfZone(macroZone: bigint): { macroRegion: bigint; bit: number } {
  const m = decodeMacroZone(macroZone);
  // `m.zoneQ/zoneR` are tile origins (chunk × ZONE_SIZE); recover chunk indices.
  const chunkQ = Math.floor(m.zoneQ / ZONE_SIZE);
  const chunkR = Math.floor(m.zoneR / ZONE_SIZE);
  // floor-div → matches Rust `div_euclid` for negative coords; locals stay 0..7.
  const regionQ = Math.floor(chunkQ / REGION_SIZE);
  const regionR = Math.floor(chunkR / REGION_SIZE);
  const localQ = chunkQ - regionQ * REGION_SIZE;
  const localR = chunkR - regionR * REGION_SIZE;
  const bit = localR * REGION_SIZE + localQ;
  // Pack region coords into the q/r field: makeMacroZone divides its zoneQ/zoneR
  // by ZONE_SIZE internally, so feed `regionQ * ZONE_SIZE` to land regionQ there.
  const macroRegion = makeMacroZone(m.owner, m.surface, regionQ * ZONE_SIZE, regionR * ZONE_SIZE).packed;
  return { macroRegion, bit };
}

// ---- micro placement (mirror of content/src/packed.rs) ------------------
//
// A card's micro placement lives in `microLocation` (u32) + three flag fields
// in `flagsBk`, plus the `zoneBorn` flag in `flagsState`. Gated by
// `micro_is_card`:
//   set   → microLocation is a root card_id; branch = stackState, slot =
//           stackIndex (the card is a flat stack member).
//   clear → microLocation is loose coords + offset
//           `[localQ:3 (29-31) | localR:3 (26-28) | x:i12 (14-25) | y:i12 (2-13) | rsvd:2]`.
//
// Bit positions MUST match `content/cards/flags.json` (the client mirrors them
// by hand — "same file, same PR" with `flags.json`).

/** `flagsBk` bit: microLocation is a root card_id (card is a stack member). */
export const MICRO_IS_CARD = 1 << 24;
const STACK_STATE_SHIFT = 25; // flagsBk bits 25-26
const STACK_STATE_MASK = 0b11 << STACK_STATE_SHIFT;
const STACK_INDEX_SHIFT = 27; // flagsBk bits 27-30
const STACK_INDEX_MASK = 0b1111 << STACK_INDEX_SHIFT;
/** `flagsState` bit: card was generated from zone tile data. */
export const ZONE_BORN = 1 << 13;

/** `stackState` values for the **stacked** branch (micro_is_card set). */
export const STACK_DIR_HEX = 0;
export const STACK_DIR_UP = 1;
export const STACK_DIR_DOWN = 2;
export const STACK_STATE_DEFERRED = 3;
/** `stackState` values for the **loose** branch (micro_is_card clear). */
export const LOOSE_HEX = 0;
export const LOOSE_RECT = 1;
export const SNAP_HEX = 2;
export const SNAP_RECT = 3;

/** Max stack index (u4). Chains saturate here; placement fails over to loose. */
export const MAX_STACK_INDEX = 15;

const MICRO_LOOSE_LQ_SHIFT = 29;
const MICRO_LOOSE_LR_SHIFT = 26;
const MICRO_LOOSE_X_SHIFT = 14;
const MICRO_LOOSE_Y_SHIFT = 2;

function sx12(v: number): number {
  const m = v & 0xfff;
  return m & 0x800 ? m - 0x1000 : m;
}

/** Pack loose coords + within-cell offset into a `microLocation` (u32). */
export function packMicroLoose(
  localQ: number,
  localR: number,
  x: number,
  y: number,
): number {
  return (
    (((localQ & 0x7) << MICRO_LOOSE_LQ_SHIFT) |
      ((localR & 0x7) << MICRO_LOOSE_LR_SHIFT) |
      ((x & 0xfff) << MICRO_LOOSE_X_SHIFT) |
      ((y & 0xfff) << MICRO_LOOSE_Y_SHIFT)) >>>
    0
  );
}

/** Inverse of [`packMicroLoose`]. Uses unsigned shifts so a high `localQ`
 *  (bit 31 set) decodes correctly. */
export function unpackMicroLoose(microLocation: number): {
  localQ: number;
  localR: number;
  x: number;
  y: number;
} {
  return {
    localQ: (microLocation >>> MICRO_LOOSE_LQ_SHIFT) & 0x7,
    localR: (microLocation >>> MICRO_LOOSE_LR_SHIFT) & 0x7,
    x: sx12(microLocation >>> MICRO_LOOSE_X_SHIFT),
    y: sx12(microLocation >>> MICRO_LOOSE_Y_SHIFT),
  };
}

/** Read just the loose cell `(localQ, localR)` from a `microLocation`. */
export function microLooseCell(microLocation: number): {
  localQ: number;
  localR: number;
} {
  return {
    localQ: (microLocation >>> MICRO_LOOSE_LQ_SHIFT) & 0x7,
    localR: (microLocation >>> MICRO_LOOSE_LR_SHIFT) & 0x7,
  };
}

/** `micro_is_card` flag test (on `flagsBk`). */
export function microIsCard(flagsBk: number): boolean {
  return (flagsBk & MICRO_IS_CARD) !== 0;
}
/** `stack_state` branch/kind value (on `flagsBk`). */
export function stackState(flagsBk: number): number {
  return (flagsBk & STACK_STATE_MASK) >>> STACK_STATE_SHIFT;
}
/** `stack_index` slot value (on `flagsBk`). */
export function stackIndex(flagsBk: number): number {
  return (flagsBk & STACK_INDEX_MASK) >>> STACK_INDEX_SHIFT;
}
/** `zone_born` flag test (on `flagsState`). */
export function zoneBorn(flagsState: number): boolean {
  return (flagsState & ZONE_BORN) !== 0;
}

/** Default placement `kind` for a card landing on `surface`. The per-card
 *  `stack_state` (bits in `flags_bk`, mirrored here as `looseKind`) is what the
 *  renderer reads to decide whether to apply the within-cell `(x, y)` offset:
 *  - `LOOSE_HEX (0)` / `LOOSE_RECT (1)` → renderer applies the offset.
 *  - `SNAP_HEX  (2)` / `SNAP_RECT  (3)` → renderer ignores the offset (centred).
 *
 *  Hardcoded for now: **world snaps to the hex centre** (no free
 *  placement on tiles); **inventories use rect with the offset** (arbitrary
 *  in-cell placement). Soft-code via per-bucket config later.
 *
 *  Mirror of `packed.rs::loose_kind_for_surface`. */
export function looseKindForSurface(surface: number): number {
  return surface >= WORLD_LAYER ? SNAP_HEX : LOOSE_RECT;
}

/** A card's decoded micro placement — the client mirror of the server's
 *  `Micro` enum. `stacked` = a flat stack member of `root`; `loose` = coords +
 *  offset. Decode with [`decodeMicro`]; rebuild `(microLocation, flagsBk)` with
 *  [`applyMicro`]. */
export type Micro =
  | { kind: "stacked"; root: number; branch: number; index: number }
  | {
      kind: "loose";
      localQ: number;
      localR: number;
      x: number;
      y: number;
      looseKind: number;
    };

/** Decode a row's `(microLocation, flagsBk)` into a [`Micro`]. */
export function decodeMicro(microLocation: number, flagsBk: number): Micro {
  if (microIsCard(flagsBk)) {
    return {
      kind: "stacked",
      root: microLocation >>> 0,
      branch: stackState(flagsBk),
      index: stackIndex(flagsBk),
    };
  }
  const { localQ, localR, x, y } = unpackMicroLoose(microLocation);
  return { kind: "loose", localQ, localR, x, y, looseKind: stackState(flagsBk) };
}

/** Rebuild `(microLocation, flagsBk)` for a [`Micro`], preserving the non-stack
 *  bits of `baseFlagsBk` (hold counts, dirty/preserve markers). The single
 *  write helper — mirror of the server's `Micro::apply`. */
export function applyMicro(
  micro: Micro,
  baseFlagsBk: number,
): { microLocation: number; flagsBk: number } {
  let flagsBk = baseFlagsBk & ~(MICRO_IS_CARD | STACK_STATE_MASK | STACK_INDEX_MASK);
  if (micro.kind === "stacked") {
    flagsBk |=
      MICRO_IS_CARD |
      ((micro.branch & 0b11) << STACK_STATE_SHIFT) |
      ((micro.index & 0xf) << STACK_INDEX_SHIFT);
    return { microLocation: micro.root >>> 0, flagsBk: flagsBk >>> 0 };
  }
  flagsBk |= (micro.looseKind & 0b11) << STACK_STATE_SHIFT;
  return {
    microLocation: packMicroLoose(micro.localQ, micro.localR, micro.x, micro.y),
    flagsBk: flagsBk >>> 0,
  };
}
