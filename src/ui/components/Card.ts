import { Container, Graphics, ParticleContainer, Sprite, Text, Texture } from "pixi.js";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import {
  client_cards, client_actions,
  getActionProgress, isActionRunning,
  type CardId, type ClientCard,
} from "@/spacetime/Data";
import { spacetime } from "@/spacetime/SpacetimeManager";
import { type ParticleHandle, ParticleManager } from "@/ui/effects/ParticleManager";
import {
  getDefinitionByPacked,
  getEffectiveTitleOnBottom,
} from "@/definitions/CardDefinitions";
import { getRecipeByIndex } from "@/definitions/RecipeDefinitions";

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

interface BarInfo {
  progress:   number;
  dir:        "ltr" | "rtl";
  leftColor:  number;
  rightColor: number;
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
 * Colors (style.color[]):
 *   [0] body     [1] title bar     [2] text
 *   [3] progress left color        [4] progress right color
 *
 * Progress bar: call setProgress(0–1) to split the title bar into two colored
 * halves.  The split point moves left→right as progress increases (ltr, the
 * default) or right→left (rtl).  colors[3] is always the left half; colors[4]
 * is always the right half — swap them with progress_swap in the style.
 * All colors fall back to defaults when absent.
 */
const DEATH_FADE_MS = 600;

export class Card extends LayoutObject {
  private _card_id:       CardId;
  private _titleHeight:   number;
  private _radius:        number;
  private _titleOnBottom: boolean;
  private _outlineWidth:  number;
  private _outlineColor:  number;
  private _progress:      number | null = null;
  private _deathStartTime: number | null = null;
  private _unlisten:       (() => void) | null = null;

  private readonly _content           = new Container();
  private readonly _bg                = new Graphics();
  private readonly _sprite            = new Sprite({ texture: Texture.EMPTY });
  private readonly _label             = new Text({ text: "" });
  private readonly _clipMask          = new Graphics();
  private readonly _particleContainer = new ParticleContainer({
    dynamicProperties: {
      position: true,
      rotation: true,
      scale: true,
      color: true
    }
  });
  private          _particleHandle:     ParticleHandle | null = null;

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

    // _content holds all card visuals; _clipMask is a sibling so it isn't
    // clipped by itself when used as _content's mask.
    this._content.addChild(this._bg, this._sprite, this._label);
    this.addDisplay(this._content);
    this.addDisplay(this._clipMask);
    this.addDisplay(this._particleContainer);

    if (this._card_id) this._registerListener();
    this.invalidateRender();
  }

  override destroy(options?: Parameters<InstanceType<typeof LayoutObject>["destroy"]>[0]): void {
    this._particleHandle?.destroy();
    this._particleHandle = null;
    this._unlisten?.();
    this._unlisten = null;
    super.destroy(options);
  }

  setCardId(card_id: CardId): void {
    if (this._card_id === card_id) return;
    this._unlisten?.();
    this._unlisten       = null;
    this._card_id        = card_id;
    this._particleHandle?.destroy();
    this._particleHandle  = null;
    this._deathStartTime  = null;
    if (card_id) this._registerListener();
    this.invalidateRender();
  }

  getCardId(): CardId {
    return this._card_id;
  }

