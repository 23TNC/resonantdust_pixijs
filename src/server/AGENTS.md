# AGENTS.md

## Purpose
The client's SpacetimeDB boundary AND the local data layer. Split into four narrow modules: connection lifecycle, subscription registry + SDK row-event fan-out, reducer wrapping, and a packed-u64 local mirror of server tables.

## Important files
- `ConnectionManager.ts`: websocket lifecycle, identity, auth-token persistence (`TokenStore`, default `localStorageTokenStore`). Exposes `connect()` / `disconnect()` / `getConnection()` / `getIdentity()` / `clearToken()` and a multi-listener pub/sub: `addListener({ onConnected, onConnectError, onDisconnected })` returns an unsubscribe fn. Does NOT bind table handlers or hold subscriptions — those live downstream and register listeners here.
- `SubscriptionManager.ts`: holds the active-subscription registry (`Map<name, ActiveSubscription>` keyed by `"cards:<zoneId>"`, `"zones:<macroZone>"`, …) AND the per-(table, event) SDK callback. Exposes typed `subscribe<Table>(...)` / `unsubscribe<Table>(...)` methods that wrap the registry, plus `registerTableHandlers(table, handlers)` for downstream consumers (DataManager) to plug into insert/update/delete events. Registers a `ConnectionListener` so it re-binds row handlers and re-issues every subscription on reconnect.
- `ReducerManager.ts`: thin wrappers around `conn.reducers.*`. Today only `submitStacks(stacks)`. Each call awaits `connection.connect()` so callers don't have to track connection state.
- `DataManager.ts`: one `ValidAtTable<T>` per server table (`cards`, `zones`). In its constructor it calls `subscriptions.registerTableHandlers(...)` with the `ValidAtTable.insert/update/delete` arrows for both tables. Exposes `promote(now)` to fan out across every table.
- `ValidAtTable.ts`: generic per-table mirror keyed by packed u64 `(high32 = id, low32 = valid_at seconds)`. Holds `server: Map<ValidAt, T>` (every row we believe the server has) and `current: Map<number, T>` (the row currently valid for each id). Constructor takes a `keyOf(row): ValidAt` extractor; today both cards and zones use `(r) => r.validAt`. `insert` / `update` / `delete` are arrow methods so they pass as callbacks without rebinding.
- `packing.ts`: `ValidAt = bigint`; `packValidAt(id, secs)` / `unpackValidAt` / `idOf` / `validAtOf` for the high32/low32 layout.
- `bindings/`: **generated** by `../../spacetime/server/generate-bindings.sh`. Re-run whenever the server schema changes; never edit by hand.

## Wiring (main.ts)
```
ConnectionManager
  ↓ addListener (from SubscriptionManager constructor)
SubscriptionManager
  ↓ registerTableHandlers (from DataManager constructor)
DataManager
```
Construction order is fixed by these dependencies: `ConnectionManager` → `SubscriptionManager` → `ReducerManager` → `DataManager`. `main.ts` registers a logging listener directly on `ConnectionManager.addListener` for connect / connectError / disconnect telemetry.

## Subscription helpers
| Method | Scope | Tables touched |
| --- | --- | --- |
| `subscribeCards(zoneId)` | `WHERE macro_zone = X AND layer = Y` | `cards` |
| `subscribeActions(zoneId)` | same | `actions` |
| `subscribeMagneticActions(zoneId)` | same | `magnetic_actions` |
| `subscribePlayers()` | unfiltered | `players` (full roster) |
| `subscribeWorldZone(macroZone)` | `WHERE macro_zone = X` | `zones` + `cards` (`layer == WORLD_LAYER`) — combined because they're meaningless apart |
| `subscribeWorldPlayers(macroZone)` | `WHERE macro_zone = X AND layer = WORLD_LAYER` | `players` (only those whose soul is in this chunk) |

These build the SQL only; SDK row events fan out via `registerTableHandlers`. Subscription orchestration (who calls `subscribe<Table>(...)` based on zone activation) is **not yet wired** in this rewrite — see "Pending" below.

## Conventions
- **`ConnectionManager` is the SDK boundary for connect/disconnect**, `SubscriptionManager` is the boundary for SDK row events, `ReducerManager` is the boundary for reducer calls. Nothing outside this folder should construct a `DbConnectionBuilder`, call `conn.db.<table>.onInsert`, or call `conn.reducers.<name>` directly.
- **Server pushes down to `DataManager`, never the reverse.** SubscriptionManager fan-out calls the registered handlers (`ValidAtTable.insert/update/delete`); DataManager's tables are downstream of subscription events. DataManager has zero connection / subscription state of its own beyond the handler registrations it makes in its constructor.
- **One SDK callback per (table, event), bound on every connect.** `bindHandlers(conn)` runs from the `onConnected` listener inside `SubscriptionManager`. Each SDK callback fans out to every registered handler in the order they registered. Per-handler `try/catch` so one bad handler can't break the others. Old bindings are GC'd with the old connection — no manual `removeOnInsert` needed.
- **Row keys are packed u64.** Each table's primary key on the server is `validAt: u64` whose high 32 bits hold the row's id (e.g. `card_id`, `zone_id`) and low 32 bits hold the absolute-second unix timestamp at which the row becomes valid. The bindings expose this directly as `row.validAt` (a `bigint`). `ValidAtTable.server` is keyed by this packed value. Multiple rows per id can coexist; `promote(now)` collapses them to a single `current` row per id.
- **Subscription registry.** Each subscription has a `name` (the table-ish slot) and a `scopeKey` (e.g. `"zone:42"`). `installSubscription(name, def)`:
  - same name + same scopeKey + active or in-flight → no-op (dedup)
  - same name + different scopeKey → unsubscribe old, subscribe new
  - new name → subscribe
  In-flight subscriptions are tracked via `inFlight: Promise<void>` so concurrent callers share the same promise.
