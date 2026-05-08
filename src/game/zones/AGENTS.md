# AGENTS.md

## Purpose
Tracks which zones the client cares about, in what state, and where the
camera/player are anchored in world coordinates. Other managers
(`DataManager`, `CardManager`, `LayoutWorld`, …) subscribe to ZoneManager
events and react: DataManager subscribes/unsubscribes spacetime queries;
CardManager spawns/destroys Card UI; LayoutWorld registers/unregisters
its surface for world zones. ZoneManager owns the policy of which zones
are in which tier; consumers don't make tracking decisions themselves.

## Important files
- `zoneId.ts`: `ZoneId` type (a single number) plus `packZoneId(macroZone, layer)` / `unpackZoneId(zoneId)`. Pack formula: `macroZone * 256 + (layer & 0xff)`. Result fits in 40 bits — JS-safe-integer-clean.
- `ZoneManager.ts`: the `ZoneTier` enum (`active` / `hot` / `cold`) and the registry, per-tier add/remove listeners, **named world anchors** (`"viewport"`, `"player"`, …) with their own change listeners, and refcounted `ensure(zoneId)`. Re-exports `ZoneId` / `packZoneId` / `unpackZoneId` for convenience.

## Conventions
- A **zone** is identified by a single `ZoneId` (packed `macroZone << 8 | layer`). Two cards belong to the same zone iff they have identical `(macroZone, layer)`. Inventory is `packZoneId(player_id, 1)`; world zones are `packZoneId(packMacroZone(zoneQ, zoneR), WORLD_LAYER)` (`WORLD_LAYER == 64`).
- All public APIs take `ZoneId`, not the unpacked tuple. If a consumer needs `macroZone` or `layer` separately (e.g. for SQL filter building), call `unpackZoneId(zoneId)`.
- **Tier semantics** (the contract consumers code against):
  - **Active**: data subscribed, UI rendered. Player is here / viewing.
  - **Hot**: data subscribed, UI **not** rendered. Prefetch / warm cache for likely re-visits.
  - **Cold**: not subscribed, no UI. ZoneManager remembers the zone (e.g. for promotion priority hints), but consumers see nothing.
  - DataManager listens to `active` + `hot` add/remove. CardManager listens to `active` only.
- **Tiers are mutually exclusive.** A zone is in exactly one tier (or none). Calling `set(zone, "hot")` on a zone currently in `active` fires `removed:active` then `added:hot`. Consumers refcounting on Active∪Hot see net-zero on transitions; consumers listening to Active only see the cards-destroyed event.
- **Two ways into the active set:** `ensure(zoneId)` (refcounted, returns release fn — used by inventory subscriptions and any code that explicitly needs a specific zone), and the **anchor system** (any `setAnchor(name, q, r)` call recomputes the world-zone neighborhood and adds/removes world zones to keep the set in sync with all known anchors). The two coexist — inventory zones are pinned via `ensure`, world zones flow from anchors.
- **World anchors drive panning.** `setAnchor("viewport", q, r)` is what the world-pan code calls per drag frame. ZoneManager unions every anchor's `zonesAroundAnchor(q, r, anchorRadius)` neighborhood (default radius 2) and diffs against the previous set, demoting zones that left the union and promoting zones that entered. `onAnchorChange(listener)` is the subscription LayoutWorld uses to recenter the hex grid; it fires immediately for every existing anchor (not lazily on the next change), so subscribers can hydrate without an explicit initial read.
- **`ensure(zoneId)` is the consumer-facing API for inventory.** Returns a release fn; first ensure for a zone promotes it to `active`, last release demotes to `null`. DataManager listens to `onAdded`/`onRemoved` and drives spacetime subscriptions automatically.
- **Inventory is a zone.** `(player_id, 1)` lives here just like any world zone — same plumbing. Nothing about inventory is special-cased in ZoneManager itself; whoever owns inventory's lifecycle (GameScene) just keeps it permanently `active` via `ensure`.

## Pitfalls
- `ZoneId` is a plain `number` — equality is just `===`. Pass it around freely; no need to track object identity.
- Listeners fire synchronously inside `set` / `remove` / `setAnchor`. If a listener calls back into ZoneManager (e.g. a transition triggers another), the second mutation runs on top of the first — be careful about re-entrancy. Listener errors are caught and logged so one bad listener can't break the rest of the dispatch.
- **Anchor changes can fire many tier transitions in one call.** Moving the viewport across a chunk boundary may both promote and demote multiple world zones. DataManager subscriptions are per-zone so this is fine, but consumers that maintain global state should treat each tier event independently.
- `ensure` and anchor-driven activation can target the same `ZoneId`. The first promotion wins and subsequent ones are no-ops; the *last* deactivator (whichever runs last — anchor leaving the radius or refcount hitting zero) demotes. Today they don't actually overlap (inventory layer ≠ WORLD_LAYER), but if a future feature ever ensures a world zone, expect the union.
- `dispose()` clears everything (entries, refs, listeners, anchors). Treat ZoneManager as bootstrap-scoped (created in main.ts, disposed in HMR teardown) — the same lifecycle as DataManager.
- Hot ≠ "lower priority Active." It's a deliberate "data-only" tier with no UI. If a consumer wants a smoother Active↔Hot transition (keep Card instances around but hidden), that's that consumer's design — ZoneManager just signals the tier change.
