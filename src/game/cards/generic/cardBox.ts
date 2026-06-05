import type { Vec2 } from "./visualSpec";

/**
 * The pixel box a card's normalized (0..100) visual spec resolves against,
 * plus the device-pixel ratio used to pick LOD buckets.
 *
 * `dpr` mirrors the renderer's `resolution: min(devicePixelRatio, 2)` (see
 * `main.ts`). It is applied to the LOD *footprint* only — a sprite occupying
 * `w` CSS px is sampled at `w × dpr` device px, so the picker must request the
 * bucket for `w × dpr`. It does NOT affect on-screen size: the sprite still
 * draws at `w` CSS px (the renderer's resolution scales that to device px),
 * which is why `resolveAsset` divides the footprint back out for the scale.
 */
export interface CardBox {
  widthPx: number;
  heightPx: number;
  dpr: number;
}

/** Current capped device-pixel ratio, matching the renderer's `resolution`. */
export function currentDpr(): number {
  return Math.min(window.devicePixelRatio || 1, 2);
}

/** Build a box from a CSS pixel size, capturing dpr at call time. */
export function cardBox(widthPx: number, heightPx: number): CardBox {
  return { widthPx, heightPx, dpr: currentDpr() };
}

/** Normalized 0..100 → horizontal px. */
export function pxX(box: CardBox, norm: number): number {
  return (norm / 100) * box.widthPx;
}

/** Normalized 0..100 → vertical px. */
export function pxY(box: CardBox, norm: number): number {
  return (norm / 100) * box.heightPx;
}

/** A node's footprint in CSS px (larger axis) — the LOD selection input.
 *  Square LOD sources mean one axis suffices, but we take the max so a
 *  non-square authored size never under-selects. */
export function footprintPx(box: CardBox, size: Vec2): number {
  return Math.max(pxX(box, size.x), pxY(box, size.y));
}
