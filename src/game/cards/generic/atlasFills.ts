import { Graphics, RenderTexture, Texture, type Renderer } from "pixi.js";
import type { TextureManager } from "../../../assets/textures/TextureManager";
import { hexPoints } from "../layout/hexagon/HexVisual";
import { WORLD_HEX_RADIUS } from "../../viewport/hex/hexSize";

/**
 * Atlas-packed fill textures for the generic primitives. These MUST come from
 * the same atlas as the art so tinted fills batch with sprites in one draw
 * call — Pixi's global `Texture.WHITE` lives on a separate base texture and
 * would split the batch per card. Baked once and cached per `TextureManager`
 * (same lazy-single pattern as `LodTextureManager.ensureWhiteFallback`).
 */

const TILE = 16; // small but >1×1 so setSize math has a real `orig`

const whiteCache = new WeakMap<TextureManager, Texture>();
const hexCache = new WeakMap<TextureManager, Texture>();

/** Atlas-packed white square, for solid `rect` fills (tinted). */
export function atlasWhite(textures: TextureManager, renderer: Renderer): Texture {
  const cached = whiteCache.get(textures);
  if (cached) return cached;
  const g = new Graphics().rect(0, 0, TILE, TILE).fill({ color: 0xffffff });
  const rt = RenderTexture.create({ width: TILE, height: TILE });
  renderer.render({ container: g, target: rt, clear: true });
  g.destroy();
  const packed = textures.pack(rt);
  rt.destroy(true);
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
  const rt = RenderTexture.create({ width: w, height: h });
  renderer.render({ container: g, target: rt, clear: true });
  g.destroy();
  const packed = textures.pack(rt);
  rt.destroy(true);
  hexCache.set(textures, packed);
  return packed;
}
