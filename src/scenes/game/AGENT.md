# AGENT.md

## Purpose
Layout nodes that compose `GameScene`'s UI: title bar across the top, world view on the left, inventory on the right.

## Important files
- `GameLayout.ts`: root node for the scene. Slices the screen into title bar + (world | inventory).
- `TitleBar.ts`: thin top bar — player name (left), FPS readout (right). Reserve space here for menu/settings buttons.
- `WorldView.ts`: left-side game view. Placeholder; world rendering goes here.
- `InventoryView.ts`: right-side card column. Placeholder; sized via `InventoryView.widthFor(screenWidth)`.

## Conventions
- Every UI element here is a `LayoutNode` — see `../../layout/AGENT.md` for the dirty/hit-test contract.
- `GameLayout.layout()` is the single place that decides how the screen is sliced. Adjust row heights, column widths, or insert new regions here — child views just receive their rect via `setBounds`.
- Components anchor their text (`anchor.set(...)`) so content size changes (e.g. FPS digits) don't trigger relayout. Only structural changes (region size, child added/removed) should invalidate.
- Public fields on composite nodes (e.g. `gameLayout.titleBar`) are intentional — `GameScene` reaches in for per-frame work like `titleBar.updateFps`. Keep these references narrow and named.

## Pitfalls
- FPS smoothing is an EMA in `TitleBar`; don't switch to a rolling window without reason — EMA holds steady when frames stutter, which is what we want for a readout, not a benchmark.
- `InventoryView.widthFor` clamps between `MIN_WIDTH` and `MAX_WIDTH`. Cards inside must fit the *current* width (`this.width`), not the constants — read from the bound rect.
- `WorldView` and `InventoryView` paint a solid background rect each layout pass. If we move to textures, swap the `Graphics.rect().fill()` rather than layering a separate sprite to avoid double-paints.
