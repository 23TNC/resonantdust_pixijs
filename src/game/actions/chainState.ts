/** Read-side helpers that union server-truth held-state flags with the
 *  client-only prediction sets `ActionManager` maintains across the
 *  proposeAction round-trip. Consumers asking "should I treat this
 *  card as committed?" (death-animation deferral, in-flight skip,
 *  drag-pickup gate, lifecycle held-set seed, etc.) call these so the
 *  prediction window is invisible at the read site.
 *
 *  Predictions live in `ActionManager` (scene-scoped), not in
 *  `Card.flags` / `Card.flags` — splitting the two preserves
 *  the invariant that the row's columns mirror server state exactly.
 *  `ctx.actions` may be null (outside `MainScene`); in that case the
 *  prediction lookup short-circuits to `false` and we read flag bits
 *  alone.
 *
 *  Both helpers take the card row's `(flagsState, flagsBk)` pair so
 *  the wasm registry can route each lookup to the correct host
 *  integer — `slot_hold` lives in `cards_state`,
 *  `position_hold_count` lives in `cards_bk`. */

import type { GameContext } from "../../GameContext";

/** True if `cardId`'s row carries `slot_hold_count > 0` (in `flagsBk`)
 *  OR a proposeAction round-trip is currently predicting an exclusive
 *  hold. Post unified-hold-counts rework, exclusive holds are a
 *  refcount field, not a single bit — see
 *  `docs/UNIFIED_HOLD_COUNTS.md`. `_flagsState` retained on the
 *  signature for symmetry with `isPositionHeld` and to leave a
 *  natural hook for future state-side signals; not read today. */
export function isSlotHeld(
  ctx: GameContext,
  cardId: number,
  flags: number,
): boolean {
  const count = ctx.definitions.cardFlagFieldValueIn(
    "flags",
    flags,
    "slot_claim_count",
  ) ?? 0;
  if (count > 0) return true;
  return ctx.actions?.isSlotHeldPrediction(cardId) === true;
}

/** True if `cardId`'s row carries `position_hold_count > 0` (in the
 *  `flags` word) OR a proposeAction round-trip is currently predicting
 *  one. */
export function isPositionHeld(
  ctx: GameContext,
  cardId: number,
  flags: number,
): boolean {
  const count = ctx.definitions.cardFlagFieldValueAny(flags, 0, "position_hold_count") ?? 0;
  if (count > 0) return true;
  return ctx.actions?.isPositionHeldPrediction(cardId) === true;
}
