# AGENT.md

## Purpose
World-board rendering and panning. `LayoutWorld` paints the hex tile
grid for the active world zones, hosts world-layer card visuals, and
exposes hex↔pixel coordinate conversion. `WorldPanManager` translates
drag-on-empty-world into anchor movement so the camera follows the
pointer. `worldCoords.ts` is the codec for the server's packed
`Zone.macroZone` and the helpers for selecting which zones surround a
world anchor.

## Important files
- `LayoutWorld.ts`: scene-scoped hex grid renderer + world-card
  surface. Subscribes to `data.zones` to keep its tile cache in sync,
  to `ctx.zones.onAnchorChange("viewport", …)` to recenter on pan,
  and to `ctx.zones.onAdded/onRemoved("active", …)` to register
  itself as the LayoutManager surface for every active world zone.
  Exposes `worldToLocal(q, r)` / `localToWorld(x, y)` (cube-rounded
  nearest-hex snap) for cards and pan code that need to translate
  between world hex coords and local pixel space. Tile draw uses an
  internal `Sprite` pool fed by `ctx.textures.getHexTexture(...)` so
  per-frame allocation stays bounded; clipped to the node's rect via
  a Pixi `mask`.
- `WorldPanManager.ts`: scene-scoped drag handler. On
  `left_drag_start` over `LayoutWorld` (and only over the world
  surface itself, not a card hit), captures the start pointer + the
  current `viewport` anchor; per-frame `update()` reads the live
  pointer from `ctx.input.lastPointer`, converts the delta to hex
  axial deltas, and writes a new viewport anchor via
  `ctx.zones.setAnchor("viewport", …)`. ZoneManager's anchor change
  triggers `recomputeWorldZones()`, which promotes/demotes world
  zones into the `active` tier as the camera moves — so panning
  automatically drives subscriptions.
- `worldCoords.ts`: `ZONE_SIZE` (8), `TILE_SIZE` (80), `WORLD_LAYER`
  (64); `packMacroZone(zoneQ, zoneR)` / `unpackMacroZone(macroZone)`
  matching the server's two's-complement layout
  (`((q & 0xFFFF) << 16) | (r & 0xFFFF)`); `decodeZoneTiles(zone,
  defs)` which walks a `Zone` row's eight `t` columns, extracts each
  cell's `definition_id` byte, and emits world-absolute `(q, r)`
  coords paired with the resolved `CardDefinition`;
  `zonesAroundAnchor(aq, ar, radius)` for the chunk neighborhood
  selector ZoneManager uses.

## Conventions
- **Server packs zone-coordinates as signed 16-bit integers.** Both
  `packMacroZone` and `unpackMacroZone` round-trip through two's
  complement so negative `(zoneQ, zoneR)` chunks (anything west /
  north of origin) work. Mirrors
  `spacetime/server/spacetimedb/src/packing.rs::pack_world_macro_zone`.
- **`WORLD_LAYER` is a sentinel, not a per-card layer index.** All
  world cards / zones today live on `layer == 64`; the value is
  reserved for the world board so inventory (`layer == 1`) can never
  collide with it. Future "dream layer" / "underworld" usage will pick
  values `>= WORLD_LAYER`.
- **Anchor-driven subscriptions.** `LayoutWorld` doesn't manage
  zone refs — `ZoneManager` does, via the anchor system.
  `setAnchor("viewport", q, r)` reshapes the active world-zone set;
  `LayoutWorld` reacts to the resulting tier transitions and
  registers the appropriate `LayoutManager` surface so cards can
  parent themselves. Pan code only ever moves anchors; it never
  touches `ensure(zoneId)`.
- **One surface for all world zones.** The `worldCardSurface` is a
  hit-passthrough child of `LayoutWorld` registered for *every*
  active world `zoneId` simultaneously. Cards on different chunks
  parent under the same surface but receive their pixel position via
  `LayoutHexCard.applyData` running `worldToLocal(q, r)`. This is
  why `worldCardSurface` overrides `hitTestLayout` to apply its
  parent-relative offset before recursing into children — the
  surface's `_x/_y` track `worldToLocal(0, 0)`, so subtracting them
  recovers raw world-space coords.
- **Empty tiles render as `EMPTY_TILE_PACKED`.** The texture atlas
  carries a single shared neutral hex texture used for any cell
  whose `(q, r)` doesn't appear in `tileData`. Coordinates outside
  any subscribed zone show this texture rather than skipping —
  better than blank visual gaps when you pan over un-subscribed
  area, and dirt-cheap because all empties share one texture.

## Pitfalls
- **Floating-point viewport vs integer tile lookups.** `viewQ`/`viewR`
  are floats so panning is sub-tile smooth, but `tileData` keys are
  integer `"q,r"` strings. `layout()` rounds the float view to
  `baseQ/baseR` for the lookup and uses the float values in
  `worldToLocal` for sub-pixel positioning. Don't change the lookup
  without preserving both halves.
- **Zone subscription updates wipe tile data lazily.** A
  `data.zones` `delete` clears the 64 cells the zone covered, then
  `invalidate()` re-runs `layout()` — which now reads `undefined`
  for those cells and falls back to `EMPTY_TILE_PACKED`. If a fresh
  insert lands before the next layout pass, those cells repopulate
  before paint. Don't try to read `tileData` outside `layout()` —
  the in-between state isn't meaningful.
- **`destroy()` detaches cards rather than destroying them.**
  `CardManager` owns world-card lifecycle; `LayoutWorld.destroy`
  pulls them off the surface so their PIXI containers don't get
  destroyed by the recursive `Container.destroy({ children: true })`
  upstream. Don't add child-destroying paths here.
- **Hex math constants live in `cards/HexCardVisual.ts`.**
  `HEX_RADIUS` / `HEX_WIDTH` / `HEX_HEIGHT` are imported, not
  redefined — flat-top pointy-side geometry. If hex shape ever
  becomes configurable, do it in one place there, not by adding
  constants here.
