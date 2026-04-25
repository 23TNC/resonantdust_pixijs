# AGENT.md

## Purpose
Layout core for this client. These classes define rect geometry, dirty propagation, tree updates, and hit-testing.

## Important files
- `LayoutRect.ts`: base layout node with `outerRect`, `innerRect`, padding, origin, dirty flags.
- `LayoutRoot.ts`: top-level tree root; binds to `AppContext` resize and drives recursive update/render.
- `LayoutViewport.ts`: world/viewport coordinate mapping, culling, optional scissor clipping.
- `LayoutHex.ts`: flat-top hex coordinate placement + hex hit-routing.
- `LayoutGroup.ts`: row/column/group utilities.

## Critical rules
- `invalidateLayout()` should imply `invalidateRender()` (already enforced in `LayoutRect`); preserve that behavior.
- `renderDirty` alone must not force layout changes.
- Prefer overriding `layoutChildren()` and `redraw()`; avoid mutating dirty flags directly outside lifecycle methods.
- Keep hit tests in layout-local/global terms (`toLocal`, `innerRect.contains`).

## Ownership boundaries
- Owns layout geometry and child placement policies.
- Should not contain game rules, SpaceTimeDB logic, or scene-switching code.

## Common pitfalls
- Forgetting to call `super.updateRects()` in subclasses that override `updateRects()` can desync pivot/inner rect math.
- Bypassing `addLayoutChild/removeLayoutChild` breaks parent layout propagation.
