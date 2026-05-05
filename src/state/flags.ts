/**
 * Typed bit-flag constants for the `flags: u8` columns on cards, actions, and
 * magnetic_actions. Bit assignments are pinned in data/flags.json — this file
 * is the client-side mirror of that source of truth. Never reuse a bit.
 */

export const CARD_FLAG_DYING            = 1 << 7;  // cards.dying           bit 7

export const CARD_FLAG_POSITION_HOLD    = 1 << 0;
export const CARD_FLAG_POSITION_LOCKED  = 1 << 1;
export const CARD_FLAG_LAYER_LOCKED     = 1 << 2;
export const CARD_FLAG_DROP_HOLD        = 1 << 3;
export const CARD_FLAG_DROP_LOCKED      = 1 << 4;

export const ACTION_FLAG_MAGNETIC_INPUTS = 1 << 0;

export function hasFlag(flags: number, flag: number): boolean {
  return (flags & flag) !== 0;
}
