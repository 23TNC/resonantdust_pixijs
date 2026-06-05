import type { Texture } from "pixi.js";
import type { LodTextureManager } from "../../../assets/textures/LodTextureManager";
import type { AssetRef } from "./visualSpec";

/**
 * The single `LodTextureManager` consumer. Every textured primitive resolves
 * its art here, so the "LOD bucket is driven by the actual draw footprint ×
 * dpr" rule lives in exactly one place — the fix for the soul-portrait
 * minification aliasing, and the thing that kept drifting across the five
 * hand-rolled `lodTextures.get(...)` call sites.
 *
 * `footprintCssPx` is the size the sprite will occupy on screen at scale 1.0
 * (CSS px). We pick the LOD for `footprintCssPx × dpr` (so a hi-dpi screen
 * loads the sharper bucket), then return `scale = footprintCssPx / tex.width`
 * so the sprite draws at the requested CSS size regardless of which bucket
 * backed it. `variance` (world-object instance jitter) multiplies the scale.
 */
export interface AssetResolution {
  texture: Texture;
  /** Multiply onto `sprite.scale` to draw `tex` at the requested CSS size. */
  scale: number;
}

export interface ResolveOpts {
  dpr: number;
  faction?: string;
  /** Variant picker when `ref.index` is unset (typically the card/tile id). */
  seed?: number;
  /** Per-instance scale jitter (world objects); default 1. */
  variance?: number;
}

export function resolveAsset(
  lod: LodTextureManager,
  ref: AssetRef,
  footprintCssPx: number,
  opts: ResolveOpts,
): AssetResolution {
  const desired = Math.max(1, footprintCssPx * opts.dpr);
  const texture = lod.get(ref.name, desired, opts.seed ?? 0, ref.index, opts.faction);
  const variance = opts.variance ?? 1;
  return { texture, scale: (footprintCssPx / texture.width) * variance };
}
