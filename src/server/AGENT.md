# AGENT.md

## Purpose
SpacetimeDB websocket lifecycle, auth-token persistence, **all SDK table event handler bindings**, and a **registry of active subscriptions** that survives reconnects. The single boundary between the client and the SpacetimeDB SDK.

## Important files
- `SpacetimeManager.ts`: connect/disconnect, identity, token, `TokenStore`. Holds the per-(table, event) handler that routes inbound rows into `DataManager`. Holds a `Map<name, ActiveSubscription>` keyed by subscription name (`"cards"`, `"players"`, …). Exposes high-level `subscribe<Table>(...)` methods that wrap the registry.
- `bindings/`: **generated** by `../../spacetime/server/generate-bindings.sh`. Re-run whenever the server schema changes; never edit by hand.

## Conventions
- **One bound function per event type per table, all in this module.** The SDK accepts multiple callbacks, but we treat "one per event per table" as a project rule. `bindTableHandlers(conn)` runs on every successful connect; each handler is wrapped in `try/catch` so a thrown listener can't break the SDK callback path. Handlers call `data.applyServer*(tableName, row)` — SpacetimeManager never reaches into DataManager's stores.
- **`DataManager` is downstream.** SpacetimeManager pushes inbound rows into it — never the reverse. DataManager has zero imports from this module's runtime.
- **Subscription registry.** Each subscription has a `name` (the table-ish slot) and a `scopeKey` (e.g. `"player:42"`). `installSubscription(name, def)`:
  - same name + same scopeKey + active or in-flight → no-op (de-dup)
  - same name + different scopeKey → unsubscribe old, `clearStore?.()`, subscribe new
  - new name → just subscribe
  In-flight subscriptions are tracked via `inFlight: Promise<void>` so concurrent callers share the same promise — eliminates the previous race.
- **Reconnect re-issues every active subscription.** On `onDisconnect`, every subscription's `clearStore` is called (so listeners get clean teardown events) and its handle is nulled. On the next successful connect, `reissueAllSubscriptions` re-runs `subscribeRaw` for each entry in the registry, in parallel. Callers don't have to remember to re-call `subscribeCards` after a network blip.
- **`subscribe<Table>` helpers (`subscribeCards(zoneId)`, `subscribePlayers()`)** define their scope key and `clearStore` and delegate to `installSubscription`. `subscribeCards` takes a packed `ZoneId` (`macroZone << 8 | layer`), unpacks it to build the `WHERE macro_zone = X AND layer = Y` filter, and uses `cards:${zoneId}` as a unique slot — concurrent zone subscriptions coexist. `clearStore` for a zone clears only that zone's rows via the `zone` index on the cards store.
- **Subscription orchestration lives in `DataManager`**, not in scenes/feature modules. `DataManager.trackCards(zoneId)` / `trackPlayers()` refcount intent and call into these helpers at the 0↔1 boundary. Don't call `subscribeCards` / `subscribePlayers` from scenes — go through `data.track…` so refcount is honored.
- **Reducer calls** still go through `getConnection().reducers.<name>(...)` from feature modules (e.g. `PlayerSession`). They aren't subscriptions and aren't tracked in the registry. Consider wrapping them on `SpacetimeManager` if a feature module ends up reaching for `getConnection()` for more than one reducer.
- `TokenStore` is pluggable. Default is `localStorageTokenStore`; tests can inject in-memory stores. Don't read/write `localStorage` for token state outside this module.
- `connect()` is idempotent and de-duplicated. The `subscribe<Table>` helpers are de-duplicated via the registry's `scopeKey` and `inFlight`. The generic `subscribe(query)` is NOT de-duplicated — each call issues a fresh SDK subscription and isn't tracked.

## Pitfalls
- Bindings re-bind on every successful connect. Old bindings are GC'd with the old connection — no manual `removeOnInsert` needed. But: `bindTableHandlers` MUST tolerate being called multiple times across the manager's lifetime, and each handler must be self-contained (no closure state from previous connections).
- On disconnect, every registered subscription's `clearStore` runs, so listeners (e.g. `CardManager`) see deletes for every row. They'll re-spawn on reconnect once the snapshot lands. This is correct, but it does mean a brief flicker on every reconnect — acceptable cost for store correctness.
- `getConnection()` returns `null` after disconnect. Don't cache it; re-fetch via `await spacetime.connect()` per operation.
- `subscribeRaw` rejects with the SDK's error when available (read off `ErrorContext.event.error`); falls back to a synthetic message naming the queries. Don't catch and swallow — bad SQL or permission errors deserve to surface.
- The bindings path (`bindings/`) and the database name (`resonantdust-dev`, see `../../spacetime/server/spacetime.json`) are tightly coupled to the spacetime project. Regenerate bindings whenever the server schema changes.
- `disconnect()` is fire-and-forget; the SDK does not expose an awaitable close.
