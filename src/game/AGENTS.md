# AGENTS.md

## Purpose
Layout nodes that compose `GameScene`'s UI: title bar across the top,
world view on the left, inventory on the right, plus a hit-passthrough
overlay for in-flight UI (drag previews, tooltips).

## Important files
- `GameLayout.ts`: root node for the scene. Slices the screen into title bar + (world | inventory) + overlay. Constructs the world view, inventory view, title bar, and overlay; exposes them as public fields so `GameScene` can reach the title bar for FPS updates and the world view for the pan manager.
- `WorldView.ts`: thin re-export of `world/LayoutWorld` so the file path under `scenes/game/` stays parallel with the other views. The actual hex-grid renderer lives in [`../../world/AGENTS.md`](../../world/AGENTS.md).
- `InventoryView.ts`: right-side card column. `LayoutInventory` registers itself as the surface for the inventory `ZoneId` so cards parented through `LayoutManager.surfaceFor(zoneId)` land here. Sized via `LayoutInventory.widthFor(screenWidth)`. Includes a fadeable grid overlay (`showGrid(boolean)`) used by the snap-to-grid feature.
- `TitleBar.ts`: thin top bar — player name (left), FPS + draw-call readout (right). Reserve space here for menu/settings buttons.

## Conventions
- Every UI element here is a `LayoutNode` — see `../../layout/AGENTS.md` for the dirty/hit-test contract.
- `GameLayout.layout()` is the single place that decides how the screen is sliced. Adjust row heights, column widths, or insert new regions here — child views just receive their rect via `setBounds`.
- **The overlay is always last.** `OverlayNode` is the final child of `GameLayout`, draws above every other region, and overrides `intersects()` to return `false` so hit tests fall through. `LayoutManager.overlay` points at it; cards re-parent here while dragging so their drop-time hit test resolves to the surface beneath, not the card itself.
- Components anchor their text (`anchor.set(...)`) so content size changes (e.g. FPS digits) don't trigger relayout. Only structural changes (region size, child added/removed) should invalidate.
- Public fields on composite nodes (e.g. `gameLayout.titleBar`, `gameLayout.worldView`) are intentional — `GameScene` reaches in for per-frame work like `titleBar.updateStats` and the world view goes to `WorldPanManager`. Keep these references narrow and named.

## Pitfalls
- FPS / draw-call smoothing in `TitleBar` is an EMA; don't switch to a rolling window without reason — EMA holds steady when frames stutter, which is what we want for a readout, not a benchmark.
- `LayoutInventory.widthFor` clamps between `MIN_WIDTH` and `MAX_WIDTH`. Cards inside must fit the *current* width (`this.width`), not the constants — read from the bound rect.
- The inventory and world surfaces register themselves with `LayoutManager` on construction and unregister in `destroy()`. Don't add a sibling that takes a `ZoneId` without doing the same — `LayoutManager.surfaceFor(zoneId)` returning `undefined` makes cards detach silently.
- `WorldView.ts` is a one-line re-export. If you find yourself adding logic there, put it in `world/LayoutWorld.ts` instead — the re-export exists to keep imports under `scenes/game/` symmetric without duplicating implementations.
