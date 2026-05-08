# AGENTS.md

## Purpose
The client's SpacetimeDB boundary AND the local data layer. Split into four narrow modules and two tiers of storage:

- **`spacetime/`** — SDK-facing managers. Connection lifecycle (`ConnectionManager`), subscription registry + per-(table, event) row fan-out (`SubscriptionManager`), reducer wrapping (`ReducerManager`). Generated bindings live here too.
- **`data/`** — local mirror. `ValidAtTable<T>` per server table (server tier — read-only mirror of authoritative state) plus per-table `Map<id, T>` overlays on `DataManager` (local tier — what game code reads/writes for displayed state).

## Important files
- `spacetime/ConnectionManager.ts`: websocket lifecycle, identity, auth-token persistence (`TokenStore`, default `localStorageTokenStore`). Exposes `connect()` / `disconnect()` / `getConnection()` / `getIdentity()` / `clearToken()` and a multi-listener pub/sub: `addListener({ onConnected, onConnectError, onDisconnected })` returns an unsubscribe fn. Constructs the `DbConnection.builder()` internally — `main.ts` only hands in `uri` and `databaseName`.
- `spacetime/SubscriptionManager.ts`: holds the active-subscription registry (`Map<name, ActiveSubscription>` keyed by `"cards:<zoneId>"`, `"zones:<macroZone>"`, …) AND the per-(table, event) SDK callback. Exposes typed `subscribe<Table>(...)` / `unsubscribe<Table>(...)` methods that wrap the registry, plus `registerTableHandlers(table, handlers)` for downstream consumers (DataManager) to plug into insert/update/delete events. Registers a `ConnectionListener` so it re-binds row handlers and re-issues every subscription on reconnect.
- `spacetime/ReducerManager.ts`: thin wrappers around `conn.reducers.*`. Currently `proposeAction({hex, root, slots, surface, macroZone, microZone, microLocation, recipeId})` — fired by `ActionManager` once a queued recipe match's debounce timer expires. Each call awaits `connection.connect()` so callers don't have to track connection state.
- `data/DataManager.ts`: dual-tier data layer. Owns the `SubscriptionManager` (constructed internally from a `ConnectionManager`) and one `ValidAtTable<T>` per server table (`cards`, `players`, `zones`) plus a parallel `Map<id, T>` overlay (`cardsLocal`, `playersLocal`, `zonesLocal`). Game code reads / writes overlays. `mirrorCard` (cards-specific) preserves position fields from local when both sides say inventory-loose; `mirror` (generic) just copies through. Exposes `setLocalCard(id, row)` for client-driven writes, `subscribeLocalCard` / `subscribeLocalCardKey` for downstream (`Card.onDataChange`) to react to overlay changes from any source. `promote(now)` fans out across all tables.
- `data/ValidAtTable.ts`: generic per-table mirror keyed by packed u64 `(high32 = id, low32 = valid_at seconds)`. Holds `server: Map<ValidAt, T>` (every row we believe the server has) and `current: Map<number, T>` (the row currently valid for each id). Constructor takes a `keyOf(row): ValidAt` extractor; cards / players / zones all use `(r) => r.validAt`. `insert` / `update` / `delete` are arrow methods so they pass as callbacks without rebinding. `subscribe` / `subscribeKey` fire from inside `promote(now)` based on the diff between old and new `current`.
- `data/packing.ts`: `ValidAt = bigint`; `packValidAt(id, secs)` / `unpackValidAt` / `idOf` / `validAtOf` for the high32/low32 layout. Also owns `ZoneId` packing (`packZoneId(macroZone, layer)` + `unpackZoneId`), `WORLD_LAYER`, `macroZone` packing (`packMacroZone(zoneQ, zoneR)` + `unpackMacroZone`, `ZONE_SIZE`), and `microZone` packing (`packMicroZone(localQ, localR, stackedState)` + `unpackMicroZone`). All server-protocol bit layouts live here in one file.
- `player/PlayerManager.ts`: the only feature-shaped wrapper currently — owns `claimOrLogin(name)`, holds the active player, exposes a tiny event API. Calls the `claimOrLogin` reducer directly via `connection.connect()` and listens to `data.players` for the post-insert row.
- `spacetime/bindings/`: **generated** by `../../spacetime/server/generate-bindings.sh`. Re-run whenever the server schema changes; never edit by hand.

