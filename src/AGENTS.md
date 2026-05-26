# AGENTS.md

## Purpose
TypeScript source root. Module boundaries map 1:1 to subdirectories.

## Important files
- `main.ts`: entry point. Builds `Application`, awaits `initDefinitions()` (boots the wasm content crate), instantiates managers, assembles `GameContext`, hands control to `SceneManager`. HMR-safe.
- `GameContext.ts`: the cross-cutting service container. Every scene receives this in `onEnter`. To add a new shared service, add a field here and wire it in `main.ts`.
- `debug/`: `index.ts` — console-style logger gated by tag (`debug.log(["zone"], …)`). `DrawCallCounter.ts` patches `Renderer.render` to count GPU submissions for the FPS readout.
- `scenes/`: scene lifecycle and transitions; `scenes/login/` (login form + claimOrLogin), `scenes/main/` (the unified post-login scene with browse + play modes, see [scenes/main/AGENTS.md](scenes/main/AGENTS.md)).
- `server/`: dual-tier data layer + SpacetimeDB SDK boundary. `server/spacetime/` has the SDK managers (Connection / Subscription / Reducer) + bindings; `server/data/` has `DataManager` (overlays + ValidAtTables) and `packing.ts`. `server/player/PlayerManager.ts` is the one feature-shaped wrapper here.
- `game/`: game-domain modules. Subdirectories:
  - `game/cards/`: `Card` composite + `CardGame` / `CardLayout` halves + concrete `RectCard` / `HexCard` subclasses, plus `CardManager`, plus `cardData.ts` (bit-pack helpers — being folded into `server/data/packing.ts`).
  - `game/cards/layout/{rectangle,hexagon}/`: shape-specific visual primitives (`RectVisual`, `HexVisual`) and the `RectCard` / `HexCard` subclasses.
  - `game/chat/`: `ChatPanel` (DOM-based panel built on `ui/dom/DomPanel`; general + logs tabs) + `LogManager` (scene-scoped ring buffer of flavor-text events). See [game/chat/AGENTS.md](game/chat/AGENTS.md).
  - `game/definitions/DefinitionManager.ts`: wasm-backed wrapper around the `resonantdust-content` crate's `definition_core`. Boot via `initDefinitions()` in `main.ts`.
  - `game/input/`: `InputManager` — scene-scoped pointer + key router. `DragManager` orchestrates card drag. `DragGhost` is a translucent ghost-drag visual for non-pickup flows.
  - `game/inventory/`: `InventoryGame` (per-zone game logic, overlap-push on loose cards) + `InventoryLayout` (the right-pane surface; self-registers with LayoutManager).
  - `game/layout/`: `LayoutNode` base (rect tree, two-flag dirty propagation, hit testing, ctx walk-up) + `LayoutManager` (scene-scoped surface registry).
  - `game/lifecycle/`: `LifecycleResolutionManager` — observes cards carrying `FLAG_LIFECYCLE_PENDING` owned by the local player and submits the recipe declared in their def's `lifecycle:` block (magnetic anchors AND on_create-style decay cards under the [LIFECYCLE_REWRITE](../../docs/LIFECYCLE_REWRITE.md)).
  - `game/permissions.ts`: `canPickUpCard(ctx, card)` — the single ownership-check entry point for card drag pickup; walks the `ownerId` chain through `cardsLocal`.
  - `game/titlebar/`: `DebugPanel` + `SettingsMenu` — DOM panels (built on `ui/dom/DomPanel`) pinned to the top taskbar. Despite the directory name, the old Pixi `TitleBar` component is gone; the directory just holds the two title-bar-like dropdowns.
  - `game/toolbar/`: `ToolBar` — top-left emoji-button strip; width derived from the button list (`MainLayout` reads `ToolBar.WIDTH` to position it).
  - `game/world/`: `LayoutWorld` (hex tile grid + world card surface) + `WorldPanManager` (drag-to-pan + recenter tween). See [game/world/AGENTS.md](game/world/AGENTS.md).
  - `game/zones/`: `ZoneManager` — tiered zone refcount with per-tier add/remove listeners.
