# AGENTS.md

## Purpose
The unified post-login scene. Replaces the old `GameScene` + `CharacterSelectScene` pair. One `Scene` instance lives for the entire logged-in session and flips between two modes:

- **browse**: chooser PixiPanel visible (player picks a soul or creates one). World view + toolbar + wrench + details hidden. No `GameInventory` constructed. No viewport / soul anchors set. Inventory PixiPanel exists whenever there's a selected soul (preview) or — during the create sub-mode — a selected pack (preview).
- **play**: chooser destroyed. World + toolbar + wrench + details visible. `GameInventory` constructed for the active soul. Inventory PixiPanel shows the active soul's `LayoutInventory`. KeyE / Space / left-click handlers wired.

Mode flips synchronously via `MainScene.enterPlayMode(soulId)` / `MainScene.enterBrowseMode()`. The Play button calls the former; a future "change character" button can call the latter.

## Important files
- `MainScene.ts`: scene lifecycle + mode transitions + create-character flow. Owns the always-on managers (`CardManager`, `LayoutManager`, `MainManager`, `InputManager`, `DragManager`, `ActionManager`, `WorldPanManager`, `LogManager`, `ChatPanel`, `ParticleManager`) and the play-mode-only pieces tied to `activeSoulId` (viewport / soul anchors, KeyE/Space/click handlers).
- `MainLayout.ts`: the `LayoutNode` tree. Owns every panel: chooser (browse only), inventory (conditional on having a soul or pack to preview), **world** (always alive, opened in play / closed in browse), plus the play-mode overlays toolbar / wrench / details and the always-on overlay (drag previews). Owns the inventory zone subscription (`ctx.zones.ensureInventory(soulId)`) AND the `GameInventory` (per-tile physics + overlap-push + snap-to-grid) so the visual swap, zone subscription, and physics stay atomic — all three pieces live for as long as the inventory panel is in soul-preview mode. `GameInventory` therefore runs in browse mode too: dragging a soul's cards around in preview pushes neighbours just like in play. `layout()` reads `worldPanel.bodyRect` to position the toolbar / wrench / details overlays, so they follow when the player drags or resizes the world panel; in browse mode (or when the world panel is closed / minimized) those overlays are zero-sized + hidden.
- `MainManager.ts`: scene-scoped fixed-tick game-logic driver (renamed from the old `GameManager`). Always-on; runs the per-tick loop and dispatches `update(dt)` to registered `GameInventory` instances. In browse mode with no soul selected the registered set is empty so the loop costs nothing; in browse-with-preview mode the previewed soul's `GameInventory` is registered, same as play mode. `MainManager.dispose()` just clears the tick set — it does NOT dispose registered inventories. Inventory ownership lives with the caller of `add` (today `MainLayout`).
- `chooser/OwnedCardsPanel.ts`: select-submode chooser — renders the player's soul cards from `cardsLocal` filtered by `owner_id == playerId`, with selection (yellow outline) and a "Play" button. Independent of `CardManager` — uses its own standalone `RectCardVisual` / `HexCardVisual` instances.
- `chooser/PackChooserPanel.ts`: create-submode chooser — renders starter packs from `ctx.definitions`. Selection fires the layout's `handlePackSelected` which rebuilds the inventory panel as a preview.
- `chooser/PackContentsPanel.ts`: read-only preview of a starter pack's soul card + item list. Lives inside the inventory panel during the create sub-mode.

## State model
Two pieces of state, decoupled:

| Field | Lives on | Drives |
|-------|----------|--------|
| `selectedSoulId` | `MainLayout` | The inventory panel's lifecycle AND the `GameInventory` physics (both rebuilt per soul-id change). |
| `activeSoulId` | `MainScene` | The world view's visibility, the viewport / soul anchors, the play-mode key + click handlers. |

In browse mode, `activeSoulId === null` and `selectedSoulId` follows chooser clicks. In play mode they're equal (the active soul is also what the inventory panel previews). The `MainLayout.enterPlayMode(soulId)` call sets `selectedSoulId = soulId` as part of swapping chrome.

## Inventory panel rebuild protocol
Same four-step protocol the old `CharacterSelectLayout` used, now extracted to two helpers in `MainLayout`:

