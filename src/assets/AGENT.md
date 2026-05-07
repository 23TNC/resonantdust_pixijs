# AGENT.md

## Purpose
GPU-side asset management. `TextureManager` bakes card visuals into
shared atlas pages so every card of a given definition draws from the
same texture region (one GPU texture, many `Sprite`s). `ParticleManager`
hosts particle emitters spawned from JSON-configured effects.
Bootstrap-scoped — both live on `GameContext` and survive scene
changes.

## Important files
- `TextureManager.ts`: per-card-shape atlases keyed by packed
  definition + orientation. Public API: `getRectTexture(definition,
  packed, titlePosition)`, `getHexTexture(definition, packed)`.
  Internally manages `RenderTexture` atlas pages sized to
  `gl.MAX_TEXTURE_SIZE` (capped at 2048 if the context isn't WebGL);
  on first request for a definition, renders a `RectCardVisual` /
  `HexCardVisual` into the next free slot and returns a sub-texture
  for that region. Subsequent requests are pure cache hits.
- `ParticleManager.ts`: scene-scoped (constructed in `GameScene.onEnter`,
  destroyed in `onExit`). Eagerly loads every JSON config in
  `effects/json/*.json` via `import.meta.glob`; `spawn(name, opts)`
  builds an `@spd789562/particle-emitter` `Emitter` from the named
  config and returns a `ParticleHandle` for follow-the-cursor /
  stop-emitting use. Particles render into a single shared
  `ParticleContainer` so the whole effect layer costs ~one draw call
  regardless of emitter count.
- `effects/`: per-effect JSON configs (`json/`) + textures
  (`images/`). New effects: drop a JSON file in `json/` — no code
  change needed.

## Conventions
- **Cards never draw their own visuals on the main scene.** Every
  `RectangleCard` / `HexagonCard` instance ultimately renders a
  `Sprite` whose texture comes from `TextureManager`. The visual
  classes (`RectCardVisual`, `HexCardVisual`) are used only inside
  the atlas baking step. Don't add a card path that draws a
  `Graphics` directly into the scene tree — it defeats the
  draw-call savings.
- **Atlas slots are forever.** Once a definition is rendered into
  an atlas page, that slot is never reused. New definitions append;
  removed/renamed ones leave dead slots until the next page is
  exhausted. Acceptable trade-off for card counts in the low
  hundreds; if it ever bites, switch to a slab allocator.
- **Two rect orientations are pre-baked together.** When either
  `"top"` or `"bottom"` is first requested for a definition, both
  orientations bake in the same call so the second orientation is
  always a cache hit. Don't optimize this away — the cost is two
  Graphics renders instead of one, paid once.
- **Particle effects are tickered manually.** `ParticleManager.tick`
  is called from `GameScene.update`. Don't hook the Pixi ticker
  directly — the manual tick lets the scene own pause/resume and
  HMR teardown.

## Pitfalls
- **`TextureManager` is bootstrap-scoped, particles are not.** The
  texture atlases survive scene changes (cards in different scenes
  reuse the same atlas), but `ParticleManager` is recreated on
  every `GameScene.onEnter`. Don't cache `ctx.particles` outside a
  scene's lifetime.
- **Atlas page allocation can fail late.** If a definition exhausts
  the current page's slot count, a new page is allocated lazily.
  This is fine but means the *first* card to overflow takes a
  noticeable hitch (RenderTexture creation). Mitigate by ensuring
  warm-up renders all known definitions at boot if smoothness
  matters.
- **Definition lookup is best-effort.** `getRectTexture(null, …)` /
  `getHexTexture(null, …)` are valid — they bake a fallback visual
  with the neutral `FALLBACK_STYLE` and `"?"` name. Cards whose
  packed definition doesn't decode still render, just visually
  generic.
- **`EMPTY_TILE_PACKED` and `CUSTOM_PACKED` use sentinels above
  `0xFFFF`.** Real packed definitions are 16-bit; values above are
  out-of-range, so they never collide. If the card type/category
  scheme ever exceeds 16 bits, these sentinels need to move.
