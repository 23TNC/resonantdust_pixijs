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
 * The "server is asserting this row's position" signal used to live
 * in `microZone` bit 2 of the stack layout. It now lives in `flags`
 * as the `pos_need` (required) / `pos_want` (advisory) bit pair,
 * freeing `microZone` bit 2 to encode chain direction. Bit
 * allocations are pinned in `content/cards/flags.json`.
 *
 * `microLocation` (u32) interpretation:
 *   - STACKED_LOOSE:    packed (x: u16, y: u16) loose XY
 *   - STACKED_SLOT:     IMMEDIATE parent's card_id (which can be a Slot,
 *                       OnRoot, or Free card). Server-only writes.
 *   - STACKED_ON_ROOT:  ROOT card_id of the rect chain (chain order
 *                       comes from `microZone.position` + `microZone.direction`)
 *   - STACKED_DEFERRED: HOST card_id (or 0 if no host) — anchor for
 *                       mirror-time resolution. `microZone` carries a
 *                       fallback (q, r) used when host can't be
 *                       resolved. Recipe outputs like `stack.N.create`.
 *
 * Rect chains use a mix of states: the chain root stays in state 0;
 * cards stacked via drag-drop are state 2 (OnRoot); recipe slots above
 * the actor are state 1 (Slot, server-authoritative); recipe outputs
 * targeting positions that depend on chain state at write-time emit
 * state 3 (Deferred), resolved client-side at mirror time. Rect-on-hex
 * mounts use state 2 (OnRoot) with direction = HEX. See
 * docs/STACK_LAYOUT_MIGRATION.md for migration history.
 */

const STACKED_STATE_MASK = 0b11;

export const STACKED_LOOSE = 0;
/** Parent-pointer slot mode. `microLocation` is the immediate parent's
 *  card_id (which can itself be `Slot`, `OnRoot`, or `Free`), not the
 *  chain root. `microZone` carries only `direction` — position from
 *  root is implicit via the parent-pointer walk. Server-only writes
 *  (`propose_action`); the client never writes Slot rows. */
export const STACKED_SLOT = 1;
export const STACKED_ON_ROOT = 2;
/** **Deferred placement, anchored to host.** The row carries
 *  `microLocation = host_card_id` (or `0` if no host) and `microZone`
 *  encodes a fallback `(q, r)` per the legacy `[localQ:u3 |
 *  localR:u3 | state:u2]` layout. Resolution runs at mirror-time
 *  via `CardManager.appendAtChainLeaf`: walk host's chain to its
 *  root, pick the chain's growth direction (Top children present →
 *  Top, Bottom children present → Bottom, both → Top, neither → try
 *  Top then Bottom), walk back to the leaf in that direction, append
 *  as new leaf at state 1. On any tier rejection (host gone,
 *  type-incompatible, drop-locked, etc.) the cascade falls through
 *  to (q, r) loose → owner inventory → free (q, r) in macroZone →
 *  log-and-place-loose worst case.
 *
 *  Used by recipe outputs like `stack.N.create: <key>` where the
 *  intended position depends on chain state at write-time. Resolves
 *  the propose-vs-commit-vs-mirror staleness problem by storing
 *  *intent* (host_id + fallback q/r) rather than a captured
 *  position that may go stale.
 *
 *  Server-side: a follower index (`cards::state_3_followers`) keeps
 *  every deferred row's `(surface, macroZone)` in lockstep with its
 *  host so subscription gaps don't strand cards on the wrong zone.
 *  Host destruction clears `microLocation = 0`; the client cascade
 *  then falls through to the (q, r) fallback.
 *
 *  Pre-unified-card-model this value was `STACKED_ON_HEX` (hex cards
 *  were their own state); that semantic was retired and the value
 *  reserved, freeing it for this repurposing. */
export const STACKED_DEFERRED = 3;

/** Maximum chain length the splice + eviction primitive will permit
 *  before evicting the topmost card via the
 *  inventory→loose→nearby-tile cascade. Matches the server-side
 *  `SOUL_STACK_MAX_DEPTH = 16` in
 *  `spacetime/server/modules/shard/src/recipe_eval.rs` so a chain that
 *  fits the placement layer can't be rejected later by recipe-eval. */
export const MAX_CHAIN_DEPTH = 16;

/** Direction values for the stack layout (2 bits — values 0, 1, 2
 *  are valid; value 3 reserved).
 *
 *  - `STACK_DIRECTION_HEX` (0) — the tile branch (visually beneath
 *    root; what was "hex" in the legacy model).
 *  - `STACK_DIRECTION_UP` (1) — top stack (was direction 0).
 *  - `STACK_DIRECTION_DOWN` (2) — bottom stack (was direction 1).
 *
 *  Three branches off root. The packing layout under
 *  `STACKED_ON_ROOT` / `STACKED_SLOT` is
 *  `[position:4 | direction:2 | state:2]`. */
export const STACK_DIRECTION_HEX = 0;
export const STACK_DIRECTION_UP = 1;
export const STACK_DIRECTION_DOWN = 2;

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
 *  stack layout (`[position:4 | direction:2 | state:2]`). Returns
 *  0-15. Caller must already know the byte is stack-layout — reading
 *  a legacy-layout byte through here returns garbage. */
export function getStackPosition(microZone: number): number {
  return (microZone >> 4) & 0xf;
}

/** Read the chain `direction` field from a `microZone` byte under
 *  the stack layout. Returns 0-3; values 0/1/2 are
 *  `STACK_DIRECTION_HEX` / `STACK_DIRECTION_UP` / `STACK_DIRECTION_DOWN`.
 *  Value 3 is reserved. */
export function getStackDirection(microZone: number): number {
  return (microZone >> 2) & 0x3;
}

