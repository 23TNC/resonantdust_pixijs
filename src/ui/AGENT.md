# AGENT.md — ui/

## Purpose
`src/ui/` contains the layout engine and all game-facing visual components.

## Directory split
- `layout/`: foundational layout engine (`LayoutObject`, `LayoutRoot`, `LayoutLayers`, `LayoutLinear`, `LayoutViewport`, `LayoutHex`, `LayoutLabel`).
- `components/`: concrete game UI pieces (`GameView`, `World`, `Zone`, `Tile`, `Card`, `CardStack`, `Inventory`, `DragManager`, `Panel`, `ViewTitle`, `FrameRate`).
- `input/`: `InputManager` — pointer event subscription bus.

## Conventions
- New renderable UI elements should extend `LayoutObject` (or a subclass), not raw `Container`.
- Keep update flow dirty-driven: mutate data, call `invalidateLayout()`, let the tree propagate.
- Favor composition; do not add scene-specific behavior into base layout classes.
- Use `addLayoutChild` / `removeLayoutChild`; never add children directly to the Pixi container.

## Should own / should not own
- Owns: layout math, hit-testing, rendering primitives, card/zone display logic.
- Does not own: scene transitions, network/session concerns, global app bootstrapping.

## PixiJS 8.9.1 notes
- Use current Graphics chaining APIs (`poly(...).fill(...)`, `.stroke(...)`, etc.).
- Keep `render()` target usage consistent with existing `Zone` cache render path.
