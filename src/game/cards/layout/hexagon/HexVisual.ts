import { Assets, Container, Graphics, Sprite } from "pixi.js";
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
 * outline stroke, optional sprite overlay, and name label. No tween, no
 * state overlay, no progress ring — those are the caller's responsibility.
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
  private readonly spriteMask = new Graphics();
  private readonly overlaySprite = new Sprite();
  private readonly cardOutline = new Graphics();

  constructor(radius: number) {
    super();
    this.radius = radius;
    this.hexWidth = Math.sqrt(3) * radius;
    this.hexHeight = radius * 2;

    this.overlaySprite.anchor.set(0.5, 0.5);
    this.overlaySprite.mask = this.spriteMask;
    this.overlaySprite.visible = false;
    this.spriteMask.visible = false;

    this.addChild(this.bg);
    this.addChild(this.spriteMask);
    this.addChild(this.overlaySprite);
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
    const fgSprite = style[4] ?? "";
    const cx = this.hexWidth  / 2;
    const cy = this.hexHeight / 2;

    const strokeColor = selected ? 0xffff00 : outline;
    const strokeWidth = selected ? 3 : 2;
    const pts = hexPoints(cx, cy, this.radius - strokeWidth / 2);

    this.bg.clear();
    this.bg.poly(pts).fill({ color: primary });

    this.cardOutline.clear();
    this.cardOutline.poly(pts).stroke({ color: strokeColor, width: strokeWidth });

    if (fgSprite) {
      const tex = Assets.get(`/textures/cards/objects/${fgSprite}`);
      if (tex) {
        this.overlaySprite.texture = tex;
        const scale = Math.min(
          this.hexWidth  / this.overlaySprite.texture.width,
          this.hexHeight / this.overlaySprite.texture.height,
        );
        this.overlaySprite.scale.set(scale);
        this.overlaySprite.position.set(cx, cy);
        this.overlaySprite.visible = true;

        this.spriteMask.clear();
        this.spriteMask.poly(pts).fill({ color: 0xffffff });
        this.spriteMask.visible = true;
      } else {
        this.overlaySprite.visible = false;
        this.spriteMask.visible = false;
      }
    } else {
      this.overlaySprite.visible = false;
      this.spriteMask.visible = false;
    }
  }
}
