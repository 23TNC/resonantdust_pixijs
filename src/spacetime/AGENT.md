# AGENT.md

## Purpose
Client-side SpaceTimeDB-facing state layer: packed field helpers, server/client record maps, and debug bootstrap data.

## Important files
- `data.ts`: canonical client/server record shapes, pack/unpack helpers, selection/player globals.
- `DebugData.ts`: local bootstrap data seeding for client testing.
- `bindings/`: generated SpaceTimeDB TypeScript bindings.

## Conventions
- Keep bit-pack/bit-unpack helpers deterministic and symmetric.
- Prefer pure transforms/helpers for card/zone decode logic.
- Treat global records (`server_*`, `client_*`) as shared state; avoid silent mutation side-effects in unrelated modules.

## Ownership boundaries
- Owns data representation and transform utilities.
- Does not own Pixi scene/layout rendering code.

## Pitfalls
- Coordinate packing uses fixed bit widths; changing masks/shifts is high-risk and must be tested thoroughly.
- Keep file-name casing consistent when importing (`DebugData.ts` vs lowercase import names can break on case-sensitive systems).
