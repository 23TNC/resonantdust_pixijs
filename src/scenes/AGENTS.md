# AGENTS.md

## Purpose
Scene system: lifecycle, transitions, and the per-frame update loop. Owns the Pixi `Application.stage` root.

## Important files
- `Scene.ts`: abstract base. Defines the `onEnter` / `onExit` / `onResize` / `update` contract.
- `SceneManager.ts`: orchestrates transitions. Owns the ticker callback and the window resize listener.
- `LoginScene.ts`: first scene; calls `ctx.playerSession.claimOrLogin(...)` and transitions to `GameScene` on success.
- `GameScene.ts`: in-game scene. Reads the local player from `ctx.playerSession`; constructs and wires up the scene-scoped managers (`LayoutManager`, `CardManager`, `GameManager` + `GameInventory`, `InputManager`, `DragManager`, `ActionManager`, `WorldPanManager`, `ParticleManager`); calls `ctx.zones.ensure(inventoryZoneId)` to pin the inventory subscription; binds keyboard shortcuts (e.g. `KeyE` for snap-to-grid). On exit, disposes everything in reverse order and clears the scene-scoped fields on `GameContext`.
- `game/`: per-region layout nodes for `GameScene` (title bar, world view, inventory view, overlay). Has its own AGENTS.md.

## Conventions
- A scene's only access to services is the `GameContext` passed to `onEnter`. Cache the parts you need on the scene instance — don't reach for globals.
- `onEnter` and `onExit` may be async. `SceneManager` awaits both.
- `update(deltaMS)` is the **canonical timebase**: real-time milliseconds since last frame (PIXI `Ticker.deltaMS`). All scene logic uses this; don't introduce a parallel timebase.
- `this.width` / `this.height` are kept current by `SceneManager` (set just before `onResize` fires). Read them from anywhere — `update`, click handlers, etc. — instead of caching `onResize` arguments.
- Scenes attach children to `this.root` (a Pixi `Container` created in the base class). `SceneManager` adds `root` to `app.stage` only after `onEnter` resolves — partial scenes are never visible.
- `SceneManager.change()` serializes through a promise chain; calling it concurrently is safe and ordered.
- Navigate by calling `ctx.scenes.change(new NextScene())` from inside a scene.
- **GameScene owns the scene-scoped slots on `GameContext`.** `cards`, `layout`, `game`, `input`, `actions`, `world` get assigned in `onEnter` and nulled in `onExit`. Other code reading them must null-check; managers that depend on them (e.g. `WorldPanManager` reading `ctx.input`) throw cleanly in their constructor if a slot is null.

## Pitfalls
- Do **not** manually `destroy()` `this.root` — `SceneManager` does that after `onExit`.
- `update`/`onResize` never fire on a scene whose `onEnter` hasn't resolved (the manager only assigns `current` after); but they *do* fire on the previous scene up until `onExit` starts. If you start coroutines in `onEnter`, cancel them in `onExit`.
- `SceneManager.dispose()` aborts in-flight transitions and tears down the ticker/resize listener — required for HMR. Don't bypass it.
- If a scene throws from `onEnter`, the previous scene is already destroyed and `current` is `null`. The error propagates from `change()`; callers decide recovery.
- **Order matters in `GameScene.onEnter`.** `LayoutManager` first (so child views can register surfaces), then `GameLayout` (which creates `LayoutWorld` and `LayoutInventory` — both call `LayoutManager.register`), then `CardManager` (depends on `ctx.layout` for surface lookups), then everything that depends on `ctx.cards` (`GameInventory`, `ActionManager`). Reverse-order disposal keeps consumers from observing a torn-down dependency.
