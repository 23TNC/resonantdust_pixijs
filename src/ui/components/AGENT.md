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
- `Card`: single card visual; renders title, body, progress bars, flags. Owned by `CardStack`. Progress bars resolved from `client_actions` and recipe style (via `getRecipeByIndex`).
- `CardStack`: displays a chain of stacked cards. Resolves the chain by walking `stacked_up_children` or `stacked_down_children` from the root card. Stops at `dragging` / `animating` cards unless `ignoreDragState` is set.
- `Inventory`: manages `CardStack` instances for cards owned by a soul on a given layer. Runs a push-separation simulation to prevent overlap. Filters out `dragging`, `animating`, world-surface, and hidden cards.
- `DragManager`: overlay (in the "overlay" layer) that renders `CardStack`s for cards currently being dragged or animating back to origin. `hitTestLayout` returns `null` (click-through). Lerps stacks toward cursor; plays return animation on invalid drop. After a successful card-on-card drop, calls `findTopStackRecipes(destRoot)` to check for matching top_stack recipes.

### Input
- `InputManager` (`ui/input/InputManager.ts`): subscription event bus for pointer input. Events: `left_down`, `left_drag_start`, `left_drag_move`, `left_drag_end`, `left_click`, `left_click_long`. Subscribe with `.on()` / `.off()`.

### UI chrome
- `Panel`: background rect with configurable padding and corner radius.
- `ViewTitle`: displays the currently viewed soul's name.
- `FrameRate`: live frame-rate counter.

## Drag flow
1. `left_down` → `DragManager` captures hit target.
2. `left_drag_start` → if target is a `Card` inside a `CardStack`, and flags allow, set `card.dragging = true`, add entry to DragManager, `invalidateLayout()`.
3. `left_drag_move` → update cursor position; DragManager lerps stack toward it each `redraw()`.
4. `left_drag_end` → route to `_performDrop`:
   - **on Tile**: commit `moveClientCard`, set `card.animating = true`, tween to tile centre.
   - **on Card**: commit `stackClientCardUp/Down`, call `findTopStackRecipes(destRoot)`. If recipes matched: call `spacetime.setCardPositions` (full stack sync) then `spacetime.startActionNow` per recipe. Return `dropCard` to trigger destination invalidation.
   - **on Inventory**: commit `moveClientCard` (with natural-top-chain flip logic).
   - **invalid**: set `card.animating = true`, tween back to `returnOrigin`.
5. Tween converges → `_finishAnim`: clear `card.animating`, invalidate source + destination.
6. Next layout pass → `updateLayoutChildren` removes the dead entry.

## Progress bars (Card)
- Two bars maximum: `primary` (first active action) and `secondary` (second active action).
- Colors come from `getRecipeByIndex(action.recipe)?.style` — `"default"` means use the card's own `titleColor`.
- Fallback when no action but `this._progress !== null`: plain bar using `titleColor` / `bodyColor`.
- `getActionProgress(action, now_seconds)` from `Data.ts` drives the fill fraction.

## Dirty / layout guidance
- Mutate `ClientCard` flags then call `invalidateLayout()`. Do not call `sync()` on siblings.
- `CardStack.invalidateLayout()` after any data change that could alter the chain.
- `Inventory.sync()` when subscription updates may have added/removed/changed cards.

## Pitfalls
- `card.animating` (not `returning`) is the flag used during tween-back and drop animations; check and set this flag, not a `returning` field.
- `CardStack` with `ignoreDragState: false` (default) stops chain resolution at `dragging`/`animating` cards — intentional so Inventory doesn't show partial chains mid-drag.
- `DragManager`'s own `CardStack` instances use `ignoreDragState: true` so they render the dragging card.
- Directly editing `Zone.cacheSprite`/`cacheTexture` can cause recursive render artifacts.
- Mixing world and viewport coordinates in `World` methods causes culling/hit-test bugs.
- `bootstrapRecipeDefinitions()` must be called before `getRecipeByIndex` is used by `Card` — omitting it makes all recipe style colors fall back to `titleColor`, hiding progress bars.
