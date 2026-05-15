# AGENTS.md

## Purpose
Hex tile grid view of the world and the viewport pan controller. `LayoutWorld` draws tiles and hosts world-layer cards; `WorldPanManager` translates drag gestures into viewport anchor shifts that propagate to both `LayoutWorld` (tile re-render) and `ZoneManager` (zone subscription boundary changes).

## Important files
- `LayoutWorld.ts`: `LayoutNode` that draws a pointy-top hex tile grid and registers a shared `WorldCardSurface` with `LayoutManager` for every active world-layer zone. Maintains a flat `tileData: Map<"${q},${r}", packed>` cache hydrated from `data.zones.current` at construction and updated live via `data.zones.subscribe`. Viewport origin comes from `ctx.zones.onAnchorChange("viewport")`. Sprite pool (acquire/release) keeps cost proportional to visible hexes. Exposes `worldToLocal(q, r)` / `localToWorld(localX, localY)` for hex↔pixel conversion.
- `WorldPanManager.ts`: subscribes to `InputManager.left_drag_start` / `left_drag_stop`. Pan activates when a drag starts on empty world space (`data.hit === LayoutWorld`). Each `update()` call reads the current pointer delta, converts it to a hex `(dq, dr)`, and pushes `ctx.zones.setAnchor("viewport", …)`. Also exposes `tweenTo(q, r)` for smooth programmatic recentering (exponential-lerp factor 0.18, snap at 0.01 hex units). Called from `GameScene.update` every frame.
- `hexSize.ts`: display constants — `WORLD_HEX_RADIUS` (96 px), `WORLD_HEX_WIDTH`, `WORLD_HEX_HEIGHT`. Independent of the texture-bake radius and the inventory display radius.
- `worldCoords.ts`: zone/tile coordinate utilities — `packMacroZone` / `unpackMacroZone`, `decodeZoneTiles` (decode all non-empty tile slots in a `Zone` row into world-absolute hex positions + packed defs), `getZoneTileDef` (single-tile lookup by `macroZone + localQ/R`), `zonesAroundAnchor` (enumerate zone origins within a hex ring radius). Also re-exports `WORLD_LAYER` from `server/data/packing`.

## Tile cache model
Each `Zone` row encodes an 8×8 block of tile definition bytes: `t0..t7` are u64s (row-major — `t[r][q]`), and `packedDefinition` carries the shared `typeId` + `categoryId` for the zone. On any zone insert/update/remove, `LayoutWorld` evicts the affected 8×8 block from `tileData` and re-decodes the new row. Missing entries (subscription gap, empty slot with `definitionId = 0`) fall back to `EMPTY_TILE_PACKED` on render.

## Pan math (pointy-top axial)
Pixel delta → hex delta:
```
dr = (2/3 * dy) / WORLD_HEX_RADIUS
dq = dx / (WORLD_HEX_RADIUS * sqrt(3)) - dr / 2
```
`WorldPanManager` subtracts the hex delta from the start anchor (grab-and-drag feel — the world moves with the cursor, so the viewport anchor shifts opposite the drag direction). `LayoutWorld.worldToLocal` and `localToWorld` implement the inverse pair; `localToWorld` uses cube-coordinate rounding to pick the correct nearest hex on triangle boundaries.

## Conventions
- **`LayoutWorld` has no clip mask.** `GameLayout` draws the world first; adjacent views (title bar, toolbar, chat panel, inventory) draw afterward and cover any out-of-bounds bleed. Cheaper than a mask.
- **`WorldCardSurface` is the shared surface for all world-layer zones.** `LayoutManager.register(zoneId, worldCardSurface)` is called for every world-layer zone at construction (from `zonesIn("active")` / `zonesIn("hot")`) and on every subsequent `onAdded("active")` event. The surface's origin is set to `worldToLocal(0, 0)` each layout pass so cards using raw world-pixel offsets render at the correct on-screen position.
- **Sprite pool: release-then-acquire each render.** `releaseActiveSprites()` runs first in every `layout()` pass, then `acquireSprite()` pulls from the pool (or allocates). Don't add sprites to `tileLayer` directly.
- **Deferred invalidate one frame after construction.** A `ctx.app.ticker.addOnce(() => this.invalidate())` fires after the first frame to cover zone-data races (`promote()` not yet run) and scene-bounds races (`SceneManager.resize` not yet applied). Do not remove it.
- **Pan and card drag are mutually exclusive.** `WorldPanManager` only activates when `data.hit === worldView` (the `LayoutWorld` node itself). A drag starting on a card returns the card's `LayoutNode`, so `DragManager` and `WorldPanManager` never both activate for the same gesture.
- **`tweenTo` is cancelled by any new drag.** The drag-start listener sets `this.tween = null` immediately so the player can grab the world to redirect a snap-back animation mid-flight.

## Pitfalls
- **`worldCardSurface` is wired into the layout tree manually.** It is pushed into `this.children` for hit-testing and layout-tree walks, but its PIXI container is added directly after `tileLayer` for z-order control — NOT via `this.addChild(worldCardSurface)`. Refactoring to `addChild` would break z-order.
- **`localToWorld` must use cube-coordinate rounding.** Axial-only rounding picks the wrong hex on triangle boundaries. The cube round-then-fix-largest-residual approach is required.
- **Zone-surface registration at construction covers active + hot tiers.** Only `onAdded("active")` is listened to for live changes. Hot zones registered at construction won't be unregistered if they later drop from hot to cold — a known gap if hot zones ever get visible UI.
- **`worldToLocal(0, 0)` is the card surface origin.** Cards store raw world-pixel offsets from the hex-coordinate origin `(0, 0)`. They pan for free because `worldCardSurface.setBounds(origin.x, origin.y, …)` updates on every layout pass.