## Wiring (main.ts)
```
ConnectionManager
  ├── (logging listener for connect/disconnect telemetry)
  ↓ (passed to)
DataManager
  ├── new SubscriptionManager(connection)
  │     ├── ConnectionManager.addListener  (rebinds row handlers + reissues subs on connect)
  │     └── SubscriptionManager.registerTableHandlers
  │           (cards/players/zones → ValidAtTable.insert/update/delete)
  ├── ValidAtTable<Card> / <Player> / <Zone>
  └── cards.subscribe → mirrorCard → cardsLocal + fireCardLocal
      players.subscribe → mirror(playersLocal)
      zones.subscribe → mirror(zonesLocal)

ReducerManager(connection)  // peer of DataManager
ZoneManager.onAdded("active", zoneId => data.subscriptions.subscribeCards(zoneId))
app.ticker.add(() => data.promote(Date.now() / 1000))
```
Construction order: `ConnectionManager` → `ReducerManager` → `DataManager` (which constructs SubscriptionManager internally). `main.ts` registers a logging listener directly on `ConnectionManager.addListener` for telemetry and wires the per-frame promote + the ZoneManager → subscribeCards bridge.

## Subscription helpers
| Method | SQL filter | Tables touched |
| --- | --- | --- |
| `subscribeCards(zoneId)` | `WHERE macro_zone = X AND surface = Y` | `cards` |
| `subscribePlayers()` | unfiltered | `players` (full roster) |
| `subscribeActions(zoneId)` | same shape as cards | `actions` (table not yet in `TableRowMap`; method ready) |
| `subscribeMagneticActions(zoneId)` | same | `magnetic_actions` (likewise) |
| `subscribeWorldZone(macroZone)` | `WHERE macro_zone = X` | `zones` + `cards` (`surface == WORLD_LAYER`) |
| `subscribeWorldPlayers(macroZone)` | `WHERE macro_zone = X AND surface = WORLD_LAYER` | `players` (only those whose soul is in this chunk) |

These build SQL only; SDK row events fan out via `registerTableHandlers`. World/actions methods are present but world is currently stripped and actions tables don't have row handlers wired — they no-op until reintroduced.

## Two-tier read/write model
- **Server tier read**: `data.cards.current.get(id)` / `data.cards.current.values()`. Strictly server-derived state — pure mirror of what the server believes is currently valid. **Reserved for plumbing** (`mirrorCard`, `promote`, the SDK fan-out). Game code does NOT read this — see "Tier-rule pitfall" below.
- **Local tier read**: `data.cardsLocal.get(id)` / `data.cardsLocal.values()`. What game code displays. Mirrors server tier by default; client-driven mutations (drag-drop) override fields per the cards-specific rule.
- **Client write**: `data.setLocalCard(id, row)` — writes the new row into `cardsLocal`, fires the local-cards listeners. Server tier is left untouched.
- **Server arrival**: SDK row event → `SubscriptionManager.fanOut` → `ValidAtTable.insert/update/delete` (writes `server`) → `promote(now)` (writes `current`, fires `ValidAtTable.subscribe`) → `mirrorCard` (writes `cardsLocal` with the inventory-loose preservation rule applied) → `fireCardLocal` (notifies `Card.onDataChange`, etc.).

### Tier-rule pitfall (load-bearing)
Reading `data.cards.current` from game code looks fine — the row exists, the fields are populated — but for any inventory-loose card the server's `microLocation` is **always 0** (the server doesn't track inventory pixel coords; that's exactly what the `mirrorCard` preserve rule exists for). So `decodeLooseXY(currentRow.microLocation)` returns `(0, 0)` regardless of where the player actually placed the card. Symptoms when this rule is broken: surviving children of a spliced card snap to (0,0); orphan-fallback paths reposition cards to the corner; chain-walking helpers (`rootOf`, `validatedSlot`, `flipChain`) get the wrong parent during a drag because the server tier hasn't been told yet. Anything that needs to know "where the player can see this card right now" reads `cardsLocal`. The only legitimate `data.cards.*` consumers are `mirrorCard` itself, `promote(now)`, and the `subscribeCards` SQL helpers.

