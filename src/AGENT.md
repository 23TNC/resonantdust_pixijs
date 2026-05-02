# AGENT.md

## Purpose
TypeScript source root. Module boundaries map 1:1 to subdirectories.

## Important files
- `main.ts`: entry point. Builds `Application`, instantiates managers, assembles `GameContext`, hands control to `SceneManager`. HMR-safe.
- `GameContext.ts`: the cross-cutting service container. Every scene receives this in `onEnter`. To add a new shared service, add a field here and wire it in `main.ts`.
- `scenes/`: scene lifecycle and transitions.
- `layout/`: `LayoutNode` base (rect tree, two-flag dirty propagation, hit testing, ctx walk-up) + `LayoutManager` (scene-scoped surface registry; LayoutCards look up parent surfaces by ZoneId). UI components extend `LayoutNode`.
- `server/`: SpacetimeDB connection (incl. `subscribe(query)`), token, and (generated) bindings.
- `state/`: `ShadowedStore<T>` (server + client maps with subscribe) and `DataManager` (per-table stores + spacetime subscription wiring).
- `zones/`: `ZoneManager` — registry of zones the client cares about, partitioned into Active/Hot/Cold tiers with per-tier add/remove listeners + refcounted `ensure(zoneId)`. DataManager listens; ensures drive cards subscriptions.
- `game/`: `GameManager` (scene-scoped, fixed-rate tick) + `GameInventory` (per-zone game logic, overlap-push on loose cards). Decoupled from the render frame rate.
- `input/`: `InputManager` — scene-scoped pointer router. Hooks DOM events on `app.canvas`, hit-tests at down/up only, emits `left_down` / `left_drag_start` / `left_up` / `left_click` / `left_drag_stop`. Up-time events carry `{ down, up }`.
- `cards/`: runtime card objects (`Card` composite + `GameCard` / `LayoutCard` halves + concrete `GameRectCard` / `LayoutRectCard` / `GameHexCard` / `LayoutHexCard`, plus `CardManager`). **Scene-scoped** — owned by the scene that needs them.
- `features/`: domain-shaped wrappers around tables/reducers (PlayerSession, …). Scenes go through these; never through `server/bindings` directly.
- `definitions/`: static card-definition catalog.
- `data/`: symlinked data submodule (read-only from pixijs's perspective).

## Conventions
- Scenes get services via `GameContext` only — no module-level singletons, no global imports of managers.
- Adding a new module: create `src/<module>/`, give it an AGENT.md, expose one class/object as the public surface, import into `main.ts` and add to `GameContext`.
- `tsconfig.json` defines `@/*` → `./src/*` but most files use relative imports; either is fine, stay consistent within a module.
- Defensive constructors: validate input shape, throw on contract violation. Don't accept malformed data and warn — that hides bugs across rewrites.

## Pitfalls
- `GameContext` is constructed once in `main.ts`. `SceneManager.setContext` rejects double-set. Don't try to mutate it after bootstrap.
- `spacetime` is always present (`SpacetimeManager<DbConnection>`) but the websocket may not be connected yet. Scenes that need an active connection should `await ctx.spacetime.connect()` (idempotent and deduped) or check `isConnected`.
- `data/` is a symlink — globs work (Vite follows symlinks) but the files belong to the data repo.
