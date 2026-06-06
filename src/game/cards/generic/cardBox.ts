import type { Vec2 } from "./visualSpec";

/**
 * Render context for a prim list: just the device-pixel ratio now that prim
 * `pos`/`size` are **absolute pixels** (the DSL sizes everything from
 * `<globals>` — card/cell dimensions — and asset px). Coordinates are no longer
 * normalized to the box, so the box dimensions don't scale anything; they're
 * kept only as context (e.g. a card's own px size) and for callers.
 *
 * `dpr` mirrors the renderer's `resolution: min(devicePixelRatio, 2)` (see
 * `main.ts`). It is applied to the LOD *footprint* only — a sprite occupying
 * `w` CSS px is sampled at `w × dpr` device px, so the picker requests the
 * bucket for `w × dpr`. It does NOT affect on-screen size: the sprite still
 * draws at `w` CSS px (the renderer's resolution scales that to device px),
 * which is why `resolveAsset` divides the footprint back out for the scale.
 */
export interface CardBox {
  widthPx: number;
  heightPx: number;
  dpr: number;
  /** World-pixel offset added to every prim's node position. `0` (the default)
   *  leaves prim coords box-local — the self-mounted case (cards), where the
   *  host container's own transform carries the offset. An externally-mounted
   *  `PrimitiveLayer` (world tiles, whose prims live in a shared sortable
   *  container with no per-tile transform) sets this to the tile's world-pixel
   *  corner so each prim writes an absolute position the shared container can
   *  depth-sort by Y. Baked into `writeNode` because the ease loop rewrites the
   *  node position every step — an external post-offset would be clobbered. */
  originX: number;
  originY: number;
}

/** Current capped device-pixel ratio, matching the renderer's `resolution`. */
export function currentDpr(): number {
  return Math.min(window.devicePixelRatio || 1, 2);
}

/** Build a box from a CSS pixel size, capturing dpr at call time. `origin` is
 *  the world-pixel offset baked into prim positions (default `(0,0)` — box-local
 *  coords for the self-mounted card case; see {@link CardBox.originX}). */
export function cardBox(
  widthPx: number,
  heightPx: number,
  origin: { x: number; y: number } = { x: 0, y: 0 },
): CardBox {
  return { widthPx, heightPx, dpr: currentDpr(), originX: origin.x, originY: origin.y };
}

/** Horizontal px. Prim coords are absolute pixels (DSL-sized from `<globals>`),
 *  so this is identity — the helper stays for call-site clarity / future modes. */
export function pxX(_box: CardBox, px: number): number {
  return px;
}

/** Vertical px — absolute, identity (see `pxX`). */
export function pxY(_box: CardBox, px: number): number {
  return px;
}

/** A node's footprint in CSS px (larger axis) — the LOD selection input.
 *  Square LOD sources mean one axis suffices; max guards a non-square size. */
export function footprintPx(_box: CardBox, size: Vec2): number {
  return Math.max(size.x, size.y);
}