### `mirrorCard` rule (cards only)
When the server pushes an updated card row, `mirrorCard` checks:
- Existing `cardsLocal` row exists for this id, AND
- Server row's `surface === INVENTORY_LAYER` (1), AND
- Local row's `surface === INVENTORY_LAYER`, AND
- `unpackMicroZone(serverRow.microZone).localQ === 0`.

If all true → **position fields preserved from local** (`macroZone`, `microZone`, `microLocation`, `surface`); other fields (`flags`, `packedDefinition`, `ownerId`, `validAt`, `cardId`) merge from server. Otherwise → server row replaces local in full (e.g. card transitions out of inventory, gets stacked, dies). Server is always authoritative for everything except inventory pixel placement, which is a client concern.

### Dead-card extension (`LocalCard.dead`)
`LocalCard = Card & { dead?: 1 | 2 }`. The `dead` field is a client-only marker, not part of the SDK row:
- `dead: 1` — set by `mirrorCard` when the incoming server row carries `flags & FLAG_ACTION_DEAD` (bit 7). This is the signal `RectCard.applyData` watches to start the death animation.
- `dead: 2` — written back to local by `RectCard` once the visual finish step has run, so a second mirror push of the same dead row doesn't replay the animation.
- Cleared implicitly when the server eventually DELETEs the row and `mirrorCard` fires `removed`.

