# AGENT.md

## Purpose
Concrete gameplay-facing UI components built on layout primitives.

## Important classes
- `GameView`: top-level gameplay view; extends `LayoutRoot`.
- `World`: viewport-backed world container that owns `Zone` instances.
- `Zone`: hex-layout container that owns/caches tiles (RenderTexture cache sprite).
- `Tile`: flat-top hex visual cell (`LayoutRect` subclass).
- `Card`, `CardStack`: card visuals and grouping helpers.

## Architectural expectations
- `GameScene` should create/own `GameView`.
- `Zone` owns tile lifecycle and tile-key mapping.
- `World` owns zone lifecycle and should react when zone/tile dirtiness propagates.
- Prefer caching at **Zone** level for now (current strategy).

## Dirty/render/layout guidance
- Use `markTileDirty` / `markTileLayoutDirty` / `markZoneDirty` helpers instead of ad-hoc flag mutation.
- Layout changes should route through `setLayout`, `setChildWorldRect`, or other layout APIs.
- When changing tile/zone size behavior, update both positioning logic and cache-size invalidation paths.

## Pitfalls
- Directly editing `Zone.cacheSprite`/`cacheTexture` flow can cause recursive render artifacts.
- Mixing world and viewport coordinates incorrectly in `World` methods causes culling/hit-test bugs.
