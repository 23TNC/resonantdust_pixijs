# AGENTS.md

## Purpose
TypeScript source root. Module boundaries map 1:1 to subdirectories.

## Important files
- `main.ts`: entry point. Builds `Application`, awaits `initDefinitions()` (boots the wasm content crate), instantiates managers, assembles `GameContext`, hands control to `SceneManager`. HMR-safe.
- `GameContext.ts`: the cross-cutting service container. Every scene receives this in `onEnter`. To add a new shared service, add a field here and wire it in `main.ts`.
- `debug.ts`: console-style logger gated by tag (`debug.log(["zone"], …)`); `debug/DrawCallCounter.ts` patches `Renderer.render` to count GPU submissions for the FPS readout.
- `scenes/`: scene lifecycle and transitions; `scenes/login/`, `scenes/game/`.
- `server/`: dual-tier data layer + SpacetimeDB SDK boundary. `server/spacetime/` has the SDK managers (Connection / Subscription / Reducer) + bindings; `server/data/` has `DataManager` (overlays + ValidAtTables) and `packing.ts`. `server/player/PlayerManager.ts` is the one feature-shaped wrapper here.
- `game/`: game-domain modules. Subdirectories:
  - `game/cards/`: `Card` composite + `GameCard` / `LayoutCard` halves + concrete `GameRectCard` / `LayoutRectCard` / `GameHexCard` / `LayoutHexCard`, plus `CardManager`, plus `cardData.ts` (legacy bit-pack helpers — being folded into `server/data/packing.ts`).
  - `game/cards/layout/{rectangle,hexagon}/`: shape-specific visual primitives (`RectVisual`, `HexVisual`) and the `Layout*Card` / `Game*Card` subclasses.
  - `game/definitions/DefinitionManager.ts`: wasm-backed wrapper around the `resonantdust-content` crate's `definition_core`. Boot via `initDefinitions()` in `main.ts`.
  - `game/inventory/`: `InventoryGame` (per-zone game logic, overlap-push on loose cards) + `InventoryLayout` (the right-pane surface; self-registers with LayoutManager).
  - `game/input/`: `InputManager` — scene-scoped pointer + key router. `DragManager` orchestrates card drag.
  - `game/layout/`: `LayoutNode` base (rect tree, two-flag dirty propagation, hit testing, ctx walk-up) + `LayoutManager` (scene-scoped surface registry).
  - `game/titlebar/`: `TitleBar` UI component.
  - `game/zones/`: `ZoneManager` — tiered zone refcount with per-tier add/remove listeners.
- `assets/`: bootstrap-scoped `TextureManager` (card-visual atlas) + scene-scoped `ParticleManager` (JSON-driven emitters).
- `content/`: **symlink** to `../../content/` (the content submodule). Wasm bundle lives at `content/pkg/resonantdust_content.{js,wasm,d.ts}`, regenerated via `bin/st wasm`. Don't write through the symlink without realizing you're editing a separate git repo.

## Conventions
- Scenes get services via `GameContext` only — no module-level singletons, no global imports of managers.
- Services on `GameContext` come in two lifetimes: bootstrap-scoped (always present: `connection`, `reducers`, `data`, `definitions`, `playerSession`, `zones`, `textures`, `drawCallCounter`, `scenes`, `app`) and scene-scoped (`cards`, `layout`, `game`, `input` — null between scenes). Scene-scoped fields are set in `GameScene.onEnter` and cleared in `onExit`; consumers must null-check or rely on construction-time invariants.
- Adding a new module: create `src/<module>/`, give it an AGENTS.md, expose one class/object as the public surface, import into `main.ts` and add to `GameContext` if cross-cutting.
- `tsconfig.json` defines `@/*` → `./src/*` but most files use relative imports; either is fine, stay consistent within a module.
- Defensive constructors: validate input shape, throw on contract violation. Don't accept malformed data and warn — that hides bugs across rewrites.

## Pitfalls
- `GameContext` is constructed once in `main.ts`. `SceneManager.setContext` rejects double-set. Don't try to mutate it after bootstrap (except for the documented scene-scoped slots).
- `connection` is always present but the websocket may not be open yet. Scenes that need an active connection should `await ctx.connection.connect()` (idempotent, deduped) or check `isConnected`.
- `content/` is a symlink — globs work (Vite follows symlinks) but the files belong to the content repo. Wasm imports go through `content/pkg/resonantdust_content`; that path TS-errors until `bin/st wasm` has been run at least once.
- Stripped subsystems: world tier (the `world: LayoutWorld` field on GameContext is commented out, world drops in DragManager are no-ops), actions (`ActionManager` and `actions: ActionManager | null` on GameContext are commented out), recipes (still stubbed). Several files have TODO comments where the restoration points are.
