import { Graphics, Text } from "pixi.js";
import { LayoutRect, type LayoutRectOptions } from "@/ui/layout";
import { client_cards, type CardId } from "@/spacetime/Data";
import { getDefinitionByPacked } from "@/data/definitions/CardDefinitions";

export interface TileStyle {
  fill?: number | string;
  stroke?: number | string;
  strokeWidth?: number;
  alpha?: number;
  labelFill?: number | string;
}

export interface TileOptions extends LayoutRectOptions {
  q?: number;
  r?: number;
  card_id?: CardId;
  definition_id?: number;
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
  public card_id: CardId;
  public definition_id: number;

  private tileName: string;
  private showLabel: boolean;
  private readonly body = new Graphics();
  private readonly labelTile = new Text({ text: "" });
  private style: Required<TileStyle>;

  public constructor(options: TileOptions = {}) {
    super(options);

    this.q = options.q ?? 0;
    this.r = options.r ?? 0;
    this.card_id = options.card_id ?? 0;
    this.definition_id = options.definition_id ?? options.definitionId ?? 0;
    this.tileName = options.name ?? "";
    this.showLabel = options.showLabel ?? false;
    this.style = this.normalizeStyle(options.style);

    this.addChild(this.body);
    this.addChild(this.labelTile);
    this.configureLabel();
    this.refreshDefinition();
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

  public setCardId(card_id: CardId): void {
    if (this.card_id === card_id) {
      return;
    }

    this.card_id = card_id;
    this.refreshDefinition();
    this.invalidateRender();
  }

  public setDefinitionId(definition_id: number): void {
    if (this.definition_id === definition_id) {
      return;
    }

    this.card_id = 0;
    this.definition_id = definition_id;
    this.refreshDefinition();
    this.invalidateRender();
  }

  public setDefinition(definition_id: number): void {
    this.setDefinitionId(definition_id);
  }

  public refreshDefinition(): void {
    const packedDefinition = this.getPackedDefinition();
    const definition = getDefinitionByPacked(packedDefinition);

    this.tileName = definition?.name ?? this.tileName ?? `Tile ${packedDefinition}`;

    const colors = definition?.style?.color;
    this.style = this.normalizeStyle({
      ...this.style,
      fill: colors?.[0] ?? this.style.fill,
      labelFill: colors?.[1] ?? this.style.labelFill,
    });

    this.configureLabel();
    this.labelTile.text = this.tileName;
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
    this.refreshDefinition();

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

  private getPackedDefinition(): number {
    if (this.card_id !== 0) {
      return client_cards[this.card_id]?.definition ?? 0;
    }

    return this.definition_id;
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
      fill: this.parseColor(style.fill) ?? 0x395c39,
      stroke: this.parseColor(style.stroke) ?? 0x0b160b,
      strokeWidth: style.strokeWidth ?? 1,
      alpha: style.alpha ?? 1,
      labelFill: this.parseColor(style.labelFill) ?? 0xf4f8ff,
    };
  }

  private parseColor(color: number | string | undefined): number | undefined {
    if (typeof color === "number") {
      return color;
    }

    if (!color) {
      return undefined;
    }

    const normalizedHex = color.trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(normalizedHex)) {
      return undefined;
    }

    return Number.parseInt(normalizedHex, 16);
  }
}
