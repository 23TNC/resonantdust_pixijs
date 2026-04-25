# AGENT.md

## Purpose
`src/ui/` contains reusable layout primitives and game-facing visual components.

## Directory split
- `layout/`: foundational layout engine (`LayoutRect`, `LayoutRoot`, hex/viewport helpers).
- `components/`: concrete game UI pieces (`GameView`, `World`, `Zone`, `Tile`, cards).

## Conventions
- New renderable UI elements should usually extend `LayoutRect` (or a `LayoutRect` subclass), not raw `Container`.
- Keep update flow dirty-driven (`invalidateLayout` / `invalidateRender`) and let tree updates happen via `LayoutRoot.updateTree()`.
- Favor composition over adding scene-specific behavior into base layout classes.

## Should own / should not own
- Owns: layout math, hit-testing, rendering primitives, caching strategy for UI objects.
- Does not own: scene transitions, network/session concerns, global app bootstrapping.

## PixiJS 8.9.1 notes
- Use current Graphics chaining APIs already used in repo (`.poly(...).fill(...)`, `.stroke(...)`, etc.).
- Keep `render()` target usage consistent with existing `Zone` cache render path.
