# AGENTS.md

## Purpose
The unified post-login scene. Replaces the old `GameScene` + `CharacterSelectScene` pair: one `Scene` instance lives for the entire logged-in session. There are no browse/play modes — every surface is an independent PixiPanel managed by `ctx.panels` (PanelManager) that the user opens, closes, moves, and focuses on its own.

## Important files
- `MainScene.ts`: scene lifecycle. Owns the always-on managers (`CardManager`, `LayoutManager`, `MainManager`, `InputManager`, `DragManager`, `ActionManager`, `LogManager`, `ChatPanel`, `ParticleManager`), installs the always-on KeyE / Space / left-click handlers (routed through `ctx.panels.focused(...)` to the focused inventory / game-view), and opens the default panels on login.
- `MainLayout.ts`: the `LayoutNode` tree + z-ordered layers (`gameviewLayer` / `inventoryLayer` / `chooserLayer` / `overlay`). Hosts the always-on `blueprints` and `details` panels as direct children, and exposes the `open*` helpers (`openWorldView`, `openGameViewPanel`, `openInventoryPanel`, `openMiniInventoryPanel`, `openPlayerInventoryPanel`) that get-or-create their panels via `PanelManager.ensure`.
- `MainManager.ts`: scene-scoped fixed-tick game-logic driver (renamed from the old `GameManager`). Always-on; dispatches `update(dt)` to registered `GameInventory` instances. The registered set is empty until an inventory panel registers one, so an idle scene costs nothing. `dispose()` clears the tick set but does NOT dispose registered inventories — ownership lives with the caller of `add` (the inventory panel that built it).

## Initial construction order in `MainScene.onEnter`
Order is load-bearing — each step depends on `ctx` slots set by the previous:
1. `PanelManager` → `ctx.panels`.
2. `LayoutManager` → `ctx.layout` (so surface registration works before any consumer registers).
3. `MainLayout` (constructs the `LayoutWorld`s that register world-zone surfaces on every `ZoneManager.onAdded("active")` fire).
4. `CardManager` → `ctx.cards` (spawns Cards for everything in `cardsLocal`; cards with no surface yet defer attach via `LayoutCard`).
5. `MainManager` → `ctx.game`; `InputManager` → `ctx.input`; `DragManager`; `ActionManager` → `ctx.actions` (subscribes to `ctx.cards` stack-change events); `LogManager` → `ctx.logs`; `ChatPanel`; `ParticleManager`.
6. `subscribeOwnedCards(playerId)` + `startTrackingOwnedSoulInventories()` — the player's soul rows plus an inventory-zone refcount per owned soul.
7. Open the default panels (world view, player inventory) and install input handlers.

`onExit` disposes in roughly reverse order.

## Conventions
- **Drag is always wired.** `DragManager` is on for the whole scene; whether the server accepts a drag is a permissions concern — see `game/permissions.ts` (`canPickUpCard` walks the card's ownership chain to a player).
- **Panels are keyed in PanelManager** by `<type>:<id>` (`gameview:<soulId>`, `inventory:<soulId>`) or a bare singleton key (`details`, `blueprints`). `ensure(key, factory)` get-or-creates and focuses; `focused(prefix)` returns the most-recently-focused panel of a type.
- **`GameInventory`** (per-tile physics + overlap-push + snap-to-grid) is built by the inventory panel that needs it and registered with `MainManager` for ticking; the two stay constructed/disposed in lockstep with the panel's inventory-zone subscription.

> **Mid-migration:** the active-soul / soul-follow wiring is being reworked toward the player-soul model (a player *is* a player-soul card; world-souls hang off it). The `openWorldView` / soul-tracking specifics above will shift as that lands — verify against the code rather than trusting this section for those details.
