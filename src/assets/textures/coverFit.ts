import { Matrix, type Texture } from "pixi.js";

/**
 * Build a `Matrix` that scales a source texture to *cover* a
 * `targetWidth × targetHeight` rectangle uniformly, centred on the
 * rect. "Cover" = the smaller scale factor is dropped; the texture
 * fully fills the target with one axis overflowing equally on both
 * sides (cropped by whatever shape the fill is painted into — a
 * rect, a hex polygon, etc.).
 *
 * Used by card-body texture fills (`def.texture`): we have a
 * 256×256 or 512×512 source PNG and a card body that's neither
 * square nor the same aspect ratio. Stretching distorts the art;
 * letterboxing (contain-fit) leaves dead space inside the body.
 * Cover-fit fills the body fully, accepting that the longer
 * texture axis pokes outside the visible body shape — the
 * polygon clip eats it.
 *
 * Matrix convention: pass to `Graphics.fill({ texture, matrix })`.
 * Pixi multiplies texture-space coordinates by this matrix to find
 * the output coordinate, so we encode `output = matrix * texCoord`:
 *
 *   scale_xy by `s`, then translate by the centring offset.
 *
 * For a `tex.width × tex.height` source covering `w × h`:
 *   s = max(w / tex.width, h / tex.height)
 *   tx = (w - tex.width  * s) / 2
 *   ty = (h - tex.height * s) / 2
 */
export function coverMatrix(
  tex: Texture,
  targetWidth: number,
  targetHeight: number,
): Matrix {
  const s = Math.max(targetWidth / tex.width, targetHeight / tex.height);
  const tx = (targetWidth  - tex.width  * s) / 2;
  const ty = (targetHeight - tex.height * s) / 2;
  // Pixi's `Matrix.set(a, b, c, d, tx, ty)` builds `[a c tx; b d ty]`;
  // uniform scale + translate is `set(s, 0, 0, s, tx, ty)`.
  const m = new Matrix();
  m.set(s, 0, 0, s, tx, ty);
  return m;
}
