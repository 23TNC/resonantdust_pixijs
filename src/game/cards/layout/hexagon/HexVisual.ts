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
 * Lightweight reusable hex-card visual: background hex, inner colour band,
 * outline stroke, and name label. No tween, no state overlay, no progress
 * ring — those are the caller's responsibility.
 *
 * Width = sqrt(3) * radius, Height = 2 * radius. The origin is the top-left
 * corner of the bounding box, matching PixiJS Container convention. Radius
 * is passed by the caller so this class doesn't depend on a global hex
 * size — TextureManager owns the bake size and supplies it here.
 */
export class HexCardVisual extends Container {
  private readonly radius: number;
  private readonly hexWidth: number;
  private readonly hexHeight: number;

  private readonly bg = new Graphics();
  private readonly cardOutline = new Graphics();

  constructor(radius: number) {
    super();
    this.radius = radius;
    this.hexWidth = Math.sqrt(3) * radius;
    this.hexHeight = radius * 2;
    this.addChild(this.bg);
    this.addChild(this.cardOutline);
  }

  /**
   * Redraw for the given definition and selection state. Safe to call every
   * frame; only re-renders the Graphics — Text is updated only when the
   * definition or selection changes.
   */
  draw(definition: CardDefinition | null, selected = false): void {
    const style = definition?.style ?? FALLBACK_STYLE;
    const [primary, , outline] = style;
    const cx = this.hexWidth  / 2;
    const cy = this.hexHeight / 2;

    const strokeColor = selected ? 0xffff00 : outline;
    const strokeWidth = selected ? 3 : 2;
    const pts = hexPoints(cx, cy, this.radius - strokeWidth / 2);

    this.bg.clear();
    this.bg.poly(pts).fill({ color: primary });

    this.cardOutline.clear();
    this.cardOutline.poly(pts).stroke({ color: strokeColor, width: strokeWidth });
  }
}
