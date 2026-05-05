# AGENT.md

## Purpose
Domain-shaped feature modules that wrap SpacetimeDB tables/reducers behind narrow APIs. Sit between `SpacetimeManager` (network plumbing) and scenes (UI).

## Important files
- `PlayerSession.ts`: owns the `players` subscription and the `claim_or_login` reducer; tracks the local player.

## Conventions
- One concern per module (one or a few related tables/reducers).
- Constructed once in `main.ts`; lives on `GameContext`. Scenes never import from `../server/bindings` — they go through a feature module.
- Each module calls `spacetime.connect()` itself before subscribing/calling reducers — never assume the connection is up.
- Each module exposes `dispose()` that unsubscribes handles, clears caches, and drops listener sets. Called from main.ts HMR teardown.
- Public API is domain-shaped (`claimOrLogin(name)`, `getPlayer()`), not table-shaped.

## Pitfalls
- Reducer calls return `Promise<void>` that resolves when the call is *sent*, not when its side effect lands. Wait for table events (`onInsert`/`onUpdate`) — with a timeout — to know the effect arrived.
- Subscriptions persist until `unsubscribe()`. Leaking them across HMR multiplies traffic.
- `getConnection()` may become null on disconnect. Re-fetch via `await spacetime.connect()` per operation rather than caching the connection on the module.
- Adding a new feature module: also add it to `GameContext` and dispose it from `main.ts`.
