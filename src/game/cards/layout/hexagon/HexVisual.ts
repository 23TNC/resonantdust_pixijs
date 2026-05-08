import { Container, Graphics, Text } from "pixi.js";
import type { CardDefinition } from "../../../definitions/DefinitionManager";

export const HEX_RADIUS = 72;
export const HEX_WIDTH  = Math.sqrt(3) * HEX_RADIUS;
export const HEX_HEIGHT = HEX_RADIUS * 2;

const FALLBACK_STYLE = ["#3a3a4a", "#7a7a8a", "#0b1426"] as const;
const FALLBACK_NAME  = "?";

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
 * Width = HEX_WIDTH, Height = HEX_HEIGHT. The origin is the top-left corner
 * of the bounding box, matching PixiJS Container convention.
 */
export class HexCardVisual extends Container {
  private readonly bg = new Graphics();
  private readonly cardOutline = new Graphics();
  readonly nameText: Text;

  constructor() {
    super();
    this.nameText = new Text({
      text: FALLBACK_NAME,
      style: {
        fill: FALLBACK_STYLE[2],
        fontFamily: "Segoe UI",
        fontSize: 11,
        fontWeight: "700",
        align: "center",
        wordWrap: true,
        wordWrapWidth: HEX_WIDTH - 8,
      },
    });
    this.nameText.anchor.set(0.5);
    this.addChild(this.bg);
    this.addChild(this.nameText);
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
    const cx = HEX_WIDTH  / 2;
    const cy = HEX_HEIGHT / 2;

    const strokeColor = selected ? 0xffff00 : outline;
    const strokeWidth = selected ? 3 : 2;
    const pts = hexPoints(cx, cy, HEX_RADIUS - strokeWidth / 2);

    this.bg.clear();
    this.bg.poly(pts).fill({ color: primary });

    this.nameText.text = definition?.name ?? FALLBACK_NAME;
    this.nameText.style.fill = definition?.style[2] ?? FALLBACK_STYLE[2];
    this.nameText.position.set(cx, cy);

    this.cardOutline.clear();
    this.cardOutline.poly(pts).stroke({ color: strokeColor, width: strokeWidth });
  }
}
