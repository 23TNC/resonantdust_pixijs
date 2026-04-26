import { Graphics, Sprite, Text, Texture } from "pixi.js";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import { client_cards, type CardId } from "@/spacetime/Data";
import { getDefinitionByPacked } from "@/data/definitions/CardDefinitions";

export interface CardOptions extends LayoutObjectOptions {
  card_id?: CardId;
  titleHeight?: number;
  radius?: number;
}

const DEFAULT_BODY_COLOR  = 0x1a2a1a;
const DEFAULT_TITLE_COLOR = 0x111a11;
const DEFAULT_TEXT_COLOR  = 0xf4f8ff;

function parseColor(value: string | undefined): number | null {
  if (!value) return null;
  const hex = value.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex, 16) : null;
}

/**
 * A card-shaped LayoutObject driven by a card_id.
 *
 * Layout (top → bottom):
 *   ┌──────────────┐
 *   │  Title bar   │  titleHeight px, colored with style.color[1]
 *   ├──────────────┤
 *   │              │  body, colored with style.color[0]
 *   │   [sprite]   │  sprite centered + scaled to fit (optional)
 *   │              │
 *   └──────────────┘
 *
 * Text uses style.color[2]. All colors fall back to defaults when absent.
 */
export class Card extends LayoutObject {
  private _card_id: CardId;
  private _titleHeight: number;
  private _radius: number;

  private readonly _bg     = new Graphics();
  private readonly _sprite = new Sprite({ texture: Texture.EMPTY });
  private readonly _label  = new Text({ text: "" });

  constructor(options: CardOptions = {}) {
    super({ hitSelf: true, ...options });

    this._card_id     = options.card_id     ?? 0;
    this._titleHeight = options.titleHeight ?? 24;
    this._radius      = options.radius      ?? 8;

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
    const definition = card ? getDefinitionByPacked(card.definition) : undefined;
    const colors     = definition?.style?.color ?? [];

    const bodyColor  = parseColor(colors[0]) ?? DEFAULT_BODY_COLOR;
    const titleColor = parseColor(colors[1]) ?? DEFAULT_TITLE_COLOR;
    const textColor  = parseColor(colors[2]) ?? DEFAULT_TEXT_COLOR;

    const { x, y, width, height } = this.innerRect;
    const titleH = Math.min(this._titleHeight, height);
    const bodyH  = height - titleH;
    const r      = this._radius;

    // ── Background ────────────────────────────────────────────────────────────
    this._bg.clear();

    // Full card in body color (establishes rounded corners for entire card)
    this._bg.roundRect(x, y, width, height, r).fill({ color: bodyColor });

    // Title strip in title color
    if (titleH > 0) {
      this._bg.roundRect(x, y, width, titleH, r).fill({ color: titleColor });

      // Flush the bottom corners of the title strip
      if (bodyH > 0) {
        this._bg.rect(x, y + titleH - r, width, r).fill({ color: titleColor });
      }
    }

    // ── Title text ────────────────────────────────────────────────────────────
    this._label.text    = definition?.name ?? "";
    this._label.visible = titleH > 0;
    this._label.x       = x + width / 2;
    this._label.y       = y + titleH / 2;
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
      this._sprite.y = y + titleH + bodyH / 2;
    }
  }
}
