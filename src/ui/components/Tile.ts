import { Graphics, Text } from "pixi.js";
import { LayoutRect } from "@/ui/layout";

type LayoutPadding =
  | number
  | {
      top?: number;
      right?: number;
      bottom?: number;
      left?: number;
    };

export interface TileStyle {
  fill?: number | string;
  stroke?: number | string;
  strokeWidth?: number;
  alpha?: number;
  labelFill?: number | string;
}

export interface TileOptions {
  q?: number;
  r?: number;
  definitionId?: number;
  name?: string;
  style?: TileStyle;
  showLabel?: boolean;
  originX?: number;
  originY?: number;
}

export class Tile extends LayoutRect {
  public q: number;
  public r: number;
  public definitionId: number;

  private tileName: string;
  private showLabel: boolean;
  private readonly body = new Graphics();
  private readonly labelTile = new Text({ text: "" });
  private style: Required<TileStyle>;

  public constructor(
    x: number,
    y: number,
    width: number,
    height: number,
    padding: LayoutPadding = 0,
    options: TileOptions = {},
  ) {
    super(x, y, width, height, padding, {
      originX: options.originX,
      originY: options.originY,
    });

    this.q = options.q ?? 0;
    this.r = options.r ?? 0;
    this.definitionId = options.definitionId ?? 0;
    this.tileName = options.name ?? "";
    this.showLabel = options.showLabel ?? false;
    this.style = this.normalizeStyle(options.style);

    this.addChild(this.body);
    this.addChild(this.labelTile);
    this.configureLabel();
    this.invalidateRender();
  }

  public setTileCoord(q: number, r: number): void {
    if (this.q === q && this.r === r) {
      return;
    }

    this.q = q;
    this.r = r;
    this.invalidateRender();
  }

  public setDefinition(definitionId: number, name = this.tileName): void {
    if (this.definitionId === definitionId && this.tileName === name) {
      return;
    }

    this.definitionId = definitionId;
    this.tileName = name;
    this.labelTile.text = name;
    this.invalidateRender();
  }

  public setTileStyle(style: TileStyle): void {
    this.style = this.normalizeStyle(style);
    this.configureLabel();
    this.invalidateRender();
  }

  public setShowLabel(showLabel: boolean): void {
    if (this.showLabel === showLabel) {
      return;
    }

    this.showLabel = showLabel;
    this.labelTile.visible = showLabel;
    this.invalidateRender();
  }

  public override updateRects(): void {
    super.updateRects();
    this.invalidateRender();
  }

  protected override redraw(): void {
    const w = this.innerRect.width;
    const h = this.innerRect.height;
    const cx = this.innerRect.x + w / 2;
    const cy = this.innerRect.y + h / 2;
    const radius = Math.max(0, Math.min(w / 2, h / Math.sqrt(3)));
    const points = this.getFlatTopHexPoints(cx, cy, radius);

    this.body.clear();
    this.body.poly(points).fill({ color: this.style.fill, alpha: this.style.alpha });

    if (this.style.strokeWidth > 0) {
      this.body.stroke({ color: this.style.stroke, width: this.style.strokeWidth });
    }

    this.labelTile.text = this.tileName;
    this.labelTile.visible = this.showLabel;
    this.labelTile.anchor.set(0.5);
    this.labelTile.x = cx;
    this.labelTile.y = cy;
    this.labelTile.style.fontSize = Math.max(8, Math.round(radius / 3));
  }

  private getFlatTopHexPoints(cx: number, cy: number, radius: number): number[] {
    const points: number[] = [];

    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 180) * (60 * i);
      points.push(cx + radius * Math.cos(angle));
      points.push(cy + radius * Math.sin(angle));
    }

    return points;
  }

  private configureLabel(): void {
    this.labelTile.style = {
      fill: this.style.labelFill,
      fontFamily: "Segoe UI",
      fontSize: 12,
      fontWeight: "700",
      align: "center",
    };
    this.labelTile.visible = this.showLabel;
  }

  private normalizeStyle(style: TileStyle = {}): Required<TileStyle> {
    return {
      fill: style.fill ?? 0x395c39,
      stroke: style.stroke ?? 0x0b160b,
      strokeWidth: style.strokeWidth ?? 1,
      alpha: style.alpha ?? 1,
      labelFill: style.labelFill ?? 0xf4f8ff,
    };
  }
}
