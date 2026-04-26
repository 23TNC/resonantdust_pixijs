# AGENT.md — spacetime/

## Purpose
Client-side SpacetimeDB-facing state layer: server/client record schemas, pack/unpack helpers, secondary indexes, and debug bootstrap data.

## Important files
- `Data.ts`: canonical record shapes, pack/unpack helpers, global state tables, client-only mutation helpers.
- `DebugData.ts`: local bootstrap data for offline testing.
- `bindings/`: **DO NOT EDIT** — auto-generated SpacetimeDB TypeScript bindings.

## Data.ts overview

### ID types (aliases over `number`)
`CardId`, `PlayerId`, `ZoneId`, `PackedPosition`

### Server record shapes (mirrors DB schema)
`ServerCard`, `ServerPlayer`, `ServerAction`, `ServerZone`

### Client record shapes (extends server + derived + local state)
`ClientCard` adds:
- Unpacked from zone: `zone_q`, `zone_r`, `z`
- Unpacked from position: `local_q`, `local_r`, `world_flag`, `linked_flag`
- Derived: `world_q`, `world_r`, `card_type`, `definition_id`
- Local UI state (not server-authoritative): `selected`, `dragging`, `returning`, `hidden`, `stale`, `dirty`

### Bit packing schemes
| Field | Bit layout |
|---|---|
| ZoneId | `[31:20]=zone_q (i12)  [19:8]=zone_r (i12)  [7:0]=z (u8)` |
| PackedPosition | `[7]=linked_flag  [6]=world_flag  [5:3]=local_q  [2:0]=local_r` |
| Card definition | `[15:12]=card_type (u4)  [11:0]=definition_id (u12)` |
| Zone definition | `[7:4]=card_type (u4)  [3:0]=category (u4)` |

### Card flags (`ServerCard.flags`)
    CARD_FLAG_POSITION_LOCKED = 1 << 0   // card cannot be moved by player
    CARD_FLAG_POSITION_HOLD   = 1 << 1   // position temporarily held (mid-server-action)

Use `parseCardFlags(flags)` → `{ position_locked, position_hold }`.

### Global tables
    server_cards, server_players, server_actions, server_zones   // written by subscription callbacks
    client_cards, client_zones                                    // derived; also carries local state
    client_cards_by_zone                                          // secondary index; kept in sync automatically

### Key mutation helpers
- `upsertClientCard(server)` / `removeClientCard(id)` — write-through with zone index maintenance
- `updateClientCardLocation(id, zone, position)` — local move not yet published to server
- `buildClientCard(server, previous?)` — preserves local-only state (dragging, returning, etc.) across server updates

## Conventions
- Keep pack/unpack helpers deterministic and symmetric with the Rust server (`packing.rs`).
- Treat `server_*` tables as read-only outside subscription callbacks.
- `client_*` tables may carry local-only state; be careful not to clobber it on server update (see `buildClientCard` — it copies previous local state).
- Coordinate packing uses fixed bit widths; changing masks/shifts is high-risk.

## Ownership boundaries
- Owns data representation and transform utilities.
- Does not own Pixi scene/layout rendering code.
