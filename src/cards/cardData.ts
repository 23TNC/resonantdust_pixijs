/*
 * Card location helpers. Position state lives directly on the row now —
 * `microZone: u8`, `microLocation: u32`, `flags: u8` are first-class fields,
 * not packed into a single `u64`.
 *
 * `microLocation` interpretation depends on `flags.stackedState`:
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

export function getStackedState(flags: number): number {
  return flags & STACKED_STATE_MASK;
}

/** Clears the stacked-state bits of `flags` (i.e. forces it to STACKED_LOOSE). */
export function clearStackedState(flags: number): number {
  return flags & ~STACKED_STATE_MASK;
}

/** Replaces the stacked-state bits of `flags` with `newState` (low 2 bits). */
export function setStackedState(flags: number, newState: number): number {
  return (flags & ~STACKED_STATE_MASK) | (newState & STACKED_STATE_MASK);
}

export function decodeLooseXY(microLocation: number): LooseXY {
  return {
    x: microLocation & 0xffff,
    y: (microLocation >>> 16) & 0xffff,
  };
}

export function encodeLooseXY(x: number, y: number): number {
  const xi = Math.max(0, Math.min(0xffff, Math.trunc(x)));
  const yi = Math.max(0, Math.min(0xffff, Math.trunc(y)));
  return (xi & 0xffff) | ((yi & 0xffff) << 16);
}
