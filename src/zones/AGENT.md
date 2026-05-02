# AGENT.md

## Purpose
Tracks which zones the client cares about, in what state. Other managers (`DataManager`, `CardManager`, …) subscribe to ZoneManager events and react: DataManager subscribes/unsubscribes spacetime queries; CardManager spawns/destroys Card UI. ZoneManager owns the policy of which zones are in which tier; consumers don't make tracking decisions themselves.

## Important files
- `zoneId.ts`: `ZoneId` type (a single number) plus `packZoneId(macroZone, layer)` / `unpackZoneId(zoneId)`. Pack formula: `macroZone * 256 + (layer & 0xff)`. Result fits in 40 bits — JS-safe-integer-clean.
- `ZoneManager.ts`: the `ZoneTier` enum (`active` / `hot` / `cold`) and the registry + per-tier add/remove listeners. Re-exports `ZoneId` / `packZoneId` / `unpackZoneId` for convenience.

## Conventions
- A **zone** is identified by a single `ZoneId` (packed `macroZone << 8 | layer`). Two cards belong to the same zone iff they have identical `(macroZone, layer)`. Inventory is `packZoneId(player_id, 1)`; world zones are `packZoneId(world_macro_zone, layer >= 64)`.
- All public APIs take `ZoneId`, not the unpacked tuple. If a consumer needs `macroZone` or `layer` separately (e.g. for SQL filter building), call `unpackZoneId(zoneId)`.
- **Tier semantics** (the contract consumers code against):
  - **Active**: data subscribed, UI rendered. Player is here / viewing.
  - **Hot**: data subscribed, UI **not** rendered. Prefetch / warm cache for likely re-visits.
  - **Cold**: not subscribed, no UI. ZoneManager remembers the zone (e.g. for promotion priority hints), but consumers see nothing.
  - DataManager listens to `active` + `hot` add/remove. CardManager listens to `active` only.
- **Tiers are mutually exclusive.** A zone is in exactly one tier (or none). Calling `set(zone, "hot")` on a zone currently in `active` fires `removed:active` then `added:hot`. Consumers refcounting on Active∪Hot see net-zero on transitions; consumers listening to Active only see the cards-destroyed event.
- **Imperative, not policy-driven (yet).** The current API is `set(zone, tier)` / `remove(zone)` plus refcounted `ensure(zone)` / release-fn. When/how to promote/demote (distance, visit time, max-tracked-count, …) is the caller's job for now. Eviction policy belongs here when criteria become concrete — don't scatter it across consumers.
- **`ensure(zoneId)` is the consumer-facing API.** Returns a release fn; first ensure for a zone promotes it to `active`, last release demotes to `null`. DataManager listens to `onAdded`/`onRemoved` and drives `spacetime.subscribeCards/unsubscribeCards` automatically — callers don't talk to DataManager directly for zone subscriptions.
- **Inventory is a zone.** `(player_id, 1)` lives here just like any world zone — same plumbing. Nothing about inventory is special-cased in ZoneManager itself; whoever owns inventory's lifecycle (GameScene) just keeps it permanently `active`.

## Pitfalls
- `ZoneId` is a plain `number` — equality is just `===`. Pass it around freely; no need to track object identity.
- Listeners fire synchronously inside `set` / `remove`. If a listener calls back into ZoneManager (e.g. a transition triggers another), the second mutation runs on top of the first — be careful about re-entrancy. Listener errors are caught and logged so one bad listener can't break the rest of the dispatch.
- `dispose()` clears everything (entries AND listeners). Treat ZoneManager as bootstrap-scoped (created in main.ts, disposed in HMR teardown) — the same lifecycle as DataManager.
- Hot ≠ "lower priority Active." It's a deliberate "data-only" tier with no UI. If a consumer wants a smoother Active↔Hot transition (keep Card instances around but hidden), that's that consumer's design — ZoneManager just signals the tier change.
