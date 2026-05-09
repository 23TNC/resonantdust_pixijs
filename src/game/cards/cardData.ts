/*
 * Card location helpers. Position state lives directly on the row —
 * `microZone: u8`, `microLocation: u32`, `flags: u8` are first-class fields.
 *
 * `microZone` (u8) has TWO interpretations gated on `(state, surface)`:
 *
 *   Stack layout (rect-stacked on inventory):
 *     state ∈ {STACKED_ON_RECT_X, STACKED_ON_RECT_Y} AND surface < 64:
 *       bits 0-1 (u2): stackedState
 *       bit  2   (u1): forceFlag      (server forces this position)
 *       bits 3-7 (u5): position        (1..31, 0 = no chain)
 *
 *   Legacy layout (loose, on-hex, world surfaces):
 *       bits 0-1 (u2): stackedState
 *       bits 2-4 (u3): localR
 *       bits 5-7 (u3): localQ
 *
 * `microLocation` (u32) interpretation:
 *   - STACKED_LOOSE:                         packed (x: u16, y: u16) loose XY
 *   - STACKED_ON_RECT_X / STACKED_ON_RECT_Y: ROOT card_id of the rect chain
 *   - STACKED_ON_HEX:                        parent hex card_id (legacy walk)
 *
 * Rect chains use (root_id, position); hex chains keep parent-pointer
 * walking. Rect-on-hex must be a leaf. See
 * docs/STACK_LAYOUT_MIGRATION.md for migration history.
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

/** Read the chain `position` field from a `microZone` byte under the
 *  stack layout. Caller must already know the byte is stack-layout —
 *  reading a legacy-layout byte through here returns garbage. */
export function getStackPosition(microZone: number): number {
  return (microZone >> 3) & 0x1f;
}

/** Read the `forceFlag` bit from a `microZone` byte under the stack
 *  layout. */
export function getForceFlag(microZone: number): boolean {
  return ((microZone >> 2) & 0x1) !== 0;
}
