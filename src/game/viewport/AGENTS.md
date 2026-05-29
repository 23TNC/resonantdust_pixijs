# AGENTS.md

## Purpose
The generic **grid-viewport** system. One `LayoutWorld` renders any
`(surface, owner)` zone's tiles + cards onto a pluggable `CellGrid` — the world,
a mini-zone, and an inventory are all the same viewport, differing only by
`(owner, surface)` and grid shape. Grid shape (hex vs rect) is a pure render
toggle: a hex viewport draws hex tiles, a rect viewport draws rect tiles, both
derived from the zone's tile data.

## Folder layout
- **root (common, grid-agnostic)**: `ViewportPanel` (THE panel — world and
  inventory are two configs of it: `{ grid, surface, owner, viewer, pan,
  occupancy, follow, … }`), `LayoutWorld` (the viewport node), `CellGrid` (the
  grid-strategy interface), `WorldViewServices` (per-view services cards resolve
  via `findWorldView`), `PanController` (grid-agnostic drag-pan + recenter
  tween — pans hex or rect via `LayoutWorld.pixelDeltaToCell`), `worldCoords`
  (zone/tile coords), `ZoneTileCache` (the `(owner,surface)`-scoped tile data
  model — `tileViewAt(q,r)` from Zone rows + promoted tile-cards; owns the
  zone/card subscriptions and fires `onChange`; `LayoutWorld` queries it).
- **`hex/`** (hex-specific): `HexGrid`, `hexSize`, `pathfind` (hex A*),
  `HexObjectDecorator` (per-tile decorative object sprites — trees/rocks/centre
  objects ringed around each hex + the card occlusion overlay; `LayoutWorld`
  constructs one only for hex viewports, so a rect inventory draws no objects).
