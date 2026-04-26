# AGENT.md — ui/layout

## Purpose
Layout engine for the client. Defines rect geometry, dirty propagation, tree updates, and hit-testing.

## Important files
- `LayoutObject.ts`: base layout node with `outerRect`, `innerRect`, padding, dirty flags, child management.
- `LayoutRoot.ts`: top-level tree root; binds to `AppContext` resize and drives recursive `updateLayout` / `renderLayout`.
- `LayoutLayers.ts`: named depth slots (e.g. `["game", "overlay"]`); all children fill full `innerRect`; hit-tests children depth-descending so higher layers capture pointer first.
- `LayoutLinear.ts`: `LayoutHorizontal` / `LayoutVertical` — weighted row/column item containers.
- `LayoutViewport.ts`: world/viewport coordinate mapping, camera pan, optional scissor clipping.
- `LayoutHex.ts`: flat-top hex coordinate placement + hex hit-routing.
- `LayoutLabel.ts`: text label layout node.

## Dirty propagation pattern
Mutate shared data (e.g. a `ClientCard` flag) then call `invalidateLayout()`. The layout tree resolves everything on the next tick — no manual sync between siblings is needed or correct.

    // correct
    card.dragging = true;
    this.invalidateLayout();

    // wrong — bypasses tree propagation
    siblingComponent.sync();

## Critical rules
- `invalidateLayout()` implies `invalidateRender()`; preserve that behavior.
- `renderDirty` alone must not force layout changes.
- Override `updateLayoutChildren()` for placement logic; override `redraw()` for draw logic.
- Do not mutate dirty flags directly outside these lifecycle methods.
- Use `addLayoutChild` / `removeLayoutChild` — bypassing them breaks parent propagation.
- Hit tests operate in layout-local coordinates (`toLocal`, `innerRect`).

## Ownership boundaries
- Owns layout geometry and child placement policies.
- Does not contain game rules, SpacetimeDB logic, or scene-switching code.

## Common pitfalls
- `LayoutLinear` uses weight-based sizing; children must be added via `addItem(child, { weight })`.
- `LayoutLayers` children are sized to fill the full layer rect; do not set explicit sizes on them.
- `hitTestLayout` returns `null` by default on `LayoutObject`; overlay components that should be click-through override it to return `null` explicitly.
