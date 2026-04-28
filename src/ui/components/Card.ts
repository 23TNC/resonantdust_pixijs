import { Graphics, Sprite, Text, Texture } from "pixi.js";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import { client_cards, type CardId } from "@/spacetime/Data";
import { getDefinitionByPacked, getEffectiveTitleOnBottom } from "@/data/definitions/CardDefinitions";

export interface CardOptions extends LayoutObjectOptions {
  card_id?:       CardId;
  titleHeight?:   number;
  radius?:        number;
  /** When true, the title bar is drawn at the bottom instead of the top. Default: false. */
  titleOnBottom?: boolean;
  /** Outline thickness in pixels. Default: 1.  Set to 0 to disable. */
  outlineWidth?:  number;
  /** Outline color. Default: DEFAULT_OUTLINE_COLOR. */
  outlineColor?:  number;
}

const DEFAULT_BODY_COLOR    = 0x1a2a1a;
const DEFAULT_TITLE_COLOR   = 0x111a11;
const DEFAULT_TEXT_COLOR    = 0xf4f8ff;
const DEFAULT_OUTLINE_COLOR = 0x0b160b;
const DEFAULT_OUTLINE_WIDTH = 1.2;

function parseColor(value: string | undefined): number | null {
  if (!value) return null;
  const hex = value.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex, 16) : null;
}

/**
 * A card-shaped LayoutObject driven by a card_id.
 *
 * titleOnBottom = false (default):       titleOnBottom = true:
 *   ┌──────────────┐                       ┌──────────────┐
 *   │  Title bar   │  titleHeight px        │              │  body
 *   ├──────────────┤                        │   [sprite]   │
 *   │              │  body                  │              │
 *   │   [sprite]   │                        ├──────────────┤
 *   │              │                        │  Title bar   │  titleHeight px
 *   └──────────────┘                        └──────────────┘
 *
 * Colors: style.color[0] = body, [1] = title bar, [2] = text.
 * All colors fall back to defaults when absent.
 */
export class Card extends LayoutObject {
  private _card_id:       CardId;
  private _titleHeight:   number;
  private _radius:        number;
  private _titleOnBottom: boolean;
  private _outlineWidth:  number;
  private _outlineColor:  number;

  private readonly _bg     = new Graphics();
  private readonly _sprite = new Sprite({ texture: Texture.EMPTY });
  private readonly _label  = new Text({ text: "" });

  constructor(options: CardOptions = {}) {
    super({ hitSelf: true, ...options });

    this._card_id       = options.card_id       ?? 0;
    this._titleHeight   = options.titleHeight   ?? 24;
    this._radius        = options.radius        ?? 8;
    this._titleOnBottom = options.titleOnBottom ?? false;
    this._outlineWidth  = options.outlineWidth  ?? DEFAULT_OUTLINE_WIDTH;
    this._outlineColor  = options.outlineColor  ?? DEFAULT_OUTLINE_COLOR;

    this._sprite.anchor.set(0.5);
    this._sprite.visible = false;
    this._label.anchor.set(0.5);

    // z-order: background → sprite → label
    this.addDisplay(this._bg);
    this.addDisplay(this._sprite);
    this.addDisplay(this._label);

    this.invalidateRender();
  }

  setCardId(card_id: CardId): void {
    if (this._card_id === card_id) return;
    this._card_id = card_id;
    this.invalidateRender();
  }

  getCardId(): CardId {
    return this._card_id;
  }

  setTexture(texture: Texture | null): void {
    if (texture) {
      this._sprite.texture = texture;
      this._sprite.visible = true;
    } else {
      this._sprite.texture = Texture.EMPTY;
      this._sprite.visible = false;
    }
    this.invalidateRender();
  }

  protected override redraw(): void {
    const card       = client_cards[this._card_id];
    const definition = card ? getDefinitionByPacked(card.packed_definition) : undefined;
    const colors     = definition?.style?.color ?? [];

    const bodyColor  = parseColor(colors[0]) ?? DEFAULT_BODY_COLOR;
    const titleColor = parseColor(colors[1]) ?? DEFAULT_TITLE_COLOR;
    const textColor  = parseColor(colors[2]) ?? DEFAULT_TEXT_COLOR;

    const { x, y, width, height } = this.innerRect;
    const titleH = Math.min(this._titleHeight, height);
    const bodyH  = height - titleH;
    const r      = this._radius;

    // Shared rule (see CardDefinitions.getEffectiveTitleOnBottom): stacked_down
    // forces bottom, stacked_up forces top, otherwise definition.title_on_bottom.
    // Falls back to the constructor option only when no card is bound.
    const titleOnBottom = card
      ? getEffectiveTitleOnBottom(this._card_id)
      : this._titleOnBottom;

    // titleY = top of the title strip; bodyY = top of the body area.
    const titleY = titleOnBottom ? y + bodyH : y;
    const bodyY  = titleOnBottom ? y : y + titleH;

    // ── Background ────────────────────────────────────────────────────────────
    this._bg.clear();

    // Full card in body color (establishes rounded corners for entire card)
    this._bg.roundRect(x, y, width, height, r).fill({ color: bodyColor });

    // Title strip in title color
    if (titleH > 0) {
      this._bg.roundRect(x, titleY, width, titleH, r).fill({ color: titleColor });

      // Flush the inner corners of the title strip where it meets the body.
      if (bodyH > 0) {
        const flushY = titleOnBottom ? titleY : titleY + titleH - r;
        this._bg.rect(x, flushY, width, r).fill({ color: titleColor });
      }
    }

    // Outline — drawn last so it sits on top of any earlier fills along the edge.
    if (this._outlineWidth > 0) {
      this._bg
        .roundRect(x, y, width, height, r)
        .stroke({ color: this._outlineColor, width: this._outlineWidth });
    }

    // ── Title text ────────────────────────────────────────────────────────────
    this._label.text    = definition?.name ?? "";
    this._label.visible = titleH > 0;
    this._label.x       = x + width / 2;
    this._label.y       = titleY + titleH / 2;
    this._label.style   = {
      fill:       textColor,
      fontFamily: "Segoe UI",
      fontSize:   Math.max(8, Math.floor(titleH * 0.55)),
      fontWeight: "700",
      align:      "center",
    };

    // ── Sprite ────────────────────────────────────────────────────────────────
    if (this._sprite.visible && bodyH > 0) {
      const pad    = 4;
      const availW = Math.max(0, width  - pad * 2);
      const availH = Math.max(0, bodyH  - pad * 2);
      const tw     = this._sprite.texture.width;
      const th     = this._sprite.texture.height;
      const scale  = (tw > 0 && th > 0)
        ? Math.min(availW / tw, availH / th)
        : 1;

      this._sprite.scale.set(scale);
      this._sprite.x = x + width / 2;
      this._sprite.y = bodyY + bodyH / 2;
    }
  }
}