- `ui/dom/`: shared DOM-based panel infrastructure — `DomPanel` (chrome, drag, resize, persistence), `PanelTaskbar` (Windows-style taskbar entries), `PixiPanel` (DOM shell hosting Pixi content), `PanelSettingsPopup` (per-panel config popover), `UiEditMode` (app-wide edit-mode flag + grid geometry), `CyclingSelect`, `pointerInteractions`. See [ui/dom/AGENTS.md](ui/dom/AGENTS.md).
- `assets/`: bootstrap-scoped `TextureManager` (card-visual atlas) + scene-scoped `ParticleManager` (JSON-driven emitters) + `fonts.ts` (`loadFonts()` / `NOTO_EMOJI_FAMILY` — registers NotoEmoji font faces before first render).
- `content/`: **submodule** (its own git repo, `resonantdust_content`). Wasm bundle lives at `content/pkg/resonantdust_content.{js,wasm,d.ts}`, regenerated via `bin/content wasm`. Don't write through the path without realizing you're editing a separate git repo. The repo-root `content/` is a symlink into this path so the SpacetimeDB compose mount and `bin/content` can address it from a stable location.

## Conventions
- Scenes get services via `GameContext` only — no module-level singletons, no global imports of managers.
- Services on `GameContext` come in two lifetimes: bootstrap-scoped (always present: `connection`, `reducers`, `data`, `definitions`, `playerSession`, `souls`, `zones`, `textures`, `drawCallCounter`, `scenes`, `app`, `taskbar`, `topTaskbar`, `uiEditMode`, `debugPanel`, `settingsMenu`) and scene-scoped (`cards`, `layout`, `game`, `input`, `actions`, `logs` — null between scenes). Scene-scoped fields are set in `MainScene.onEnter` and cleared in `onExit`; consumers must null-check or rely on construction-time invariants. `MainScene` sets all six regardless of mode (browse vs play); soul-dependent pieces — `GameInventory`, viewport anchor, KeyE/Space/click handlers — are constructed lazily on `MainScene.enterPlayMode(soulId)` and torn down on `MainScene.enterBrowseMode()`.
- Adding a new module: create `src/<module>/`, give it an AGENTS.md, expose one class/object as the public surface, import into `main.ts` and add to `GameContext` if cross-cutting.
- `tsconfig.json` defines `@/*` → `./src/*` but most files use relative imports; either is fine, stay consistent within a module.
- Defensive constructors: validate input shape, throw on contract violation. Don't accept malformed data and warn — that hides bugs across rewrites.

## Pitfalls
- `GameContext` is constructed once in `main.ts`. `SceneManager.setContext` rejects double-set. Don't try to mutate it after bootstrap (except for the documented scene-scoped slots).
- `connection` is always present but the websocket may not be open yet. Scenes that need an active connection should `await ctx.connection.connect()` (idempotent, deduped) or check `isConnected`.
- `content/` is a submodule — globs work (Vite follows symlinks) but the files belong to a separate git repo. Wasm imports go through `content/pkg/resonantdust_content`; that path TS-errors until `bin/content wasm` has been run at least once.
- Partially stubbed: `RecipeManager` (the `recipes` field on `GameContext`) is commented out — recipe display and management are unimplemented client-side even though `ActionManager` fires recipe proposals via `proposeAction`. There is no server-side actions table; recipe outcomes are observed via flag changes on `cards` rows (`slot_hold`, `dead`). Lifecycle resolution (magnetic anchors + on_create decay) is client-driven via [game/lifecycle/LifecycleResolutionManager.ts](game/lifecycle/LifecycleResolutionManager.ts) — see [docs/LIFECYCLE_REWRITE.md](../../docs/LIFECYCLE_REWRITE.md).
