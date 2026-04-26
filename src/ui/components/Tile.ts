import { Graphics, Text, TextStyle } from "pixi.js";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import { client_cards, type CardId } from "@/spacetime/Data";
import { getDefinitionByPacked } from "@/data/definitions/CardDefinitions";

export interface TileOptions extends LayoutObjectOptions {
  /** Dynamic tile — definition is read from client_cards[card_id] each redraw. */
  card_id?:    CardId;
  /** Static tile — packed definition used directly when no card_id is set. */
  definition?: number;
}

const DEFAULT_HEX_COLOR  = 0x395c39;
const DEFAULT_TEXT_COLOR = 0xf4f8ff;
const STROKE_COLOR       = 0x0b160b;
const STROKE_WIDTH       = 1;
const LINE_GAP           = 2;

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
 * Always renders two lines of text centred on the hex:
 *   Line 1 — card name (bold)
 *   Line 2 — world_q, world_r (normal weight)
 *
 * Color mapping (from CardDefinition.style.color):
 *   [0] → hex fill
 *   [1] → text color
 */
export class Tile extends LayoutObject {
  private _card_id:    CardId;
  private _definition: number;
  private _worldQ      = 0;
  private _worldR      = 0;

  private readonly _body   = new Graphics();
  private readonly _label  = new Text({ text: "", style: new TextStyle() });
  private readonly _coords = new Text({ text: "", style: new TextStyle() });

  constructor(options: TileOptions = {}) {
    super({ hitSelf: true, ...options });

    this._card_id    = options.card_id    ?? 0;
    this._definition = options.definition ?? 0;

    this._label.anchor.set(0.5);
    this._coords.anchor.set(0.5);

    this.addDisplay(this._body);
    this.addDisplay(this._label);
    this.addDisplay(this._coords);

    this.invalidateRender();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  setCardId(card_id: CardId): void {
    if (this._card_id === card_id) return;
    this._card_id    = card_id;
    this._definition = 0;
    this.invalidateRender();
  }

  getCardId(): CardId { return this._card_id; }

  setDefinition(definition: number): void {
    if (this._card_id === 0 && this._definition === definition) return;
    this._card_id    = 0;
    this._definition = definition;
    this.invalidateRender();
  }

  getDefinition(): number { return this._resolvePackedDefinition(); }

  setCoords(worldQ: number, worldR: number): void {
    if (this._worldQ === worldQ && this._worldR === worldR) return;
    this._worldQ = worldQ;
    this._worldR = worldR;
    this.invalidateRender();
  }

  getCoords(): { worldQ: number; worldR: number } {
    return { worldQ: this._worldQ, worldR: this._worldR };
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  protected override redraw(): void {
    const packed     = this._resolvePackedDefinition();
    const definition = packed !== 0 ? getDefinitionByPacked(packed) : undefined;
    const colors     = definition?.style?.color ?? [];

    const hexColor  = parseColor(colors[0]) ?? DEFAULT_HEX_COLOR;
    const textColor = parseColor(colors[1]) ?? DEFAULT_TEXT_COLOR;

    const { x, y, width, height } = this.innerRect;
    const cx     = x + width  / 2;
    const cy     = y + height / 2;
    const radius = Math.min(width / 2, height / Math.sqrt(3));

    // ── Hex background ────────────────────────────────────────────────────
    this._body.clear();
    this._body
      .poly(flatTopHexPoints(cx, cy, radius))
      .fill({ color: hexColor })
      .stroke({ color: STROKE_COLOR, width: STROKE_WIDTH });

    // ── Two-line text block centred on the hex ────────────────────────────
    const nameSize  = Math.max(6,  Math.floor(radius / 3));
    const coordSize = Math.max(5,  Math.floor(radius / 4));
    // Treat the two lines as a block; offset so the block is vertically centred.
    const blockH    = nameSize + LINE_GAP + coordSize;
    const blockTop  = cy - blockH / 2;

    const name = definition?.name ?? "";
    this._label.visible = name.length > 0;
    this._label.text    = name;
    this._label.x       = cx;
    this._label.y       = blockTop + nameSize / 2;
    this._label.style   = new TextStyle({
      fill:       textColor,
      fontFamily: "sans-serif",
      fontSize:   nameSize,
      fontWeight: "700",
      align:      "center",
    });

    this._coords.text = `${this._worldQ}, ${this._worldR}`;
    this._coords.x    = cx;
    this._coords.y    = blockTop + nameSize + LINE_GAP + coordSize / 2;
    this._coords.style = new TextStyle({
      fill:       textColor,
      fontFamily: "sans-serif",
      fontSize:   coordSize,
      fontWeight: "400",
      align:      "center",
    });
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _resolvePackedDefinition(): number {
    if (this._card_id !== 0) {
      return client_cards[this._card_id]?.definition ?? 0;
    }
    return this._definition;
  }
}
