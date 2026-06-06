import { Graphics, Rectangle, RenderTexture, Texture, type Renderer } from "pixi.js";
import type { TextureManager } from "../../../assets/textures/TextureManager";
import { hexPoints } from "../../viewport/hex/HexTileVisual";
import { WORLD_HEX_RADIUS } from "../../viewport/hex/hexSize";

/**
 * Atlas-packed fill textures for the generic primitives. These MUST come from
 * the same atlas as the art so tinted fills batch with sprites in one draw
 * call — Pixi's global `Texture.WHITE` lives on a separate base texture and
 * would split the batch per card. Baked once and cached per `TextureManager`
 * (same lazy-single pattern as `LodTextureManager.ensureWhiteFallback`).
 */

const TILE = 16; // small but >1×1 so setSize math has a real `orig`

/** Transparent border baked around each fill before atlas packing, so a
 *  neighbouring slot can't bleed into ours under bilinear sampling — the same
 *  `BAKE_PADDING` idiom `CardTextureManager` / `LodTextureManager` already use.
 *  Without it the hex mask, whose geometry sits flush to its bake bounds (height
 *  = exactly 2·r), shows a stray horizontal line along the bottom from the art
 *  packed below it in the shared atlas. */
const BAKE_PADDING = 2;

const whiteCache = new WeakMap<TextureManager, Texture>();
const hexCache = new WeakMap<TextureManager, Texture>();

/** Render `g` (sized to its `w × h` content bounds) into a RenderTexture grown
 *  by a transparent `BAKE_PADDING` border, pack it, and return a Texture whose
 *  frame is narrowed back to the inner `w × h` — the border stays reserved in
 *  the atlas so adjacent slots can't bleed in, but callers see the original
 *  size. Destroys `g` and the temp RT. Mirrors `CardTextureManager.renderAndPack`. */
function renderAndPack(
  g: Graphics,
  w: number,
  h: number,
  textures: TextureManager,
  renderer: Renderer,
): Texture {
  g.position.set(BAKE_PADDING, BAKE_PADDING);
  const rt = RenderTexture.create({ width: w + BAKE_PADDING * 2, height: h + BAKE_PADDING * 2 });
  renderer.render({ container: g, target: rt, clear: true });
  g.destroy();
  const packed = textures.pack(rt);
  rt.destroy(true);
  return new Texture({
    source: packed.source,
    frame: new Rectangle(packed.frame.x + BAKE_PADDING, packed.frame.y + BAKE_PADDING, w, h),
  });
}

/** Atlas-packed white square, for solid `rect` fills (tinted). */
export function atlasWhite(textures: TextureManager, renderer: Renderer): Texture {
  const cached = whiteCache.get(textures);
  if (cached) return cached;
  const g = new Graphics().rect(0, 0, TILE, TILE).fill({ color: 0xffffff });
  const packed = renderAndPack(g, TILE, TILE, textures, renderer);
  whiteCache.set(textures, packed);
  return packed;
}

/** Atlas-packed white pointy-top hex mask, for `hex` fills (tinted). Baked at
 *  `WORLD_HEX_RADIUS` (the largest hex display size) so it's never upscaled,
 *  using the same `hexPoints` geometry as the legacy hex bake. A `FillPrim`
 *  setSize-stretches it to the card's box, so the mask's native aspect
 *  (√3·r × 2r) is the proportion a hex card's primitive should request. */
export function atlasHex(textures: TextureManager, renderer: Renderer): Texture {
  const cached = hexCache.get(textures);
  if (cached) return cached;
  const r = WORLD_HEX_RADIUS;
  const w = Math.ceil(Math.sqrt(3) * r);
  const h = Math.ceil(2 * r);
  const g = new Graphics().poly(hexPoints(w / 2, h / 2, r)).fill({ color: 0xffffff });
  const packed = renderAndPack(g, w, h, textures, renderer);
  hexCache.set(textures, packed);
  return packed;
}
