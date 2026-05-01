# AGENT.md — spacetime/

## Purpose
Client-side SpacetimeDB state layer: server/client record schemas, pack/unpack helpers, secondary indexes, and local mutation helpers.

## Important files
- `Data.ts`: canonical record shapes, pack/unpack helpers, global state tables, upsert/remove helpers, local mutation helpers.
- `SpacetimeManager.ts`: subscription callbacks — writes to `server_*` tables and calls `upsert*` / `remove*` helpers.
- `DebugData.ts`: local bootstrap data for offline testing (currently unused — connected mode is the live path).
- `bindings/`: **DO NOT EDIT** — auto-generated SpacetimeDB TypeScript bindings.

## Data.ts overview

### ID types (aliases over `number`)
`CardId`, `PlayerId`, `ActionId` → `number` (u32)
`MacroZone` → `number` (u32) — panel: `soul_card_id`; world: `[zone_q:i16][zone_r:i16]`
`MicroZone` → `number` (u8) — `[local_q:u3][local_r:u3][unused:u2]`
`MicroLocation` → `number` (u32) — variant by stack_state

### Server record shapes (mirrors DB schema)
`ServerCard`, `ServerPlayer`, `ServerAction`, `ServerZone`

Each carries `(layer:u8, macro_zone:u32, micro_zone:u8)` plus table-specific
fields.  `ServerCard` and (for cards only) `micro_location:u32`.  `ServerAction`
also carries a `participants:u8` adjacency packing.

### Client record shapes (extends server + decoded fields)

`ClientCard` adds:
- From `packed_definition`: `card_type`, `category`, `definition_id`
- From `flags`: `stack_state`, `loose`, `stacked_up`, `stacked_down`, `attached`, `stackable`, `position_locked`, `position_hold`, `slot_hold`
- Parent / anchor: `stacked_on_id` (rect parent), `attached_to_id` (hex anchor), `attached_to_floor` (sentinel)
- From `(layer, macro_zone)`: `is_panel`, `is_world`, `zone_q`, `zone_r`, `panel_card_id`
- From `micro_zone`: `local_q`, `local_r` (own hex coords; mirrors anchor's when stacked/attached)
- From `micro_location` (decoded by stack_state): `pixel_x`, `pixel_y` (loose only)
- Derived: `world_q`, `world_r` (world cards only)

`ClientAction` adds:
- All location fields (same shape as ClientCard's panel/world decoding)
- `local_start: number` — `Date.now()/1000` stamped at first receipt; preserved across server updates so progress bars always animate from 0%
- `participants_up`, `participants_down` — adjacency lengths consumed in each branch

### Bit packing

| Field | Encoding |
|---|---|
| `layer` | `u8` — panel = `0..31`, world = `32..255`. `is_panel(layer)` / `is_world(layer)` predicates. |
| `macro_zone` (panel) | full u32 = `soul_card_id` |
| `macro_zone` (world) | `[zone_q:i16][zone_r:i16]` |
| `micro_zone` | `[local_q:u3][local_r:u3][unused:u2]` |
| `micro_location` (loose, state 00) | `[pixel_x:i16][pixel_y:i16]` |
| `micro_location` (stack_up/down, 01/10) | full u32 = parent rect `card_id` |
| `micro_location` (attached, 11) | hex `card_id`; or `0` = floor at own `(layer, macro_zone, micro_zone)` |
| `packed_definition` | `[card_type:u4][category:u4][definition_id:u8]` |
| `flags` | `STACKABLE=1 POSITION_LOCKED=2 POSITION_HOLD=4 SLOT_HOLD=8`, plus `STACK_STATE:u2` at bits 6-7 |

Stacked / attached cards mirror their anchor's `(layer, macro_zone, micro_zone)` so subscription `WHERE macro_zone = X` returns the entire chain alongside its anchor.

### Global tables
    server_cards, server_players, server_actions   // Record<id, server-row>
    server_zones                                   // Map<string, ServerZone> keyed by zoneKey(layer, macro_zone)
    client_cards, client_players, client_actions   // derived (client*)
    client_zones                                   // Map<string, ClientZone>

### Secondary indexes (auto-maintained by upsert/remove helpers)
    macro_zone_cards          Map<MacroZone, Set<CardId>>
    macro_zone_players        Map<MacroZone, Set<PlayerId>>
    macro_zone_actions        Map<MacroZone, Set<ActionId>>
    stacked_up_children       Map<CardId, Set<CardId>>   // parent rect → children above
    stacked_down_children     Map<CardId, Set<CardId>>   // parent rect → children below
    attached_to_hex_children  Map<CardId, Set<CardId>>   // hex anchor → attached rects

### Key mutation helpers
- `upsertClientCard(server)` / `removeClientCard(id)` — write-through with index maintenance.
- `upsertClientAction(server)` / `removeClientAction(id)` — preserves `local_start` on updates.
- `moveClientCard(id, layer, macro_zone, micro_zone, micro_location)` — local move; clears stack state, marks LOOSE.
- `stackClientCardUp(childId, parentId)` / `stackClientCardDown(childId, parentId)` — optimistic stack on a rect parent.
- `attachClientCardToHex(childId, hexCardId)` — optimistic attach onto a hex anchor.
- `buildClientCard(server)` — pure decoder; no local-state preservation.

### Action helpers
- `isActionRunning(action)`: `action.end !== 0` (end=0 means queued/not started).
- `getActionProgress(action, now_seconds)`: `(now - local_start) / (end - local_start)`, clamped [0,1].
- `participantsUp(p)` / `participantsDown(p)`: unpack the 4+4-bit Action.participants byte.

## SpacetimeManager subscriptions

Three canonical query patterns:

| Intent                          | Method                                       | SQL                                                              |
|---------------------------------|----------------------------------------------|------------------------------------------------------------------|
| World zone (cards/zones/players/actions at one layer + macro_zone) | `subscribeZone(owner, layer, macro_zone)` | `WHERE layer = N AND macro_zone = M`                             |
| All my panels (any layer)       | `subscribePanel(owner, soul_id)`             | `WHERE macro_zone = soul_id`                                     |
| Soul-owned audit (legacy)       | `subscribeSoul(owner, soul_id)`              | `WHERE soul_id / owner_id = id`                                  |

`setViewedSoul` opens both `subscribeSoul` and `subscribePanel` for the new soul.

## Conventions
- Keep pack/unpack helpers symmetric with the Rust server (`packing.rs`).
- Treat `server_*` tables as read-only outside subscription callbacks.
- `client_*` tables carry purely-derived state; rebuild via `buildClient*` on every server update.
- Coordinate packing uses fixed bit widths; changing masks/shifts is high-risk.

## Pitfalls
- `local_start` is stamped at first receipt (insert), not on updates — `upsertClientAction` passes `previous?.local_start` to preserve it.
- `stacked_on_id` is only valid when `stacked_up || stacked_down`; it is 0 otherwise.
- `attached_to_id` is only valid when `attached && !attached_to_floor`; it is 0 otherwise.
- `is_panel`/`is_world` and other derived fields on `ClientCard` are decoded at build time — don't read them from the raw server row.
- `MICRO_ATTACHED_TO_FLOOR = 0` is a state-scoped sentinel: it means "floor at my own hex" only when `stack_state == ATTACHED`.  Under any other state, `micro_location == 0` is just a value (e.g. pixel coords (0, 0) under LOOSE).
