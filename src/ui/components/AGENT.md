# AGENT.md — ui/components

## Purpose
Concrete gameplay UI components built on the layout primitives in `ui/layout/`.

## Important classes

### Top-level
- `GameView`: top-level gameplay view; extends `LayoutRoot`. Owns `LayoutLayers` ("game" / "overlay"), `InputManager`, `DragManager`, `Inventory`, `World`, and supporting panels. Call `tick()` each frame; call `sync()` after subscription updates.

### World
- `World`: viewport-backed container; owns `Zone` instances. Syncs with `client_zones`; centres camera on the viewed soul's hex position.
- `Zone`: hex-layout container; owns and caches `Tile` instances (RenderTexture cache). Dirty when tile data changes.
- `Tile`: single flat-top hex cell (LayoutObject subclass).

### Cards
- `Card`: single card visual; renders title, body, flags. Owned by `CardStack`.
- `CardStack`: displays a chain of linked cards as a visual stack. Resolves the chain from `client_cards` via `link_id` / `linked_flag`. Stops at `dragging` / `returning` cards unless `ignoreDragState` is set.
- `Inventory`: manages `CardStack` instances for cards owned by a soul on a given z-layer. Runs a push-separation simulation to prevent overlap. Filters out `dragging`, `returning`, `world_flag`, and hidden-sentinel cards.
- `DragManager`: overlay (in the "overlay" layer) that renders `CardStack`s for cards currently being dragged or returning to origin. `hitTestLayout` returns `null` (click-through). Lerps stacks toward a throttled cursor target; plays return animation on invalid drop. Entry removal happens in `updateLayoutChildren` — dead entries (neither dragging nor returning) are cleaned up automatically each layout pass.

### Input
- `InputManager` (`ui/input/InputManager.ts`): subscription event bus for pointer input. Events: `left_down`, `left_drag_start`, `left_drag_move`, `left_drag_end`, `left_click`, `left_click_long`. Subscribe with `.on()` / unsubscribe with `.off()`.

### UI chrome
- `Panel`: background rect with configurable padding and corner radius.
- `ViewTitle`: displays the currently viewed soul's name.
- `FrameRate`: live frame-rate counter.

## Drag flow
1. `left_down` → `DragManager` captures hit target.
2. `left_drag_start` → if target is a `Card` inside a `CardStack`, and flags allow it, set `card.dragging = true`, add entry to DragManager, `invalidateLayout()`.
3. `left_drag_move` → update throttled cursor target; DragManager lerps stack toward it each `redraw()`.
4. `left_drag_end` → flush final cursor position; set `dragging = false`, `returning = true`, `returnTarget = returnOrigin`; `invalidateLayout()`.
5. Lerp converges → `_finishReturn`: set `returning = false`, `invalidateLayout()`.
6. Next layout pass → `updateLayoutChildren` removes dead entry; Inventory re-shows the card in the same pass.

No manual sync callbacks between `DragManager` and `Inventory` — dirty flag propagation handles it.

## Dirty / layout guidance
- Mutate `ClientCard` flags then call `invalidateLayout()`. Do not call `sync()` on siblings.
- `CardStack.invalidateLayout()` after any data change that could alter the chain.
- `Inventory.sync()` when subscription updates may have added/removed/changed cards.

## Pitfalls
- `CardStack` with `ignoreDragState: false` (default) stops chain resolution at dragging/returning cards — that is intentional so Inventory doesn't show partial chains mid-drag.
- `DragManager`'s `CardStack` instances use `ignoreDragState: true` so they render the dragging card.
- Directly editing `Zone.cacheSprite`/`cacheTexture` can cause recursive render artifacts.
- Mixing world and viewport coordinates in `World` methods causes culling/hit-test bugs.
