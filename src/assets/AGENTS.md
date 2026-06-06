# AGENTS.md

## Purpose
GPU-side asset management — bake/resolve visuals into shared atlas pages so
many `Sprite`s share one GPU texture. Bootstrap-scoped: these managers live on
`GameContext` and survive scene changes. **Cards no longer bake here** — every
card renders through the generic `PrimList` pipeline (`game/cards/generic/`),
resolving LOD art via `LodTextureManager` and solid/hex fills via the generic
`atlasFills`. What still bakes through `CardTextureManager` is **world-grid tile
bodies**.

## Important files
- `textures/TextureManager.ts`: the atlas pager. `pack(source)` copies a
  `RenderTexture` into the next free slot of a shared atlas page (pages sized to
  `gl.MAX_TEXTURE_SIZE`, capped at 2048 off-WebGL) and returns a sub-`Texture`;
  `stats()` reports page/slot counts. Knows nothing about cards or tiles — just
  packs pixels.
- `textures/CardTextureManager.ts`: bakes **world-grid tile bodies** into the
  atlas and caches them. `getHex(def, bodyTexture?)` draws a `HexTileVisual`
  (hex polygon fill, optional cover-fit body texture); `getRectTile(def,
  bodyTexture?)` draws the rect-cell analogue with a `Graphics`. Both are
  consumed by `LayoutWorld.buildTile`. A `null` def bakes a neutral fallback.
- `textures/LodTextureManager.ts`: resolves per-asset art at the right LOD
  bucket (the generic pipeline's sprite source); lazily loads packs and fires
  `onLoad` so previews/ghosts upgrade in place.
- `textures/coverFit.ts`: `coverMatrix(tex, w, h)` — the cover-fit transform
  used when filling a tile/card body with a source texture.
- `fonts.ts`: `loadFonts()` — registers all NotoEmoji font faces via the `FontFace` API before first render, awaited once at bootstrap in `main.ts`. Exports `NOTO_EMOJI_FAMILY` (the CSS family name) for use in Pixi `Text.style.fontFamily`. Without this, Pixi rasterises text with the OS fallback font and never re-renders the same `Text` object when the real font loads.

## Conventions
- **Don't reintroduce a per-card atlas bake.** Cards are generic now: their
  geometry comes from the def's `:visuals` DSL, reconciled by `PrimitiveLayer`.
  Offline card previews (the drag ghost) use `GenericCardFace`, the same
  pipeline rendered without a live row — not a baked card sprite.
- **Atlas slots are forever.** Once packed into an atlas page, a slot is never
  reused. New entries append; removed/renamed ones leave dead slots until the
  next page is exhausted. Acceptable for the low hundreds of tile/art entries;
  if it ever bites, switch to a slab allocator.
- **Tile bakes are keyed by `(packedDef, bodyTexture.uid)`.** A def with a
  faction-resolved body texture bakes one entry per faction (the URL → atlas
  `uid` differs); defs without one key on `uid 0` and bake once.

## Pitfalls
- **Atlas page allocation can fail late.** If a bake exhausts the current
  page's slots, a new page is allocated lazily — the first overflow takes a
  noticeable hitch (RenderTexture creation). Warm-up baking known tiles at boot
  mitigates it if smoothness matters.
- **Tile lookup is best-effort.** `getHex(null, …)` / `getRectTile(null, …)`
  are valid — they bake a fallback body with the neutral `FALLBACK_STYLE`, so a
  tile whose packed def doesn't decode still renders, just visually generic.
