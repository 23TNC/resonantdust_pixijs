# AGENT.md — ui/components

## Purpose
Concrete gameplay UI components built on the layout primitives in `ui/layout/`.

## Important classes

### Top-level
- `GameView`: top-level gameplay view; extends `LayoutRoot`. Owns `LayoutLayers` ("world" / "game" / "overlay"), `InputManager`, `DragController`, `Inventory`, `World`, and supporting panels. Children update reactively from `client_cards` / `client_zones`; call `tick()` each frame and `centerCameraOnViewedSoul()` after the first tick.

### World
- `World`: viewport-backed container; owns `Zone` instances. Subscribes to visible zones via `spacetime.subscribeZone(layer, macro_zone)` as the camera moves. Renders one `CardStack` per qualifying world-side root card.
- `Zone`: 8×8 hex layout container; owns `Tile` instances driven by the zone's packed tile data + materialized override cards at the same position.
- `Tile`: single pointy-top hex cell.

### Cards
- `Card`: single card visual; renders title, body, progress bars, flags. Owned by `CardStack`. Progress bars resolved from `client_actions` and recipe style.
- `CardStack`: displays a chain of stacked cards (rect-on-rect). Resolves the chain by walking `stacked_up_children` / `stacked_down_children` from the root card. Stops at `dragging` / `animating` cards unless `ignoreDragState` is set.
- `Inventory`: manages `CardStack` instances for cards in the viewed soul's panel layer. Runs a push-separation simulation to prevent overlap. Filters via `getRoots({ panelOnly: true, layer })`.
- `DragOverlay`: overlay-layer container that renders `CardStack`s for cards currently being dragged or animating back. `hitTestLayout` returns `null` (click-through). Lerps stacks toward cursor; plays return animation on invalid drop.

### Input
- `InputManager` (`ui/input/InputManager.ts`): subscription event bus for pointer input. Events: `left_down`, `left_drag_start`, `left_drag_move`, `left_drag_end`, `left_click`, `left_click_long`. Subscribe with `.on()` / `.off()`.

### UI chrome
- `Panel`: background rect with configurable padding and corner radius.
- `ViewTitle`: displays the currently viewed soul's name.
- `FrameRate`: live frame-rate counter.

## Drag flow

`DragController` (in `coordinators/`) drives:

1. `left_down` → cache hit target.
2. `left_drag_start` → if target is a `Card` inside a `CardStack`, validate (`isDraggableCardType`, no `position_locked` / `position_hold`), set `dragging`, ask `DragOverlay` to spawn an entry.
3. `left_drag_move` → update cursor position; `DragOverlay` lerps stack toward it each `redraw()`.
4. `left_drag_end` → route to `_performDrop`:
   - **on Tile**: `Stack.detach(...)` (local), then `spacetime.updatePosition(...)` to sync the move + fire matcher server-side. Set `animating = true`, tween to tile centre.
   - **on Card**: `Stack.attachUp/Down(...)` + `flipDescendants(...)` (local), then `spacetime.updatePositions(participants)` (batched). Server cancels disturbed actions and re-runs the matcher; new top_stack/bottom_stack actions arrive via the actions table.
   - **on Inventory**: `Stack.detach(newRoot, ...)` + re-attaches (natural-top-chain flip), then `spacetime.updatePositions(participants)`.
   - **invalid**: set `animating = true`, tween back to `returnOrigin`.
5. Tween converges → `_finishAnim` clears `animating`, invalidates source + destination.

## Sync protocol — important

Action lifecycle is **server-driven** (Phase 5).  The client does not call
`startActionNow` / `cancelAction` directly; instead it sends position
updates via `spacetime.updatePosition` / `updatePositions`, and the server's
`update_position` reducer:
1. Cancels actions whose claim windows the move disturbs.
2. Re-runs the matcher in each affected zone, starting newly-eligible
   recipes.
Action inserts / updates / deletes propagate to the UI via the actions
table subscription + per-card listeners.

`coordinators/ActionCoordinator.ts` is now a no-op stub kept for API
compatibility; its observe / unobserve calls in `World.ts` and `Inventory.ts`
do nothing under the new protocol.

## Progress bars (Card)
- Two bars maximum: `primary` (first active action) and `secondary` (second active action).
- Colors come from `getRecipeByIndex(action.recipe)?.style` — `"default"` means use the card's own `titleColor`.
- Fallback when no action but `this._progress !== null`: plain bar using `titleColor` / `bodyColor`.
- `getActionProgress(action, now_seconds)` from `Data.ts` drives the fill fraction.

## Dirty / layout guidance
- Mutate `ClientCard` flags / position then call `invalidateLayout()`.  Don't call `sync()` on siblings.
- `CardStack.invalidateLayout()` after any data change that could alter the chain.

## Pitfalls
- `card.animating` (not `returning`) is the flag used during tween-back and drop animations; check and set this flag, not a `returning` field.
- `CardStack` with `ignoreDragState: false` (default) stops chain resolution at `dragging`/`animating` cards — intentional so Inventory doesn't show partial chains mid-drag.
- `DragOverlay`'s own `CardStack` instances use `ignoreDragState: true` so they render the dragging card.
- Mirror staleness: when a stack-merge moves a source root, the source's same-side descendants in the local cache keep their old `(layer, macro_zone, micro_zone)` until the next server roundtrip.  `_syncStackPositions` pushes everyone's current value, so the server picks up correct mirrored positions even though the local cache may be momentarily inconsistent.
- Mixing world and viewport coordinates in `World` methods causes culling / hit-test bugs.
- `bootstrapRecipeDefinitions()` must be called before `getRecipeByIndex` is used by `Card` — omitting it makes all recipe style colors fall back to `titleColor`, hiding progress bars.
