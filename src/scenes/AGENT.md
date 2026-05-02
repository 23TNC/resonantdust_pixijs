# AGENT.md

## Purpose
Scene system: lifecycle, transitions, and the per-frame update loop. Owns the Pixi `Application.stage` root.

## Important files
- `Scene.ts`: abstract base. Defines the `onEnter` / `onExit` / `onResize` / `update` contract.
- `SceneManager.ts`: orchestrates transitions. Owns the ticker callback and the window resize listener.
- `LoginScene.ts`: first scene; calls `ctx.playerSession.claimOrLogin(...)` and transitions to `GameScene` on success.
- `GameScene.ts`: in-game scene; reads the local player from `ctx.playerSession`, renders via `game/GameLayout`, owns a scene-scoped `CardManager` (created in `onEnter`, disposed in `onExit`).
- `game/`: per-region layout nodes for `GameScene` (title bar, world, inventory). Has its own AGENT.md.

## Conventions
- A scene's only access to services is the `GameContext` passed to `onEnter`. Cache the parts you need on the scene instance — don't reach for globals.
- `onEnter` and `onExit` may be async. `SceneManager` awaits both.
- `update(deltaMS)` is the **canonical timebase**: real-time milliseconds since last frame (PIXI `Ticker.deltaMS`). All scene logic uses this; don't introduce a parallel timebase.
- `this.width` / `this.height` are kept current by `SceneManager` (set just before `onResize` fires). Read them from anywhere — `update`, click handlers, etc. — instead of caching `onResize` arguments.
- Scenes attach children to `this.root` (a Pixi `Container` created in the base class). `SceneManager` adds `root` to `app.stage` only after `onEnter` resolves — partial scenes are never visible.
- `SceneManager.change()` serializes through a promise chain; calling it concurrently is safe and ordered.
- Navigate by calling `ctx.scenes.change(new NextScene())` from inside a scene.

## Pitfalls
- Do **not** manually `destroy()` `this.root` — `SceneManager` does that after `onExit`.
- `update`/`onResize` never fire on a scene whose `onEnter` hasn't resolved (the manager only assigns `current` after); but they *do* fire on the previous scene up until `onExit` starts. If you start coroutines in `onEnter`, cancel them in `onExit`.
- `SceneManager.dispose()` aborts in-flight transitions and tears down the ticker/resize listener — required for HMR. Don't bypass it.
- If a scene throws from `onEnter`, the previous scene is already destroyed and `current` is `null`. The error propagates from `change()`; callers decide recovery.
