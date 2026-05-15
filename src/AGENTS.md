# AGENTS.md

## Purpose
TypeScript source root. Module boundaries map 1:1 to subdirectories.

## Important files
- `main.ts`: entry point. Builds `Application`, awaits `initDefinitions()` (boots the wasm content crate), instantiates managers, assembles `GameContext`, hands control to `SceneManager`. HMR-safe.
- `GameContext.ts`: the cross-cutting service container. Every scene receives this in `onEnter`. To add a new shared service, add a field here and wire it in `main.ts`.
- `debug/`: `index.ts` — console-style logger gated by tag (`debug.log(["zone"], …)`). `DrawCallCounter.ts` patches `Renderer.render` to count GPU submissions for the FPS readout.
- `scenes/`: scene lifecycle and transitions; `scenes/login/` (login form + claimOrLogin), `scenes/select/` (character chooser, see [scenes/select/AGENTS.md](scenes/select/AGENTS.md)), `scenes/game/` (in-game scene).
- `server/`: dual-tier data layer + SpacetimeDB SDK boundary. `server/spacetime/` has the SDK managers (Connection / Subscription / Reducer) + bindings; `server/data/` has `DataManager` (overlays + ValidAtTables) and `packing.ts`. `server/player/PlayerManager.ts` is the one feature-shaped wrapper here.
- `game/`: game-domain modules. Subdirectories:
  - `game/cards/`: `Card` composite + `CardGame` / `CardLayout` halves + concrete `RectCard` / `HexCard` subclasses, plus `CardManager`, plus `cardData.ts` (bit-pack helpers — being folded into `server/data/packing.ts`).
  - `game/cards/layout/{rectangle,hexagon}/`: shape-specific visual primitives (`RectVisual`, `HexVisual`) and the `RectCard` / `HexCard` subclasses.
  - `game/chat/`: `ChatPanel` (bottom-left resizable tabbed panel — general chat + logs tab) + `LogManager` (scene-scoped ring buffer of flavor-text events). See [game/chat/AGENTS.md](game/chat/AGENTS.md).
  - `game/definitions/DefinitionManager.ts`: wasm-backed wrapper around the `resonantdust-content` crate's `definition_core`. Boot via `initDefinitions()` in `main.ts`.
  - `game/input/`: `InputManager` — scene-scoped pointer + key router. `DragManager` orchestrates card drag. `DragGhost` is a translucent ghost-drag visual for non-pickup flows.
  - `game/inventory/`: `InventoryGame` (per-zone game logic, overlap-push on loose cards) + `InventoryLayout` (the right-pane surface; self-registers with LayoutManager).
  - `game/layout/`: `LayoutNode` base (rect tree, two-flag dirty propagation, hit testing, ctx walk-up) + `LayoutManager` (scene-scoped surface registry).
  - `game/permissions.ts`: `canPickUpCard(ctx, card)` — the single ownership-check entry point for card drag pickup; walks the `ownerId` chain through `cardsLocal`.
  - `game/titlebar/`: `TitleBar` UI component.
  - `game/toolbar/`: `ToolBar` — top-left emoji-button strip; width derived from the button list (`GameLayout` reads `ToolBar.WIDTH` to position it).
  - `game/world/`: `LayoutWorld` (hex tile grid + world card surface) + `WorldPanManager` (drag-to-pan + recenter tween). See [game/world/AGENTS.md](game/world/AGENTS.md).
  - `game/zones/`: `ZoneManager` — tiered zone refcount with per-tier add/remove listeners.
- `assets/`: bootstrap-scoped `TextureManager` (card-visual atlas) + scene-scoped `ParticleManager` (JSON-driven emitters) + `fonts.ts` (`loadFonts()` / `NOTO_EMOJI_FAMILY` — registers NotoEmoji font faces before first render).
- `content/`: **symlink** to `../../content/` (the content submodule). Wasm bundle lives at `content/pkg/resonantdust_content.{js,wasm,d.ts}`, regenerated via `bin/st wasm`. Don't write through the symlink without realizing you're editing a separate git repo.

## Conventions
- Scenes get services via `GameContext` only — no module-level singletons, no global imports of managers.
- Services on `GameContext` come in two lifetimes: bootstrap-scoped (always present: `connection`, `reducers`, `data`, `definitions`, `playerSession`, `souls`, `zones`, `textures`, `drawCallCounter`, `scenes`, `app`) and scene-scoped (`cards`, `layout`, `game`, `input`, `actions`, `logs` — null between scenes). Scene-scoped fields are set in `GameScene.onEnter` and cleared in `onExit`; consumers must null-check or rely on construction-time invariants.
- Adding a new module: create `src/<module>/`, give it an AGENTS.md, expose one class/object as the public surface, import into `main.ts` and add to `GameContext` if cross-cutting.
- `tsconfig.json` defines `@/*` → `./src/*` but most files use relative imports; either is fine, stay consistent within a module.
- Defensive constructors: validate input shape, throw on contract violation. Don't accept malformed data and warn — that hides bugs across rewrites.

## Pitfalls
- `GameContext` is constructed once in `main.ts`. `SceneManager.setContext` rejects double-set. Don't try to mutate it after bootstrap (except for the documented scene-scoped slots).
- `connection` is always present but the websocket may not be open yet. Scenes that need an active connection should `await ctx.connection.connect()` (idempotent, deduped) or check `isConnected`.
- `content/` is a symlink — globs work (Vite follows symlinks) but the files belong to the content repo. Wasm imports go through `content/pkg/resonantdust_content`; that path TS-errors until `bin/st wasm` has been run at least once.
- Partially stubbed: `RecipeManager` (the `recipes` field on `GameContext`) is commented out — recipe display and management are unimplemented client-side even though `ActionManager` fires recipe proposals via `proposeAction`. The `actions` and `magnetic_actions` SpacetimeDB tables have no client-side row handlers; recipe outcomes are observed only via flag changes on `cards` rows (`slot_hold`, `FLAG_ACTION_DEAD`).
