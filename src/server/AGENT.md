# AGENT.md

## Purpose
SpacetimeDB websocket lifecycle, auth-token persistence, **all SDK table event handler bindings**, **`submit_inventory_stacks` reducer wrapping**, and a **registry of active subscriptions** that survives reconnects. The single boundary between the client and the SpacetimeDB SDK.

## Important files
- `SpacetimeManager.ts`: connect/disconnect, identity, token, `TokenStore`. Holds the per-(table, event) handler that routes inbound rows into `DataManager` for every public table (`cards`, `players`, `actions`, `zones`, `magnetic_actions`). Holds a `Map<name, ActiveSubscription>` keyed by subscription name (`"cards:<zoneId>"`, `"actions:<zoneId>"`, …). Exposes high-level `subscribe<Table>(...)` / `unsubscribe<Table>(...)` methods that wrap the registry, plus reducer wrappers (`submitStacks(stacks)`, …).
- `bindings/`: **generated** by `../../spacetime/server/generate-bindings.sh`. Re-run whenever the server schema changes; never edit by hand.

## Subscription helpers
| Method | Scope | Tables touched |
| --- | --- | --- |
| `subscribeCards(zoneId)` | `WHERE macro_zone = X AND layer = Y` | `cards` |
| `subscribeActions(zoneId)` | same | `actions` |
| `subscribeMagneticActions(zoneId)` | same | `magnetic_actions` |
| `subscribePlayers()` | unfiltered | `players` (full roster) |
| `subscribeWorldZone(macroZone)` | `WHERE macro_zone = X` | `zones` + `cards` (`layer == WORLD_LAYER`) — combined because they're meaningless apart |
| `subscribeWorldPlayers(macroZone)` | `WHERE macro_zone = X AND layer = WORLD_LAYER` | `players` (only those whose soul is in this chunk) |

`DataManager.attachZones(...)` listens to `ZoneManager` and dispatches the appropriate combination based on `layer` — inventory zones get cards/actions/magnetic_actions; world zones get the `subscribeWorldZone` bundle plus actions/magnetic_actions/world-players.

## Conventions
- **One bound function per event type per table, all in this module.** The SDK accepts multiple callbacks, but we treat "one per event per table" as a project rule. `bindTableHandlers(conn)` runs on every successful connect; each handler is wrapped in `try/catch` so a thrown listener can't break the SDK callback path. Handlers call `data.applyServer*(tableName, row)` — SpacetimeManager never reaches into DataManager's stores.
- **`DataManager` is downstream.** SpacetimeManager pushes inbound rows into it — never the reverse. DataManager has zero imports from this module's runtime.
- **Subscription registry.** Each subscription has a `name` (the table-ish slot) and a `scopeKey` (e.g. `"zone:42"`). `installSubscription(name, def)`:
  - same name + same scopeKey + active or in-flight → no-op (de-dup)
  - same name + different scopeKey → unsubscribe old, `clearStore?.()`, subscribe new
  - new name → just subscribe
  In-flight subscriptions are tracked via `inFlight: Promise<void>` so concurrent callers share the same promise — eliminates the race the early version had.
- **Reconnect re-issues every active subscription.** On `onDisconnect`, every subscription's `clearStore` is called (so listeners get clean teardown events) and its handle is nulled. On the next successful connect, `reissueAllSubscriptions` re-runs `subscribeRaw` for each entry in the registry, in parallel. Callers don't have to remember to re-call `subscribeCards` after a network blip.
- **`onApplied` hydration for world zones.** `subscribeWorldZone` includes an `onApplied` callback that walks the SDK's local cache for the matching zone/cards and pushes them through `applyServerInsert` (with `delayMs: 0` to bypass the display buffer). This is needed because the SDK doesn't always re-fire `onInsert` for rows already in its local table after a re-subscribe — without the manual sync, world tiles would silently fail to repopulate after reconnect.
- **Subscription orchestration lives in `DataManager`**, not in scenes/feature modules. DataManager listens to `zones.onAdded("active"|"hot")` and calls these helpers at the 0↔1 boundary; players use `data.trackPlayers()` directly. Don't call `subscribeCards` / etc. from scenes.
- **Reducer calls** still go through `getConnection().reducers.<name>(...)` from feature modules (e.g. `PlayerSession`). They aren't subscriptions and aren't tracked in the registry. `submitStacks(stacks)` is the one reducer wrapped on `SpacetimeManager` itself, since `ActionManager` / drag code call it from multiple places.
- `TokenStore` is pluggable. Default is `localStorageTokenStore`; tests can inject in-memory stores. Don't read/write `localStorage` for token state outside this module.
- `connect()` is idempotent and de-duplicated. The `subscribe<Table>` helpers are de-duplicated via the registry's `scopeKey` and `inFlight`. The generic `subscribe(query)` is NOT de-duplicated — each call issues a fresh SDK subscription and isn't tracked.

## Pitfalls
- Bindings re-bind on every successful connect. Old bindings are GC'd with the old connection — no manual `removeOnInsert` needed. But: `bindTableHandlers` MUST tolerate being called multiple times across the manager's lifetime, and each handler must be self-contained (no closure state from previous connections).
- On disconnect, every registered subscription's `clearStore` runs, so listeners (e.g. `CardManager`) see deletes for every row. They'll re-spawn on reconnect once the snapshot lands. This is correct, but it does mean a brief flicker on every reconnect — acceptable cost for store correctness.
- `getConnection()` returns `null` after disconnect. Don't cache it; re-fetch via `await spacetime.connect()` per operation.
- `subscribeRaw` rejects with the SDK's error when available (read off `ErrorContext.event.error`); falls back to a synthetic message naming the queries. Don't catch and swallow — bad SQL or permission errors deserve to surface.
- The bindings path (`bindings/`) and the database name (`resonantdust-dev`, see `../../spacetime/server/spacetime.json`) are tightly coupled to the spacetime project. Regenerate bindings whenever the server schema changes.
- `disconnect()` is fire-and-forget; the SDK does not expose an awaitable close.
- `subscribeWorldZone` bundles `zones` + world-layer `cards` queries because they're meaningless apart — clearing one without the other leaves orphaned visuals or unrenderable cards. Don't split them.