- **`rect/`** (rect-specific): `RectGrid`, `GridInventory` (one-card-per-cell
  occupancy, wired by `ViewportPanel`'s `occupancy` flag).

A viewport subscribes its zone via an **owner-aware anchor**
(`ZoneManager.setAnchor(name, q, r, surface, owner)` →
`recomputeAnchorZones` packs `makeMacroZone(owner, …)`), so world (owner 0) and
inventory (owner = soul) use the identical path. `ensureInventory` is now only
the panel-less background subscription (`SoulManager`).

## Important files
- `LayoutWorld.ts`: the viewport *shell* — a `LayoutNode` that renders a `(owner, surface)` zone's tiles + cards onto a `CellGrid` and registers a shared `WorldCardSurface` with `LayoutManager` for every active zone it owns. Owns the **retained tile renderer** (sprite pool + active-rect diff + `buildTile`/`dropTile`), the pan transform (`panLayer` + `worldCardSurface` repositioned to `worldToLocal(0,0)` each pass), and the `WorldViewServices` facade. Queries `this.cache` (`ZoneTileCache`) for tile data and delegates objects to `this.decorator` (`HexObjectDecorator`, hex-only). Viewport origin comes from `ctx.zones.onAnchorChange(viewportAnchorName)`. Exposes `worldToLocal` / `localToWorld` (grid-delegated) and `cellToPixel` / `pixelDeltaToCell`.
- `ZoneTileCache.ts`: the `(owner, surface)`-scoped tile **data model**. `tileViewAt(q, r)` returns the tile (card-sourced wins over zone-sourced) or `null`. Maintains a flat `tileData` cache (from `Zone` rows) + a `(q,r)`→tile-card index (from `card_type == 7` rows in `cardsLocal`, hex resolved via `resolveTileCardHex`'s chain-walk). Owns the `data.zones` + `data.cards` subscriptions and fires `onChange` on any tile mutation; `LayoutWorld` wires that to re-render the affected active tiles + re-notify cards.
- `WorldPanManager.ts`: subscribes to `InputManager.left_drag_start` / `left_drag_stop`. Pan activates when a drag starts on empty world space (`data.hit === LayoutWorld`). Each `update()` call reads the current pointer delta, converts it to a hex `(dq, dr)`, and pushes `ctx.zones.setAnchor("viewport", …)`. Also exposes `tweenTo(q, r)` for smooth programmatic recentering (exponential-lerp factor 0.18, snap at 0.01 hex units). Called from `MainScene.update` every frame.
- `pathfind.ts`: client-side A* over the hex grid. `findPath(start, end, blockers, costFn)` returns a `Vec<TilePoint>` the client submits to `move_soul` for server validation. Mirrors the algorithm the server used to run pre-rewrite; the server now only validates per-step adjacency, traversability, and the `MAX_VALIDATION_STEPS = 256` cap. Reads `cost` / `speed` traits via wasm `traitValue(packed, name)`; mini_zone overlays via `LayoutWorld.tileViewAt`.
- `hexSize.ts`: display constants — `WORLD_HEX_RADIUS` (96 px), `WORLD_HEX_WIDTH`, `WORLD_HEX_HEIGHT`. Independent of the texture-bake radius and the inventory display radius.
- `worldCoords.ts`: zone/tile coordinate utilities — `packMacroZone` / `unpackMacroZone`, `decodeZoneTiles` (decode all non-empty tile slots in a `Zone` row into world-absolute hex positions + packed defs), `getZoneTileDef` (single-tile lookup by `macroZone + localQ/R`), `zonesAroundAnchor` (enumerate zone origins within a hex ring radius). Also re-exports `WORLD_LAYER` from `server/data/packing`.

## Tile cache model
The whole model lives in `ZoneTileCache` (not `LayoutWorld`). Each `Zone` row encodes an **8×8 block of 64 per-tile u16 slots** in fields `t0..t15` (16 u64s, 4 slots per u64). The slot layout is `[def_id:u12 | stock0:u2 | stock1:u2]` — see [content/AGENTS.md](../../../content/AGENTS.md) and the shard server's [zones.rs](../../../../../spacetime/server/modules/shard/src/zones.rs). On any zone insert/update/remove, `ZoneTileCache` evicts the affected 8×8 block from `tileData` and re-decodes the new row. Missing entries (subscription gap, empty slot with `def_id = 0`) fall back to `EMPTY_TILE_PACKED` on render.

A **promoted tile-card** — a real `Card` row at the same `(surface, macro_zone, micro_zone)` — overrides the packed Zone slot. `ZoneTileCache`'s cards-subscription listens for `card_type == 7` (`tile`) rows in its `(owner, surface)` bucket and fires `onChange` on the affected hex. Stocks come from `flags_bk.tile_stock_{0,1}` (read via `cardFlagFieldValueIn`); at-rest tiles get demoted back into the Zone slot by the server's `gc_sweep`.

## Tile-cards stitched into chains
When a recipe binds a tile-card as its `slot.0.0`, the server's `chain_stitch` rewrites the tile-card's `micro_zone` from the Free `[q:3|r:3|state:2]` layout to the OnRoot `[position:4|direction:2|state:2]` layout — the `(q, r)` bits become `(position, direction)` and no longer identify a hex. **Every site that decodes a tile-card's hex must parent-walk to its Free ancestor** via `micro_location`:

- `ZoneTileCache.resolveTileCardHex` — drives the render + click-to-details paths.
- `ActionManager.resolveTileCardHex` — drives the matcher's `syntheticTile` resolution.
- (Server) `gc::resolve_tile_hex` — drives demotion's zone-slot address.

Each walks at most 32 hops and returns `null` for orphans (Free ancestor reaped before the tile-card demoted). Orphan handling: client falls back to zone data; server's demotion skips the card.

## Pan math (pointy-top axial)
Pixel delta → hex delta:
```
dr = (2/3 * dy) / WORLD_HEX_RADIUS
dq = dx / (WORLD_HEX_RADIUS * sqrt(3)) - dr / 2
```
`WorldPanManager` subtracts the hex delta from the start anchor (grab-and-drag feel — the world moves with the cursor, so the viewport anchor shifts opposite the drag direction). `LayoutWorld.worldToLocal` and `localToWorld` implement the inverse pair; `localToWorld` uses cube-coordinate rounding to pick the correct nearest hex on triangle boundaries.

## Conventions
- **`LayoutWorld` has no clip mask.** `MainLayout` draws the world first; adjacent views (title bar, toolbar, chat panel, inventory) draw afterward and cover any out-of-bounds bleed. Cheaper than a mask.
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
