# AGENTS.md

## Purpose
TypeScript source root. Module boundaries map 1:1 to subdirectories.

## Important files
- `main.ts`: entry point. Builds `Application`, instantiates managers, assembles `GameContext`, hands control to `SceneManager`. HMR-safe.
- `GameContext.ts`: the cross-cutting service container. Every scene receives this in `onEnter`. To add a new shared service, add a field here and wire it in `main.ts`.
- `debug.ts`: console-style logger gated by tag (`debug.log(["zone"], …)`); `debug/DrawCallCounter.ts` patches `Renderer.render` to count GPU submissions for the FPS readout.
- `scenes/`: scene lifecycle and transitions.
- `layout/`: `LayoutNode` base (rect tree, two-flag dirty propagation, hit testing, ctx walk-up) + `LayoutManager` (scene-scoped surface registry; LayoutCards look up parent surfaces by ZoneId, plus a hit-passthrough overlay for drag previews).
- `server/`: SpacetimeDB connection (incl. `subscribe(query)`), token, and (generated) bindings.
- `state/`: `ShadowedStore<T>` (server + client maps with subscribe) and `DataManager` (per-table stores for `cards`, `players`, `actions`, `magneticActions`, `zones` + spacetime subscription wiring).
- `zones/`: `ZoneManager` — registry of zones the client cares about, partitioned into Active/Hot/Cold tiers with per-tier add/remove listeners + refcounted `ensure(zoneId)`. Also owns named world anchors (`"viewport"`, `"player"`); moving an anchor reshapes the active world-zone set automatically.
- `world/`: `LayoutWorld` (hex tile grid + world-card surface), `WorldPanManager` (drag-on-empty-world ⇒ viewport anchor movement), `worldCoords.ts` (server `macroZone` codec, `decodeZoneTiles`, neighborhood selector).
- `game/`: `GameManager` (scene-scoped, fixed-rate tick) + `GameInventory` (per-zone game logic, overlap-push on loose cards). Decoupled from the render frame rate.
- `input/`: `InputManager` — scene-scoped pointer + key router. Hooks DOM events on `app.canvas`, hit-tests at down/up only, emits `left_*` pointer events and `key_down` / `key_up`. `DragManager` orchestrates card drag.
- `cards/`: runtime card objects (`Card` composite + `GameCard` / `LayoutCard` halves + concrete `GameRectCard` / `LayoutRectCard` / `GameHexCard` / `LayoutHexCard`, plus `CardManager`). `RectCardVisual` / `HexCardVisual` are the reusable visual primitives baked into `TextureManager`'s atlas. `StatusBar` exposes per-aspect icons used by card overlays. **Scene-scoped** — owned by the scene that needs them.
- `actions/`: `ActionManager` — client-side recipe upgrade pre-filter that mirrors server matching to skip no-op submissions.
- `assets/`: bootstrap-scoped `TextureManager` (card-visual atlas) + scene-scoped `ParticleManager` (JSON-driven emitters).
- `features/`: domain-shaped wrappers around tables/reducers (`PlayerSession`, …). Scenes go through these; never through `server/bindings` directly.
- `definitions/`: static card-definition catalog (`DefinitionManager`) and recipe registry (`RecipeManager`) — both bundled at build time from the data submodule.
- `data/`: symlinked data submodule (read-only from pixijs's perspective).

## Conventions
- Scenes get services via `GameContext` only — no module-level singletons, no global imports of managers.
- Services on `GameContext` come in two lifetimes: bootstrap-scoped (always present) and scene-scoped (`cards`, `layout`, `game`, `input`, `actions`, `world` — null between scenes). Scene-scoped fields are set in `GameScene.onEnter` and cleared in `onExit`; consumers must null-check or rely on construction-time invariants (e.g. `ActionManager` ctor throws if `ctx.cards` is null).
- Adding a new module: create `src/<module>/`, give it an AGENTS.md, expose one class/object as the public surface, import into `main.ts` and add to `GameContext`.
- `tsconfig.json` defines `@/*` → `./src/*` but most files use relative imports; either is fine, stay consistent within a module.
- Defensive constructors: validate input shape, throw on contract violation. Don't accept malformed data and warn — that hides bugs across rewrites.

## Pitfalls
- `GameContext` is constructed once in `main.ts`. `SceneManager.setContext` rejects double-set. Don't try to mutate it after bootstrap (except for the documented scene-scoped slots).
- `spacetime` is always present (`SpacetimeManager<DbConnection>`) but the websocket may not be connected yet. Scenes that need an active connection should `await ctx.spacetime.connect()` (idempotent and deduped) or check `isConnected`.
- `data/` is a symlink — globs work (Vite follows symlinks) but the files belong to the data repo.