Because the server marks death via UPDATE (not DELETE) so the row carries `valid_at`, the row **lingers in `cardsLocal` for the full reap delay**, still at its old position. Live-world consumers (inventory layout's overlap-push, recipe matcher, anything else that iterates "cards in play") must skip rows where `dead` is truthy or the dying card collides with its own just-orphaned children. The DELETE that finally evicts the row is what triggers `CardManager.destroy`.

### Drag-drop flow
1. `DragManager.handleDragStop` → `card.setPosition({kind: "loose", x, y})`.
2. `Card.setPosition` → `cardManager.setCardPosition(id, state)`.
3. `setCardPosition` builds the new row (encoded `microLocation`, cleared stack bits) and calls `data.setLocalCard(id, newRow)`.
4. `setLocalCard` writes `cardsLocal`, fires `{kind: "updated", oldRow, newRow}` to local-cards subscribers.
5. `Card.onDataChange` listener runs → `gameCard.applyData(newRow)` + `layoutCard.applyData(newRow)` → next layout pass tweens display to the new target.
6. No data ever lands in `data.cards.server`; the server tier is untouched.

## Conventions
- **`ConnectionManager` is the SDK boundary for connect/disconnect**, `SubscriptionManager` is the boundary for SDK row events, `ReducerManager` is the boundary for reducer calls. Nothing outside this folder constructs a `DbConnectionBuilder`, calls `conn.db.<table>.onInsert`, or calls `conn.reducers.<name>` directly.
- **Server tier is read-only.** Never call `data.cards.insert(...)` / `data.cards.update(...)` outside the SubscriptionManager's bound row handlers. To mutate displayed state, write to the local tier via `setLocalCard`.
- **Game code reads from `cardsLocal`.** `data.cards.current` is the server-derived snapshot; consumers that should respect inventory-local position go through the overlay.
- **Subscribe through DataManager's local channel**, not ValidAtTable directly. `Card` and `CardManager` use `data.subscribeLocalCardKey(id, listener)` and `data.subscribeLocalCard(listener)` so they react to BOTH server-driven mirror events AND client-driven overlay writes through the same path.
- **Row keys are packed u64.** Each table's primary key on the server is `validAt: u64` whose high 32 bits hold the row's id and low 32 bits hold the absolute-second unix timestamp at which the row becomes valid. The bindings expose this directly as `row.validAt` (a `bigint`). Multiple rows per id can coexist; `promote(now)` collapses them to a single `current` row per id.
- **One SDK callback per (table, event), bound on every connect.** `bindHandlers(conn)` runs from the `onConnected` listener inside `SubscriptionManager`. Each SDK callback fans out to every registered handler in the order they registered. Per-handler `try/catch` so one bad handler can't break the others. Old bindings are GC'd with the old connection — no manual `removeOnInsert` needed.
- **Subscription registry.** Each subscription has a `name` (the table-ish slot) and a `scopeKey` (e.g. `"zone:42"`). `installSubscription(name, def)` dedups same-name+same-scope, swaps on scope change, opens fresh on new name. In-flight subscriptions share a `Promise<void>` so concurrent callers don't double-issue.
- **Reconnect re-issues every active subscription.** On `onDisconnect`, every subscription's handle is nulled (no row-store wipe — the registry survives). On the next `onConnected`, SDK row handlers are re-bound and `reissueAllSubscriptions` re-runs `subscribeRaw` for each entry in parallel.
- **Multi-listener fan-out on `ConnectionManager`.** Use `addListener({...})` and keep the unsubscribe fn for teardown. Listener errors are caught and logged.
- `TokenStore` is pluggable. Default is `localStorageTokenStore`; tests can inject in-memory stores. Don't read/write `localStorage` for token state outside this module.
- `connect()` is idempotent and de-duplicated. The `subscribe<Table>` helpers are de-duplicated via the registry's `scopeKey` and `inFlight`. The generic `subscribe(query)` is NOT de-duplicated — each call issues a fresh SDK subscription and isn't tracked.

## Pitfalls
- `bindHandlers` runs on every successful connect, so each handler must be self-contained (no closure state from a previous connection). Registered handlers in `SubscriptionManager.handlers` ARE preserved across reconnects — the registry is what re-binds.
- `getConnection()` returns `null` after disconnect. Don't cache it; re-fetch via `await connection.connect()` per operation.
- `subscribeRaw` rejects with the SDK's error when available (read off `ErrorContext.event.error`); falls back to a synthetic message naming the queries. Don't catch and swallow — bad SQL or permission errors deserve to surface.
- The bindings path (`spacetime/bindings/`) and the database name (`resonantdust-dev`, see `../../spacetime/server/spacetime.json`) are tightly coupled to the spacetime project. Regenerate bindings whenever the server schema changes.
- `disconnect()` is fire-and-forget; the SDK does not expose an awaitable close.
- **Stored rows are not frozen.** `ValidAtTable` does not shallow-freeze rows on insert. Treat rows from `server` / `current` / `*Local` as read-only by convention; mutating them in place corrupts the local view AND breaks `mirrorCard`'s reference-equality short-circuits.
- **`row.validAt` is `bigint`, not `number`.** The packed key is a u64. Using JS `number` math on it loses precision past 2^53. Helpers in `packing.ts` work in `bigint`; stay in `bigint` until you need the unpacked components.
- `mirrorCard`'s inventory-loose rule does not propagate position changes from server to client when both sides agree on inventory-loose — by design. If the server *does* need to move a card within an inventory zone (admin teleport, anti-cheat reset), the server row must NOT match the rule (e.g. transition through a non-inventory state, or set `localQ != 0`) for the change to land on the client.

## Stripped / not yet wired
- **`actions` and `magnetic_actions` tables** are not in `TableRowMap` and have no row handlers. The client only sees recipe outcomes via the affected `cards` rows (slot_hold / dead flags). `subscribeActions` / `subscribeMagneticActions` build SQL but the rows would be silently dropped by SubscriptionManager's fan-out today.
- **World tier** is mostly stripped — `subscribeWorldZone` / `subscribeWorldPlayers` exist, `WORLD_LAYER` is defined, but the world surface and world-tier card positioning are commented out across the rest of the codebase.
- **No display buffer.** `promote(now)` accepts any `now`, so a client-side latency cushion can be added at the call site by passing `wallClock - bufferSeconds` — but `main.ts` currently uses raw `Date.now() / 1000`.