- **Reconnect re-issues every active subscription.** On `onDisconnect`, every subscription's handle is nulled (no row-store wipe — the registry survives). On the next `onConnected`, SDK row handlers are re-bound and `reissueAllSubscriptions` re-runs `subscribeRaw` for each entry in parallel. Callers don't have to re-call `subscribeCards` after a blip.
- **Multi-listener fan-out on `ConnectionManager`.** Use `addListener({...})` and keep the unsubscribe fn for teardown. Listener errors are caught and logged; one bad listener can't stop the others.
- `TokenStore` is pluggable. Default is `localStorageTokenStore`; tests can inject in-memory stores. Don't read/write `localStorage` for token state outside this module.
- `connect()` is idempotent and de-duplicated. The `subscribe<Table>` helpers are de-duplicated via the registry's `scopeKey` and `inFlight`. The generic `subscribe(query)` is NOT de-duplicated — each call issues a fresh SDK subscription and isn't tracked.

## Pitfalls
- `bindHandlers` runs on every successful connect, so each handler must be self-contained (no closure state carried from a previous connection). Registered handlers in `SubscriptionManager.handlers` ARE preserved across reconnects — the registry is what re-binds.
- `getConnection()` returns `null` after disconnect. Don't cache it; re-fetch via `await connection.connect()` per operation.
- `subscribeRaw` rejects with the SDK's error when available (read off `ErrorContext.event.error`); falls back to a synthetic message naming the queries. Don't catch and swallow — bad SQL or permission errors deserve to surface.
- The bindings path (`bindings/`) and the database name (`resonantdust-dev`, see `../../spacetime/server/spacetime.json`) are tightly coupled to the spacetime project. Regenerate bindings whenever the server schema changes.
- `disconnect()` is fire-and-forget; the SDK does not expose an awaitable close.
- `subscribeWorldZone` bundles `zones` + world-layer `cards` queries because they're meaningless apart — clearing one without the other leaves orphaned visuals or unrenderable cards. Don't split them.
- **Stored rows are not frozen.** `ValidAtTable` does not shallow-freeze rows on insert (the old `ShadowedStore` did). Treat rows from `server` / `current` as read-only by convention; mutating them in place corrupts the local view.
- **`row.validAt` is `bigint`, not `number`.** The packed key is a u64. Using JS `number` math on it loses precision past 2^53. The helpers in `packing.ts` work in `bigint`; stay in `bigint` until you need the unpacked components.

## Pending in this rewrite
The architecture is in place but several wires from the old design haven't been reconnected yet. Don't assume these work just because the modules look complete:
- **Nothing calls `data.promote(now)`.** Until a per-frame call lands (e.g. `app.ticker.add(() => data.promote(Date.now() / 1000))`), `current` stays empty regardless of how many rows arrive in `server`.
- **Nothing calls the `subscribe<Table>(...)` helpers.** The old design had `DataManager.attachZones(...)` listening to `ZoneManager` and `data.trackPlayers()` for the global roster. Those drivers were removed; subscriptions don't get installed unless something starts calling these helpers.
- **No subscription-lifecycle hooks.** The old `SubscriptionDef` had `clearStore?` (called on scope change / teardown / disconnect) and `onApplied?` (used to re-hydrate world-zone rows from the SDK's local cache after re-subscribe). Both are gone. If/when DataManager needs to wipe local rows on scope change or hydrate from the SDK cache, these hooks (or a separate event stream from `SubscriptionManager`) need to come back.
- **Display buffer is not implemented.** The old `ShadowedStore` lagged the client view by ~2 seconds so server lateness consumed the buffer instead of stacking. `ValidAtTable.promote(now)` accepts any `now`, so this can be implemented at the call site by passing `wallClock - bufferSeconds` — but no caller does that yet.
- **Most consumers are mid-rewrite.** `ActionManager`, `CardManager`, `PlayerSession`, `DragManager`, etc. still reference the old DataManager APIs (`data.subscribe`, `data.get`, `data.players`, `MagneticActionRow`, `ShadowedChange`, `FLAG_CARD_*`). These are pre-existing breakage that this rewrite hasn't reached yet.
