# AGENT.md — spacetime/

## Purpose
Client-side SpacetimeDB state layer: server/client record schemas, pack/unpack helpers, secondary indexes, and local mutation helpers.

## Important files
- `Data.ts`: canonical record shapes, pack/unpack helpers, global state tables, upsert/remove helpers, local mutation helpers.
- `SpacetimeManager.ts`: subscription callbacks — writes to `server_*` tables and calls `upsert*` / `remove*` helpers.
- `DebugData.ts`: local bootstrap data for offline testing.
- `bindings/`: **DO NOT EDIT** — auto-generated SpacetimeDB TypeScript bindings.

## Data.ts overview

### ID types (aliases over `number` or `bigint`)
`CardId`, `PlayerId`, `ActionId` → `number` (u32)
`MacroLocation`, `MicroLocation` → `bigint` (u64) and `number` (u32)

### Server record shapes (mirrors DB schema)
`ServerCard`, `ServerPlayer`, `ServerAction`, `ServerZone`

### Client record shapes (extends server + decoded fields + local UI state)

`ClientCard` adds:
- From `packed_definition`: `card_type`, `category`, `definition_id`
- From `flags`: `stacked_up`, `stacked_down`, `stackable`, `position_locked`, `position_hold`
- From `macro_location`: `surface`, `layer`, `zone_q`, `zone_r`, `panel_card_id`
- From `micro_location` (mode depends on surface + stacked): `stacked_on_id`, `local_q`, `local_r`, `pixel_x`, `pixel_y`
- Derived: `world_q`, `world_r`
- Local UI state (not server-authoritative): `selected`, `dragging`, `animating`, `hidden`, `stale`, `dirty`, `dead`

`ClientAction` adds:
- All location fields (same as ClientCard)
- `local_start: number` — `Date.now()/1000` stamped at first receipt; preserved across server updates so progress bars always animate from 0%

### Bit packing

| Location | Encoding |
|---|---|
| `macro_location` surface=1 | `[zone_q:i16][zone_r:i16][reserved:u16][layer:u8][1:u8]` |
| `macro_location` surface=2 | `[card_id:u32][reserved:u16][layer:u8][2:u8]` |
| `micro_location` stacked | full u32 = `stacked_on_id` |
| `micro_location` surface=1 | `[local_q:u4][local_r:u4][reserved:u24]` |
| `micro_location` surface=2 | `[pixel_x:i16][pixel_y:i16]` |
| `packed_definition` | `[card_type:u4][category:u4][definition_id:u8]` |
| `flags` | `STACKED_UP=1 STACKED_DOWN=2 STACKABLE=4 POSITION_LOCKED=8 POSITION_HOLD=16` |

### Global tables
    server_cards, server_players, server_actions, server_zones   // written by subscription callbacks only
    client_cards, client_players, client_actions, client_zones   // derived + local state

### Secondary indexes (auto-maintained by upsert/remove helpers)
    macro_location_cards   Map<MacroLocation, Set<CardId>>
    macro_location_players Map<MacroLocation, Set<PlayerId>>
    macro_location_actions Map<MacroLocation, Set<ActionId>>
    stacked_up_children    Map<CardId, Set<CardId>>   // parent → children above it
    stacked_down_children  Map<CardId, Set<CardId>>   // parent → children below it

### Key mutation helpers
- `upsertClientCard(server)` / `removeClientCard(id)` — write-through with index maintenance
- `upsertClientAction(server)` / `removeClientAction(id)` — preserves `local_start` on updates
- `moveClientCard(id, macro, micro)` — local move without server publish
- `stackClientCardUp(childId, parentId)` / `stackClientCardDown(childId, parentId)` — optimistic stack
- `buildClientCard(server, previous?)` — preserves local-only fields across server updates

### Action helpers
- `isActionRunning(action)`: `action.end !== 0` (end=0 means queued/not started)
- `getActionProgress(action, now_seconds)`: `(now - local_start) / (end - local_start)`, clamped [0,1]

## Conventions
- Keep pack/unpack helpers symmetric with the Rust server (`packing.rs`).
- Treat `server_*` tables as read-only outside subscription callbacks.
- `client_*` tables carry local UI state — never clobber it on server update (see `buildClientCard` — it copies previous local state).
- Coordinate packing uses fixed bit widths; changing masks/shifts is high-risk.

## Ownership boundaries
- Owns data representation and transform utilities only.
- Does not own Pixi scene/layout rendering code.

## Pitfalls
- `local_start` is stamped at first receipt (insert), not on updates — `upsertClientAction` passes `previous?.local_start` to preserve it.
- `stacked_on_id` is only valid when `stacked_up || stacked_down`; it is 0 otherwise.
- `surface`, `layer`, etc. on `ClientCard` are decoded from `macro_location` at build time — don't read them from the raw server row.