  private _registerListener(): void {
    this._unlisten = spacetime.registerCardListener(
      this._card_id,
      () => this.invalidateRender(),
    );
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

  /**
   * Set the progress bar fill amount (0 = empty, 1 = full), or null to hide it.
   * The visual interpretation of 0/1 depends on progress_direction in the card style.
   */
  setProgress(value: number | null): void {
    if (this._progress === value) return;
    this._progress = value;
    this.invalidateRender();
  }

  getProgress(): number | null {
    return this._progress;
  }

  protected override redraw(): void {
    const card = client_cards[this._card_id];

    if (!card || card.dead === 2) {
      this.visible = false;
      this._bg.clear();
      this._label.visible  = false;
      this._sprite.visible = false;
      return;
    }

    if (card.dead === 1) {
      this._redrawDeath(card);
      return;
    }

    this.visible       = true;
    this.alpha         = 1;
    this._content.mask = null;

    const definition = getDefinitionByPacked(card.packed_definition);
    const colors     = definition?.style?.color ?? [];

    const bodyColor  = parseColor(colors[0]) ?? DEFAULT_BODY_COLOR;
    const titleColor = parseColor(colors[1]) ?? DEFAULT_TITLE_COLOR;
    const textColor  = parseColor(colors[2]) ?? DEFAULT_TEXT_COLOR;

    const { x, y, width, height } = this.innerRect;
    const titleH = Math.min(this._titleHeight, height);
    const bodyH  = height - titleH;

    // Shared rule (see CardDefinitions.getEffectiveTitleOnBottom): stacked_down
    // forces bottom, stacked_up forces top, otherwise definition.title_on_bottom.
    // Falls back to the constructor option only when no card is bound.
    const titleOnBottom = card
      ? getEffectiveTitleOnBottom(this._card_id)
      : this._titleOnBottom;

    const bodyY = titleOnBottom ? y : y + titleH;

    const now_seconds = Date.now() / 1000;
    const active = Object.values(client_actions).filter(a =>
      a.card_id === this._card_id && isActionRunning(a),
    );

    if (active.length > 0) this.invalidateRender();

    let primary:   BarInfo | null = null;
    let secondary: BarInfo | null = null;

    if (active.length > 0) {
      console.log()
      const s0 = getRecipeByIndex(active[0].recipe)?.style;
      primary = {
        progress:   getActionProgress(active[0], now_seconds),
        dir:        s0?.direction ?? "ltr",
        leftColor:  (!s0?.leftColor  || s0.leftColor  === "default") ? titleColor : (parseColor(s0.leftColor)  ?? titleColor),
        rightColor: (!s0?.rightColor || s0.rightColor === "default") ? titleColor : (parseColor(s0.rightColor) ?? titleColor),
      };

      console.log(primary.progress)

      if (active.length >= 2) {
        const s1 = getRecipeByIndex(active[1].recipe)?.style;
        secondary = {
          progress:   getActionProgress(active[1], now_seconds),
          dir:        s1?.direction ?? "ltr",
          leftColor:  (!s1?.leftColor  || s1.leftColor  === "default") ? titleColor : (parseColor(s1.leftColor)  ?? titleColor),
          rightColor: (!s1?.rightColor || s1.rightColor === "default") ? titleColor : (parseColor(s1.rightColor) ?? titleColor),
        };
      }
    } else if (this._progress !== null) {
      primary = { progress: this._progress, dir: "ltr", leftColor: titleColor, rightColor: bodyColor };
    }
    
    // Compute secondary bar height for label centering (mirrors _drawCard logic).
    const clampedR   = Math.min(this._radius, width / 2, height / 2, titleH);
    const secondaryH = secondary !== null
      ? Math.min(Math.round(titleH / 3), Math.max(0, titleH - Math.ceil(clampedR) - 1))
      : 0;
    const primaryH    = titleH - secondaryH;
    const primaryBarY = titleOnBottom ? y + height - primaryH : y;

    // ── Background ────────────────────────────────────────────────────────────
    this._bg.clear();

    this._drawCard(
      x, y, width, height, titleH, this._radius,
      [bodyColor, titleColor],
      titleOnBottom,
      primary,
      secondary,
    );

    // ── Title text ────────────────────────────────────────────────────────────
    this._label.text    = definition?.display_name ?? "";
    this._label.visible = titleH > 0;
    this._label.x       = x + width / 2;
    this._label.y       = primaryBarY + primaryH / 2;
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

  // ─── Death animation ─────────────────────────────────────────────────────

  private _redrawDeath(card: ClientCard): void {
    if (this._deathStartTime === null) {
      this._deathStartTime = Date.now();
      const pm = ParticleManager.getInstance();
      if (pm) {
        const def        = getDefinitionByPacked(card.packed_definition);
        const bodyColor  = parseColor(def?.style?.color?.[0]) ?? DEFAULT_BODY_COLOR;
        const startColor = bodyColor.toString(16).padStart(6, "0");
        this._particleHandle = pm.createEmitter(this._particleContainer, "burn_up", { startColor });
      }
    }

    const t = Math.min(2, (Date.now() - this._deathStartTime) / DEATH_FADE_MS);
    this._animateDeath(t);

    if (t < 2) {
      this.invalidateRender();
    } else {
      card.dead = 2;
      spacetime.notifyCardListeners(this._card_id);
    }
  }

  private _animateDeath(t: number): void {
    if (t <= 1) {
      const { x, y, width, height } = this.innerRect;
      this._particleContainer.position.set(x + width / 2, y + height * (1 - t));
      this._clipMask.clear().rect(x, y - 5, width, (5 + height) * (1 - t)).fill(0xffffff);
      this._content.mask = this._clipMask;
    } else {
      this._particleHandle?.stop();
    }
  }

  // ─── Card drawing ──────────────────────────────────────────────────────────

  private _drawCard(
    x:             number,
    y:             number,
    width:         number,
    height:        number,
    titleHeight:   number,
    radius:        number,
    colors:        number[],
    titleOnBottom: boolean,
    primary:       BarInfo | null,
    secondary:     BarInfo | null,
  ): void {
    const bodyColor  = colors[0] ?? DEFAULT_BODY_COLOR;
    const titleColor = colors[1] ?? DEFAULT_TITLE_COLOR;
    const r          = Math.min(radius, width / 2, height / 2, titleHeight);

    this._bg.roundRect(x, y, width, height, r).fill({ color: bodyColor });

    if (titleHeight > 0) {
      const secondaryH = secondary !== null
        ? Math.min(Math.round(titleHeight / 3), Math.max(0, titleHeight - Math.ceil(r) - 1))
        : 0;
      const primaryH = titleHeight - secondaryH;

      const primaryY   = titleOnBottom ? y + height - primaryH   : y;
      const secondaryY = titleOnBottom ? y + height - titleHeight : y + primaryH;

      this._drawTitleBar(x, primaryY, width, primaryH, r, titleColor, primary, titleOnBottom);

      if (secondary !== null && secondaryH > 0) {
        this._drawSecondaryBar(x, secondaryY, width, secondaryH, secondary);
      }
    }

    if (this._outlineWidth > 0) {
      this._bg
        .roundRect(x, y, width, height, r)
        .stroke({ color: this._outlineColor, width: this._outlineWidth });
    }
  }

  private _drawTitleBar(
    x:             number,
    y:             number,
    width:         number,
    height:        number,
    radius:        number,
    titleColor:    number,
    bar:           BarInfo | null,
    titleOnBottom: boolean,
  ): void {
    if (bar === null) {
      this._drawTitleSlice(x, y, width, height, radius, 0, width, titleColor, titleOnBottom);
      return;
    }

    const clamped   = Math.max(0, Math.min(1, bar.progress));
    const splitFrac = bar.dir === "ltr" ? clamped : 1 - clamped;
    const splitX    = width * splitFrac;

    this._drawTitleSlice(x, y, width, height, radius, 0, splitX, bar.leftColor, titleOnBottom);
    this._drawTitleSlice(x, y, width, height, radius, splitX, width, bar.rightColor, titleOnBottom);
  }

  private _drawSecondaryBar(
    x:      number,
    y:      number,
    width:  number,
    height: number,
    bar:    BarInfo,
  ): void {
    const clamped   = Math.max(0, Math.min(1, bar.progress));
    const splitFrac = bar.dir === "ltr" ? clamped : 1 - clamped;
    const splitX    = width * splitFrac;

    if (splitX > 0)     this._bg.rect(x,           y, splitX,         height).fill({ color: bar.leftColor });
    if (splitX < width) this._bg.rect(x + splitX,  y, width - splitX, height).fill({ color: bar.rightColor });
  }

  private _drawTitleSlice(
    x:             number,
    y:             number,
    width:         number,
    height:        number,
    radius:        number,
    x0:            number,
    x1:            number,
    color:         number,
    titleOnBottom: boolean,
  ): void {
    const r = Math.min(radius, width / 2, height);

    x0 = Math.max(0, Math.min(width, x0));
    x1 = Math.max(0, Math.min(width, x1));

    if (x1 <= x0) return;

    if (titleOnBottom) {
      this._drawBottomTitleSlice(x, y, width, height, r, x0, x1, color);
    } else {
      this._drawTopTitleSlice(x, y, width, height, r, x0, x1, color);
    }
  }

  private _drawTopTitleSlice(
    x:      number,
    y:      number,
    width:  number,
    height: number,
    r:      number,
    x0:     number,
    x1:     number,
    color:  number,
  ): void {
    this._bg.moveTo(x + x0, y + height);
    this._bg.lineTo(x + x0, y + this._topTitleY(x0, width, r));

    this._drawTopEdge(x, y, width, r, x0, x1);

    this._bg.lineTo(x + x1, y + height);
    this._bg.lineTo(x + x0, y + height);
    this._bg.fill({ color });
  }

  private _drawBottomTitleSlice(
    x:      number,
    y:      number,
    width:  number,
    height: number,
    r:      number,
    x0:     number,
    x1:     number,
    color:  number,
  ): void {
    this._bg.moveTo(x + x0, y);
    this._bg.lineTo(x + x1, y);
    this._bg.lineTo(x + x1, y + this._bottomTitleY(x1, width, height, r));

    this._drawBottomEdgeRightToLeft(x, y, width, height, r, x0, x1);

    this._bg.lineTo(x + x0, y);
    this._bg.fill({ color });
  }

  private _drawTopEdge(
    x:     number,
    y:     number,
    width: number,
    r:     number,
    x0:    number,
    x1:    number,
  ): void {
    if (x0 < r && x1 > 0) {
      const from = Math.max(x0, 0);
      const to   = Math.min(x1, r);
      if (to > from) {
        this._bg.arc(x + r, y + r, r, this._topLeftAngle(from, r), this._topLeftAngle(to, r));
      }
    }

    const flatFrom = Math.max(x0, r);
    const flatTo   = Math.min(x1, width - r);
    if (flatTo > flatFrom) {
      this._bg.lineTo(x + flatTo, y);
    }

    if (x0 < width && x1 > width - r) {
      const from = Math.max(x0, width - r);
      const to   = Math.min(x1, width);
      if (to > from) {
        this._bg.arc(
          x + width - r,
          y + r,
          r,
          this._topRightAngle(from, width, r),
          this._topRightAngle(to, width, r),
        );
      }
    }
  }

  private _drawBottomEdgeRightToLeft(
    x:      number,
    y:      number,
    width:  number,
    height: number,
    r:      number,
    x0:     number,
    x1:     number,
  ): void {
    if (x1 > width - r && x0 < width) {
      const from = Math.min(x1, width);
      const to   = Math.max(x0, width - r);
      if (from > to) {
        this._bg.arc(
          x + width - r,
          y + height - r,
          r,
          this._bottomRightAngle(from, width, r),
          this._bottomRightAngle(to, width, r),
        );
      }
    }

    const flatRight = Math.min(x1, width - r);
    const flatLeft  = Math.max(x0, r);
    if (flatRight > flatLeft) {
      this._bg.lineTo(x + flatLeft, y + height);
    }

    if (x0 < r && x1 > 0) {
      const from = Math.min(x1, r);
      const to   = Math.max(x0, 0);
      if (from > to) {
        this._bg.arc(
          x + r,
          y + height - r,
          r,
          this._bottomLeftAngle(from, r),
          this._bottomLeftAngle(to, r),
        );
      }
    }
  }

  private _topTitleY(x: number, width: number, r: number): number {
    if (r <= 0) return 0;

    if (x < r) {
      const dx = x - r;
      return r - Math.sqrt(r * r - dx * dx);
    }

    if (x > width - r) {
      const dx = x - (width - r);
      return r - Math.sqrt(r * r - dx * dx);
    }

    return 0;
  }

  private _bottomTitleY(x: number, width: number, height: number, r: number): number {
    if (r <= 0) return height;

    if (x < r) {
      const dx = x - r;
      return height - r + Math.sqrt(r * r - dx * dx);
    }

    if (x > width - r) {
      const dx = x - (width - r);
      return height - r + Math.sqrt(r * r - dx * dx);
    }

    return height;
  }

  private _topLeftAngle(x: number, r: number): number {
    return Math.PI * 2 - Math.acos((x - r) / r);
  }

  private _topRightAngle(x: number, width: number, r: number): number {
    return Math.PI * 2 - Math.acos((x - (width - r)) / r);
  }

  private _bottomLeftAngle(x: number, r: number): number {
    return Math.acos((x - r) / r);
  }

  private _bottomRightAngle(x: number, width: number, r: number): number {
    return Math.acos((x - (width - r)) / r);
  }

}
