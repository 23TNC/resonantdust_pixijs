import { Container, Graphics, type Texture } from "pixi.js";
import type { CardDefinition } from "../../definitions/DefinitionManager";
import { coverMatrix } from "../../../assets/textures/coverFit";

const FALLBACK_STYLE = ["#3a3a4a", "#7a7a8a", "#0b1426"] as const;

/** Flat-top pointy-side hexagon vertex list centred on (cx, cy). */
export function hexPoints(cx: number, cy: number, radius: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    pts.push(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
  }
  return pts;
}

/**
 * Hex *tile* background — fill only, no outline / art. Baked by
 * `CardTextureManager.getHex` into the atlas and stamped per world hex tile;
 * hover / pending feedback layers on top elsewhere. (Cards no longer use this —
 * they render through the generic PrimList pipeline; this is world-grid tile
 * rendering, the hex analogue of the rect tile bake.)
 *
 * Width = sqrt(3) * radius, Height = 2 * radius. The origin is the top-left
 * corner of the bounding box, matching PixiJS Container convention. Radius is
 * passed by the caller so this class doesn't depend on a global hex size —
 * `CardTextureManager` owns the bake size and supplies it here.
 */
export class HexTileVisual extends Container {
  private readonly radius: number;
  private readonly hexWidth: number;
  private readonly hexHeight: number;

  private readonly bg = new Graphics();

  constructor(radius: number) {
    super();
    this.radius = radius;
    this.hexWidth = Math.sqrt(3) * radius;
    this.hexHeight = radius * 2;

    this.addChild(this.bg);
  }

  /**
   * Redraw for the given definition. Safe to call every frame; only
   * re-renders the Graphics.
   */
  draw(definition: CardDefinition | null, bodyTexture?: Texture | null): void {
    const style = definition?.style ?? FALLBACK_STYLE;
    const [primary] = style;
    const cx = this.hexWidth  / 2;
    const cy = this.hexHeight / 2;

    const pts = hexPoints(cx, cy, this.radius);

    this.bg.clear();
    // Texture-filled body uses cover-fit against the hex's bounding
    // box; the polygon fill naturally clips the over-covered axis.
    // Falls back to `style[0]` when `def.texture` is unset or the
    // chosen URL hasn't loaded yet (caller refreshes on
    // `lodTextures.onLoad`).
    if (bodyTexture) {
      // `textureSpace: "global"` keeps the matrix in shape-pixel
      // space — Pixi's default `"local"` would normalise the
      // polygon bounds to (0,1) UV before applying the matrix,
      // collapsing our pixel-units cover-fit transform.
      this.bg.poly(pts).fill({
        texture: bodyTexture,
        matrix: coverMatrix(bodyTexture, this.hexWidth, this.hexHeight),
        textureSpace: "global",
      });
    } else {
      this.bg.poly(pts).fill({ color: primary });
    }
  }
}
