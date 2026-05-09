/*
 * Card location helpers. Position state lives directly on the row —
 * `microZone: u8`, `microLocation: u32`, `flags: u32` are first-class fields.
 *
 * `microZone` (u8) has TWO interpretations gated on `(state, surface)`:
 *
 *   Stack layout (rect-stacked on inventory; `state == STACKED_ON_ROOT`):
 *       bits 0-1 (u2): stackedState
 *       bit  2   (u1): direction        (0 = up / top, 1 = down / bottom)
 *       bits 3-7 (u5): position         (1..31, 0 = no chain)
 *
 *   Slot layout (parent-pointer slots; `state == STACKED_SLOT`):
 *       bits 0-1 (u2): stackedState
 *       bit  2   (u1): direction        (same bit position as stack layout)
 *       bits 3-7 (u5): unused (always 0; position is implicit via the
 *                              parent-pointer walk through microLocation)
 *
 *   Legacy layout (loose, on-hex, world surfaces):
 *       bits 0-1 (u2): stackedState
 *       bits 2-4 (u3): localR
 *       bits 5-7 (u3): localQ
 *
 * `force_position` (the "server is asserting this row's position
 * verbatim" signal) used to live in `microZone` bit 2 of the stack
 * layout. It now lives in `flags` (`force_position` at bit 11), freeing
 * `microZone` bit 2 to encode chain direction. Bit allocations are
 * pinned in `content/cards/flags.json`.
 *
 * `microLocation` (u32) interpretation:
 *   - STACKED_LOOSE:    packed (x: u16, y: u16) loose XY
 *   - STACKED_SLOT:     IMMEDIATE parent's card_id (which can be a Slot,
 *                       OnRoot, Free, or OnHex card). Server-only writes.
 *   - STACKED_ON_ROOT:  ROOT card_id of the rect chain (chain order
 *                       comes from `microZone.position` + `microZone.direction`)
 *   - STACKED_ON_HEX:   parent hex card_id (legacy parent-pointer walk)
 *
 * Rect chains use a mix of states: the chain root stays in state 0 (or
 * state 3 if mounted on hex); cards stacked via drag-drop are state 2
 * (OnRoot); recipe slots above the actor are state 1 (Slot, server-
 * authoritative). Hex chains keep parent-pointer walking via state 3.
 * Rect-on-hex must be a leaf. See docs/STACK_LAYOUT_MIGRATION.md for
 * migration history.
 */

const STACKED_STATE_MASK = 0b11;

export const STACKED_LOOSE = 0;
/** Parent-pointer slot mode. `microLocation` is the immediate parent's
 *  card_id (which can itself be `Slot`, `OnRoot`, `Free`, or `OnHex`),
 *  not the chain root. `microZone` carries only `direction` — position
 *  from root is implicit via the parent-pointer walk. Server-only
 *  writes (`propose_action`); the client never writes Slot rows. */
export const STACKED_SLOT = 1;
export const STACKED_ON_ROOT = 2;
export const STACKED_ON_HEX = 3;

/** Direction bit values for the stack layout. */
export const STACK_DIRECTION_UP = 0;
export const STACK_DIRECTION_DOWN = 1;

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

/** Read the chain `direction` bit from a `microZone` byte under the
 *  stack layout. Returns `STACK_DIRECTION_UP` (0) or
 *  `STACK_DIRECTION_DOWN` (1). Caller must already know the byte is
 *  stack-layout. */
export function getStackDirection(microZone: number): number {
  return (microZone >> 2) & 0x1;
}
