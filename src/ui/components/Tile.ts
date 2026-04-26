import { Graphics, Text } from "pixi.js";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import { client_cards, type CardId } from "@/spacetime/Data";
import { getDefinitionByPacked } from "@/data/definitions/CardDefinitions";

export interface TileOptions extends LayoutObjectOptions {
  /** Dynamic tile — definition is read from client_cards[card_id] each redraw. */
  card_id?: CardId;
  /** Static tile — packed definition used directly when no card_id is set. */
  definition?: number;
  showLabel?: boolean;
}

const DEFAULT_HEX_COLOR  = 0x395c39;
const DEFAULT_TEXT_COLOR = 0xf4f8ff;
const STROKE_COLOR       = 0x0b160b;
const STROKE_WIDTH       = 1;

function parseColor(value: string | undefined): number | null {
  if (!value) return null;
  const hex = value.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex, 16) : null;
}

function flatTopHexPoints(cx: number, cy: number, radius: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    pts.push(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
  }
  return pts;
}

/**
 * Displays a flat-top hexagon sized to its layout bounds.
 *
 * Provide card_id for tiles backed by live card data, or definition (packed)
 * for purely static tiles. card_id takes priority when both are set.
 *
 * Color mapping (from CardDefinition.style.color):
 *   [0] → hex fill
 *   [1] → label text
 */
export class Tile extends LayoutObject {
  private _card_id:    CardId;
  private _definition: number;
  private _showLabel:  boolean;

  private readonly _body  = new Graphics();
  private readonly _label = new Text({ text: "" });

  constructor(options: TileOptions = {}) {
    super(options);

    this._card_id    = options.card_id    ?? 0;
    this._definition = options.definition ?? 0;
    this._showLabel  = options.showLabel  ?? true;

    this._label.anchor.set(0.5);

    this.addDisplay(this._body);
    this.addDisplay(this._label);

    this.invalidateRender();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  setCardId(card_id: CardId): void {
    if (this._card_id === card_id) return;
    this._card_id    = card_id;
    this._definition = 0;
    this.invalidateRender();
  }

  getCardId(): CardId {
    return this._card_id;
  }

  setDefinition(definition: number): void {
    if (this._card_id === 0 && this._definition === definition) return;
    this._card_id    = 0;
    this._definition = definition;
    this.invalidateRender();
  }

  getDefinition(): number {
    return this._resolvePackedDefinition();
  }

  setShowLabel(show: boolean): void {
    if (this._showLabel === show) return;
    this._showLabel = show;
    this.invalidateRender();
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  protected override redraw(): void {
    const packed     = this._resolvePackedDefinition();
    const definition = packed !== 0 ? getDefinitionByPacked(packed) : undefined;
    const colors     = definition?.style?.color ?? [];

    const hexColor  = parseColor(colors[0]) ?? DEFAULT_HEX_COLOR;
    const textColor = parseColor(colors[1]) ?? DEFAULT_TEXT_COLOR;

    const { x, y, width, height } = this.innerRect;
    const cx     = x + width / 2;
    const cy     = y + height / 2;
    const radius = Math.min(width / 2, height / Math.sqrt(3));

    this._body.clear();
    this._body
      .poly(flatTopHexPoints(cx, cy, radius))
      .fill({ color: hexColor })
      .stroke({ color: STROKE_COLOR, width: STROKE_WIDTH });

    const name = definition?.name ?? "";

    this._label.visible = this._showLabel && name.length > 0;
    this._label.text    = name;
    this._label.x       = cx;
    this._label.y       = cy;
    this._label.style   = {
      fill:       textColor,
      fontFamily: "Segoe UI",
      fontSize:   Math.max(6, Math.floor(radius / 3)),
      fontWeight: "700",
      align:      "center",
      wordWrap:   false,
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _resolvePackedDefinition(): number {
    if (this._card_id !== 0) {
      return client_cards[this._card_id]?.definition ?? 0;
    }
    return this._definition;
  }
}
