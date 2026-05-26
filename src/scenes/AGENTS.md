# AGENTS.md

## Purpose
Scene system: lifecycle, transitions, and the per-frame update loop. Owns the Pixi `Application.stage` root.

## Important files
- `Scene.ts`: abstract base. Defines the `onEnter` / `onExit` / `onResize` / `update` contract.
- `SceneManager.ts`: orchestrates transitions. Owns the ticker callback and the window resize listener.
- `login/LoginScene.ts`: first scene; calls `ctx.playerSession.claimOrLogin(...)` and transitions to `MainScene` on success.
- `main/MainScene.ts`: post-login scene. Hosts two modes — **browse** (chooser visible, world hidden) and **play** (chooser destroyed, world / toolbar / wrench / details visible). The character-create flow is a sub-mode of browse. See [main/AGENTS.md](main/AGENTS.md).

## Conventions
- A scene's only access to services is the `GameContext` passed to `onEnter`. Cache the parts you need on the scene instance — don't reach for globals.
- `onEnter` and `onExit` may be async. `SceneManager` awaits both.
- `update(deltaMS)` is the **canonical timebase**: real-time milliseconds since last frame (PIXI `Ticker.deltaMS`). All scene logic uses this; don't introduce a parallel timebase.
- `this.width` / `this.height` are kept current by `SceneManager` (set just before `onResize` fires). Read them from anywhere — `update`, click handlers, etc. — instead of caching `onResize` arguments.
- Scenes attach children to `this.root` (a Pixi `Container` created in the base class). `SceneManager` adds `root` to `app.stage` only after `onEnter` resolves — partial scenes are never visible.
- `SceneManager.change()` serializes through a promise chain; calling it concurrently is safe and ordered.
- Navigate by calling `ctx.scenes.change(new NextScene())` from inside a scene. There are only two scenes today (`LoginScene`, `MainScene`); future surfaces (settings, replay viewer) likely become more PixiPanel modes inside `MainScene` rather than new scenes.
- **MainScene owns the scene-scoped slots on `GameContext`.** `cards`, `layout`, `game`, `input`, `actions`, `logs` get assigned in `onEnter` and nulled in `onExit` — all six are set regardless of mode (browse mode just doesn't *use* the inventory side of the wiring until a soul is selected). Other code reading them must null-check; managers that depend on them (e.g. `WorldPanManager` reading `ctx.input`) throw cleanly in their constructor if a slot is null. `LayoutWorld` is owned by `MainLayout`, not a `GameContext` slot — access the world card surface via `ctx.layout.surfaceFor(zoneId)` for world-layer zones.

## Pitfalls
- Do **not** manually `destroy()` `this.root` — `SceneManager` does that after `onExit`.
- `update`/`onResize` never fire on a scene whose `onEnter` hasn't resolved (the manager only assigns `current` after); but they *do* fire on the previous scene up until `onExit` starts. If you start coroutines in `onEnter`, cancel them in `onExit`.
- `SceneManager.dispose()` aborts in-flight transitions and tears down the ticker/resize listener — required for HMR. Don't bypass it.
- If a scene throws from `onEnter`, the previous scene is already destroyed and `current` is `null`. The error propagates from `change()`; callers decide recovery.
- **Order matters in `MainScene.onEnter`.** `LayoutManager` first (so `MainLayout` can register surfaces during its constructor), then `MainLayout` (constructs `LayoutWorld` which registers world-zone surfaces on every `ZoneManager.onAdded("active")` fire), then `CardManager` (depends on `ctx.layout` for surface lookups), then everything that depends on `ctx.cards` (`ActionManager`, and `GameInventory` once `enterPlayMode` runs). Reverse-order disposal in `onExit` keeps consumers from observing a torn-down dependency.
- **`MainScene.enterPlayMode` / `enterBrowseMode` are the mode-flip API.** `enterPlayMode(soulCardId)` calls `souls.setActiveSoul`, asks the layout to swap chrome (destroy chooser → build inventory panel + LayoutInventory + ensure zone → show world surfaces), builds `GameInventory`, and wires play-mode key/click handlers. `enterBrowseMode` reverses every step. Both run synchronously — no awaits, no scene transition.
