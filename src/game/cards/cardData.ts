/*
 * Card location helpers. Position state lives directly on the row —
 * `microZone: u8`, `microLocation: u32`, `flags: u8` are first-class fields.
 *
 * `microZone` (u8) packs three sub-fields, LSB-first:
 *   - bits 0-1 (u2): stackedState
 *   - bits 2-4 (u3): localR
 *   - bits 5-7 (u3): localQ
 *
 * `microLocation` interpretation depends on `microZone.stackedState`:
 *   - 0 (loose):  microLocation packs (x: u16, y: u16) — inventory pixel coords
 *   - 1 or 2 (stacked on rect): microLocation is parent card_id (u32)
 *   - 3 (stacked on hex, future): rect-on-hex anchor; not implemented
 *
 * The `(x, y)` packing inside `microLocation` is u16 low / u16 high.
 */

const STACKED_STATE_MASK = 0b11;

export const STACKED_LOOSE = 0;
export const STACKED_ON_RECT_X = 1;
export const STACKED_ON_RECT_Y = 2;
export const STACKED_ON_HEX = 3;

export interface LooseXY {
  x: number;
  y: number;
}

export function getStackedState(microZone: number): number {
  return microZone & STACKED_STATE_MASK;
}

/** Clears the stacked-state bits of `microZone` (forces state to STACKED_LOOSE).
 *  Preserves localQ / localR. */
export function clearStackedState(microZone: number): number {
  return microZone & ~STACKED_STATE_MASK;
}

/** Replaces the stacked-state bits of `microZone` with `newState` (low 2 bits).
 *  Preserves localQ / localR. */
export function setStackedState(microZone: number, newState: number): number {
  return (microZone & ~STACKED_STATE_MASK) | (newState & STACKED_STATE_MASK);
}

export function decodeLooseXY(microLocation: number): LooseXY {
  return {
    x: microLocation & 0xffff,
    y: (microLocation >>> 16) & 0xffff,
  };
}

export function encodeLooseXY(x: number, y: number): number {
  // Round (not truncate) so encode/decode round-trip biases to the nearest
  // integer rather than always toward (0, 0). Cuts the post-drop snap from
  // up-to-1px toward origin to up-to-0.5px in either direction.
  const xi = Math.max(0, Math.min(0xffff, Math.round(x)));
  const yi = Math.max(0, Math.min(0xffff, Math.round(y)));
  return (xi & 0xffff) | ((yi & 0xffff) << 16);
}
