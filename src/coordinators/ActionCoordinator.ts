// ─── ActionCoordinator (Phase 5) ─────────────────────────────────────────────
//
// Under the Phase 5 sync protocol, action lifecycle is fully server-driven:
//
//   • Position changes route through `spacetime.updatePosition` /
//     `updatePositions`.
//   • The server's `update_position` reducer cancels disturbed actions and
//     runs the matcher; new Action rows arrive via the actions-table
//     subscription.
//   • UI components observe action insert/update/delete via per-card
//     listeners (`spacetime.registerCardListener`) — those still fire
//     because the SpacetimeManager binds them inside the actions-table
//     callbacks.
//
// Net effect: this coordinator no longer needs to track activations,
// validate cancel-on-shrink, or invoke `startActionNow` / `cancelAction`.
// The exported observe / unobserve / clearAll API is preserved as a no-op
// stub so existing call sites in World.ts and Inventory.ts compile while
// the Phase 5 migration shakes out.  Once we're confident the server-driven
// path is the only one in play, this file can be deleted and its imports
// inlined.

import { type CardId } from "@/spacetime/Data";

/** No-op under the server-driven protocol.  Retained for call-site compat. */
export function observe(_rootId: CardId, _ownerId: CardId): void {}

/** No-op under the server-driven protocol.  Retained for call-site compat. */
export function unobserve(_rootId: CardId): void {}

/** No-op under the server-driven protocol.  Retained for call-site compat. */
export function clearAll(): void {}