- `rebuildInventoryPanelAsSoulInventory(soulCardId)` — release prior zone → destroy old panel + content → build new `LayoutInventory` (registers surface) → ensure new zone (`zones.ensureInventory(soulId)`).
- `rebuildInventoryPanel(content | null)` — generic panel rebuild. `null` destroys; non-null `LayoutNode` rebuilds with that content. Used directly for pack previews and "no panel needed" states; wrapped by the soul-inventory helper for the zone-managed case.

Reversing the order (ensure zone before registering surface, destroy surface while cards are still attached, etc.) produces invisible cards or orphaned Pixi nodes. The deferred-attach machinery in `LayoutCard` covers some races but the protocol is still the contract.

## Initial construction order in MainScene.onEnter
1. `LayoutManager` → `ctx.layout` (so surface registration works before any consumer registers).
2. `MainLayout` (registers `worldView` for world zones via `ctx.zones.onAdded("active")`; builds chooser in browse-default state).
3. `layoutManager.overlay` / `layoutManager.worldView` wired from `MainLayout`'s own fields (drag previews land on `overlay`; world-card surface lookups go through `worldView`).
4. `CardManager` → `ctx.cards` (spawns Cards for everything in `cardsLocal`; cards with no surface yet defer attach via `LayoutCard.attach`'s onRegister listener).
5. `MainManager` → `ctx.game` (registered inventory set starts empty).
6. `InputManager` → `ctx.input` (canvas pointer events).
7. `DragManager` (subscribes to `ctx.input` events).
8. `ActionManager` → `ctx.actions` (subscribes to `ctx.cards` stack-change events).
9. `LogManager` → `ctx.logs`.
10. `ChatPanel` (constructs after `ctx.logs` is set — its constructor subscribes to logs).
11. `WorldPanManager`, `ParticleManager`.
12. `subscribeOwnedCards(playerId)` — brings in the player's soul rows for the chooser.

`onExit` disposes in roughly reverse order, with a `enterBrowseMode()` call up front to tear down play-mode pieces cleanly while their backing infra is still alive.

## Conventions
- **Drag stays wired in browse mode.** `DragManager` is always-on, so the player can grab and drop cards in the inventory panel before clicking Play. Whether the server accepts a drag against a soul you're not playing as is a permissions concern for later (we'll generalize the current `ownerId == playerId` pickup check into view/drag-tier semantics — see `game/permissions.ts`).
- **Panels are destroyed and rebuilt per soul id**, not swapped in place. The user's localStorage state for the inventory panel (`gameInventoryPanel.*`) survives rebuilds since the storage key stays the same; the DOM elements themselves are recreated. Cheap; happens at user-click rate.
- **`MainLayout.inventoryView`** is the typed handle to the `LayoutInventory` when one exists. `null` whenever the inventory panel doesn't exist or its content is a `PackContentsPanel`. `MainScene` uses optional chaining (`this.mainLayout.inventoryView?.showGrid(...)`) for KeyE.
- **Anchor management on browse→play→browse round-trip.** Entering play sets the `"viewport"` anchor (via `recenterOnSoul → tweenTo`) and lets `main.ts`'s `souls.on` listener set the `"soul"` anchor when the Soul row arrives. Entering browse explicitly `clearAnchor("viewport")` + `clearAnchor("soul")` so world subscriptions drop. Without the explicit `clearAnchor("soul")` calls, the soul anchor would persist (the `souls.on` listener bails on `null`).

## Pitfalls
- **Don't call `MainLayout.enterPlayMode` without first calling `souls.setActiveSoul`.** The layout only flips chrome; it doesn't subscribe to the soul row. `MainScene.enterPlayMode` does both, in the right order.
- **The inventory zone subscription serves both `LayoutInventory` (visual) and `GameInventory` (physics).** They both read the same `CardManager` rows. The layout owns both the subscription and the `GameInventory`; they're constructed in lockstep inside `rebuildInventoryPanelAsSoulInventory` and disposed in lockstep inside `rebuildInventoryPanel(null)`.
- **`MainLayout.layout()` reads the inventory panel's `getBoundingClientRect()`** for the world's right edge. In play mode the panel always exists; the null check is defensive. In browse mode the world is zero-sized regardless.
- **Drag-while-in-browse interacts with `canPickUpCard`.** Today `canPickUpCard` walks the ownership chain to `playerId`, so a player who tries to drag a soul *they own* in browse mode will pass the check; dragging a card belonging to *some other player's soul* (not currently possible in-UI but conceptually) would fail. When view-tier semantics land, this becomes the central permissions gate.
