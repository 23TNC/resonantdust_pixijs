/*
 * Card location helpers (client mirror of `content/src/packed.rs` + the
 * `flags.json` stacking bits). Position lives on the row as `microLocation: u32`
 * plus the `micro_is_card` / `stackState` / `stackIndex` flag fields in
 * `flagsBk` (and `zoneBorn` in `flagsState`). `microZone` was removed.
 *
 * Two interpretations of `microLocation`, gated by `micro_is_card`:
 *   - set   → root card_id; the card is a FLAT stack member (branch =
 *             `stackState`, slot = `stackIndex`). No parent pointers.
 *   - clear → loose coords + offset
 *             `[localQ:3 | localR:3 | x:i12 | y:i12 | rsvd:2]`; the `stackState`
 *             flag is the loose kind (LOOSE_HEX/RECT, SNAP_HEX/RECT).
 *
 * The bit layouts and accessors live in `server/data/packing.ts`; this module
 * re-exports them plus the semantic `StackDirection` / `LooseXY` types the game
 * layer uses. See `docs/micro_location_rewrite/`.
 */

import {
  packMicroLoose,
  unpackMicroLoose,
  STACK_DIR_HEX,
  STACK_DIR_UP,
  STACK_DIR_DOWN,
  MAX_STACK_INDEX,
} from "../../server/data/packing";

export {
  // micro_location loose layout
  packMicroLoose,
  unpackMicroLoose,
  microLooseCell,
  // flag accessors / mutators
  microIsCard,
  stackBranch,
  stackIndex,
  zoneBorn,
  decodeMicro,
  applyMicro,
  // flag bit masks
  ZONE_BORN,
  // stackState values — stacked branch
  STACK_DIR_HEX,
  STACK_DIR_UP,
  STACK_DIR_DOWN,
  STACK_STATE_DEFERRED,
  MAX_STACK_INDEX,
  type Micro,
} from "../../server/data/packing";

/** Semantic stack direction used by the layout/game layer. Maps to the
 *  `stackState` branch values (`hex` → `STACK_DIR_HEX`, etc.). */
export type StackDirection = "top" | "bottom" | "hex";

/** Branch (`stackState`) value for a `StackDirection`. */
export function branchForDirection(dir: StackDirection): number {
  switch (dir) {
    case "top":
      return STACK_DIR_UP;
    case "bottom":
      return STACK_DIR_DOWN;
    case "hex":
      return STACK_DIR_HEX;
  }
}

/** `StackDirection` for a branch (`stackState`) value; `null` for the deferred
 *  branch (3). */
export function directionForBranch(branch: number): StackDirection | null {
  switch (branch) {
    case STACK_DIR_UP:
      return "top";
    case STACK_DIR_DOWN:
      return "bottom";
    case STACK_DIR_HEX:
      return "hex";
    default:
      return null;
  }
}

/** Aliases kept for the game layer (same values as the `STACK_DIR_*` branch
 *  constants). */
export const STACK_DIRECTION_HEX = STACK_DIR_HEX;
export const STACK_DIRECTION_UP = STACK_DIR_UP;
export const STACK_DIRECTION_DOWN = STACK_DIR_DOWN;

/** Maximum chain length the splice + eviction primitive permits before
 *  failing over to loose. Equals the `stackIndex` cap (u4) + 1, and matches
 *  the server's flat-chain index range. */
export const MAX_CHAIN_DEPTH = MAX_STACK_INDEX + 1;

export interface LooseXY {
  x: number;
  y: number;
}

/** The within-cell `(x, y)` offset of a loose `microLocation`. (Cell address
 *  `(localQ, localR)` is dropped — inventory callers use cell (0, 0).) Signed
 *  i12 (±2047) per the loose layout. */
export function decodeLooseXY(microLocation: number): LooseXY {
  const { x, y } = unpackMicroLoose(microLocation);
  return { x, y };
}

/** Build a loose `microLocation` at cell (0, 0) with within-cell offset
 *  `(x, y)`. Clamped to the i12 range (±2047). Used for inventory pixel
 *  placement (single-cell bucket). */
export function encodeLooseXY(x: number, y: number): number {
  const xi = Math.max(-2048, Math.min(2047, Math.round(x)));
  const yi = Math.max(-2048, Math.min(2047, Math.round(y)));
  return packMicroLoose(0, 0, xi, yi);
}
