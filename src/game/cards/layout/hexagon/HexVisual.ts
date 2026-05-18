import { Container, Graphics } from "pixi.js";
import type { CardDefinition } from "../../../definitions/DefinitionManager";

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
 * Lightweight reusable hex-card *background*: fill only. No outline,
 * no art / portrait. Hover / pending / death feedback layers on top
 * via `LayoutHexCard.stateOverlay`; per-instance art via
 * `CardTextureManager.getCardArt`. See [docs/AGENTS.md] in
 * `assets/textures/` for the two-tier card-texture cache rationale.
 *
 * Width = sqrt(3) * radius, Height = 2 * radius. The origin is the top-
 * left corner of the bounding box, matching PixiJS Container
 * convention. Radius is passed by the caller so this class doesn't
 * depend on a global hex size — TextureManager owns the bake size and
 * supplies it here.
 */
export class HexCardVisual extends Container {
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
  draw(definition: CardDefinition | null): void {
    const style = definition?.style ?? FALLBACK_STYLE;
    const [primary] = style;
    const cx = this.hexWidth  / 2;
    const cy = this.hexHeight / 2;

    const pts = hexPoints(cx, cy, this.radius);

    this.bg.clear();
    this.bg.poly(pts).fill({ color: primary });
  }
}
