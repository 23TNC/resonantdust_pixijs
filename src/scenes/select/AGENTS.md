# AGENTS.md

## Purpose
Character select scene — the landing after login and before the game. The player views their soul cards on the right panel and the selected soul's inventory on the left. A "Create character" flow swaps both panels to a starter-pack chooser and pack-contents preview. Transitions to `GameScene` when the player clicks Play. Read-only over server data: no `CardManager`, no `LayoutManager`, no drag/drop.

## Important files
- `CharacterSelectScene.ts`: `Scene` subclass. `onEnter` subscribes `subscribeOwnedCards(playerId)` and builds `CharacterSelectLayout`. `onExit` unsubscribes both the player-level and (if set) the per-soul subscription. Three callbacks from the layout: `handlePlay(cardId)` — calls `ctx.souls.setActiveSoul(cardId)` then transitions to `GameScene`; `handleCreateCharacter(pack)` — calls `ctx.reducers.createCharacter({ starterPackId })` and flips the layout back to select mode on success; `handleSelectedSoulChange(soulId)` — swaps per-soul `subscribeOwnedCards` so the left panel receives that soul's cards in `cardsLocal`.
- `CharacterSelectLayout.ts`: root `LayoutNode` with `TitleBar` + two side-by-side panels. Two modes: `"select"` (right: `OwnedCardsPanel` — the player's souls + Play/Create buttons; left: `SoulInventoryPanel` — the selected soul's cards) and `"create"` (right: `PackChooserPanel`; left: `PackContentsPanel`). Mode swaps destroy and rebuild both panels; selection state resets. `returnToSelectMode()` is called by the scene after a successful `createCharacter`.
- `OwnedCardsPanel.ts`: reads `cardsLocal` filtered to `owner_id == playerId` (the player's soul cards under the post-flag-20 model). Renders each as a `RectCardVisual` / `HexCardVisual` on the inventory grid. Selection highlights with a yellow outline; `onSelectionChange` enables/disables the Play button. The Create-character button is disabled when the player reaches `MAX_SOULS_PER_PLAYER` (5). Subscribes to `data.subscribeLocalCard` for live updates.
- `PackChooserPanel.ts`: reads starter packs from `ctx.definitions` grouped by soul type. Selection fires `onPackSelected`; `PackContentsPanel` updates to show the pack's soul + item list.
- `PackContentsPanel.ts`: preview of a selected starter pack's soul card visual and item list. Read-only from definitions — no server data read.
- `SoulInventoryPanel.ts`: left-panel inventory display for the selected soul. Reads `cardsLocal` filtered to `owner_id == soulCardId` and arranges cards on the same `GRID_W × GRID_H` grid the in-game inventory uses. Shows a placeholder when no soul is selected.

## Scene flow
```
LoginScene → CharacterSelectScene → GameScene
```
`CharacterSelectScene` is entered immediately after a successful `claimOrLogin` call. The player selects a soul (or creates one) before entering the game.

## Key design decisions
- **Read-only over server data.** No `CardManager`, no `LayoutManager`, no drag/drop. Cards are rendered as standalone `RectCardVisual` / `HexCardVisual` instances; positional fields (`macroZone`, `microZone`, `microLocation`, `surface`) are ignored — grid layout is for display only.
- **Per-soul subscription is managed by the scene.** `subscribeOwnedCards(playerId)` brings in soul cards. `subscribeOwnedCards(soulId)` (swapped on each selection change via `handleSelectedSoulChange`) brings in that soul's inventory rows. Both are cleaned up in `onExit`. The SDK deduplicates overlapping SQL subscriptions automatically.
- **`SoulManager.setActiveSoul` is the only write-path action.** The Play button calls it to register the chosen soul; subsequent in-game reducers read `ctx.souls.getSoul()` for the active soul. There is no server-side "current soul" pointer.
- **Mode swaps are destructive.** Switching between `"select"` and `"create"` destroys and rebuilds both panels. This avoids stale selection/hover state leaking across modes; the two modes have non-overlapping data.

## Pitfalls
- **Subscription scope is the scene's responsibility.** `SoulInventoryPanel` reads `cardsLocal` but does not install or remove SpacetimeDB subscriptions itself. `CharacterSelectScene.handleSelectedSoulChange` owns the subscribe/unsubscribe lifecycle. If you add a new left-panel consumer that needs per-soul rows, extend the scene's subscription management — not the panel.
- **`subscribeOwnedCards(playerId)` and `subscribeOwnedCards(soulId)` can overlap.** Soul cards have `owner_id = playerId` (that's what surfaces them in `OwnedCardsPanel`), so the player-level subscription already covers them. `subscribeOwnedCards(soulId)` is additive — it brings in *that soul's own* cards. The SDK deduplicates at the wire level.
- **No `ctx.cards` (CardManager) is set during this scene.** Code that null-checks `ctx.cards` is safe; code that asserts its presence will throw. `CharacterSelectScene` intentionally skips `CardManager` setup.
- **`handleCreateCharacter` is the stub seam.** The `createCharacter` reducer is wired; `handleCreateCharacter` fires it and calls `returnToSelectMode()` on success. Error handling is console-only for now — surfacing it inline in the panel is a follow-up.
