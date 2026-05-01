import { Container, Graphics, ParticleContainer, Text } from "pixi.js";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import {
  client_cards, client_actions,
  getActionProgress, isActionRunning,
  type CardId, type ClientCard,
} from "@/spacetime/Data";
import { spacetime } from "@/spacetime/SpacetimeManager";
import { deathState } from "@/model/CardModel";
import { DeathCoordinator } from "@/coordinators/DeathCoordinator";
import { type ParticleHandle, ParticleManager } from "@/ui/effects/ParticleManager";
import { getDefinitionByPacked } from "@/definitions/CardDefinitions";
import { getRecipeByIndex } from "@/definitions/RecipeDefinitions";

export interface HexCardOptions extends LayoutObjectOptions {
  card_id?: CardId;
  /** Outline thickness. Default: 1.2.  Set to 0 to disable. */
  outlineWidth?: number;
  /** Outline color. Default: 0x0b160b. */
  outlineColor?: number;
  /** Width of the progress arc (pixels). Default: 4. */
  progressArcWidth?: number;
  /** Inset of the progress arc from the hex edge (pixels). Default: 2. */
  progressArcInset?: number;
}

const DEFAULT_HEX_COLOR     = 0x395c39;
const DEFAULT_TITLE_COLOR   = 0x111a11;
const DEFAULT_TEXT_COLOR    = 0xf4f8ff;
const DEFAULT_OUTLINE_COLOR = 0x0b160b;
const DEFAULT_OUTLINE_WIDTH = 1.2;
const DEFAULT_ARC_WIDTH     = 4;
const DEFAULT_ARC_INSET     = 2;

const DEATH_FADE_MS = 600;

function parseColor(value: string | undefined): number | null {
  if (!value) return null;
  const hex = value.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex, 16) : null;
}

function pointyTopHexPoints(cx: number, cy: number, radius: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    pts.push(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
  }
  return pts;
}

interface BarInfo {
  progress:   number;
  dir:        "ltr" | "rtl";
  leftColor:  number;
  rightColor: number;
}

/**
 * Card-bound hex visual.
 *
 * Counterpart to `Card` for card_types whose `shape == "hex"` per
 * `data/card_types.json`.  Renders a pointy-top hexagon with a centred
 * display name; when the bound card has running actions, draws a circular
 * progress arc inset from the hex edge in the recipe's title color (or
 * `default` → the card's title color from its style).
 *
 * Lifecycle: same as `Card` — registers a per-card listener via
 * `spacetime.registerCardListener`, plays a death-fade animation driven by
 * `deathState`, and emits a particle burst via `ParticleManager` while the
 * row is dying.  Hit testing uses `hitSelf: true`; the hex bounding box is
 * the layout rect, so the hex's pointy corners protrude slightly beyond the
 * hit region — acceptable for now since drag sources only need a coarse
 * hit.
 *
 * Geometry:
 *   radius = min(width / √3, height / 2)
 * placed at the centre of `innerRect`.  Text is centred on the hex.
 */
export class HexCard extends LayoutObject {
  private _card_id:          CardId;
  private _outlineWidth:     number;
  private _outlineColor:     number;
  private _arcWidth:         number;
  private _arcInset:         number;
  private _progress:         number | null = null;
  private _deathStartTime:   number | null = null;
  private _unlisten:         (() => void) | null = null;

  private readonly _content           = new Container();
  private readonly _bg                = new Graphics();
  private readonly _arc               = new Graphics();
  private readonly _label             = new Text({ text: "" });
  private readonly _clipMask          = new Graphics();
  private readonly _particleContainer = new ParticleContainer({
    dynamicProperties: {
      position: true,
      rotation: true,
      scale:    true,
      color:    true,
    },
  });
  private          _particleHandle:    ParticleHandle | null = null;

  constructor(options: HexCardOptions = {}) {
    super({ hitSelf: true, ...options });

    this._card_id      = options.card_id          ?? 0;
    this._outlineWidth = options.outlineWidth     ?? DEFAULT_OUTLINE_WIDTH;
    this._outlineColor = options.outlineColor     ?? DEFAULT_OUTLINE_COLOR;
    this._arcWidth     = options.progressArcWidth ?? DEFAULT_ARC_WIDTH;
    this._arcInset     = options.progressArcInset ?? DEFAULT_ARC_INSET;

    this._label.anchor.set(0.5);

    this._content.addChild(this._bg, this._arc, this._label);
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

  // ─── Public API ──────────────────────────────────────────────────────────

  setCardId(card_id: CardId): void {
    if (this._card_id === card_id) return;
    this._unlisten?.();
    this._unlisten       = null;
    this._card_id        = card_id;
    this._particleHandle?.destroy();
    this._particleHandle = null;
    this._deathStartTime = null;
    if (card_id) this._registerListener();
    this.invalidateRender();
  }

  getCardId(): CardId { return this._card_id; }

  /** Set a manual progress override (0–1) when no action is running.  Pass
   *  null to clear. */
  setProgress(value: number | null): void {
    if (this._progress === value) return;
    this._progress = value;
    this.invalidateRender();
  }

  getProgress(): number | null { return this._progress; }

  // ─── Render ──────────────────────────────────────────────────────────────

  protected override redraw(): void {
    const card = client_cards[this._card_id];
    const dead = deathState(this._card_id);

    if (!card || dead === 2) {
      this.visible        = false;
      this._bg.clear();
      this._arc.clear();
      this._label.visible = false;
      return;
    }

    if (dead === 1) {
      this._redrawDeath(card);
      return;
    }

    this.visible       = true;
    this.alpha         = 1;
    this._content.mask = null;

    const definition = getDefinitionByPacked(card.packed_definition);
    const colors     = definition?.style?.color ?? [];

    const hexColor   = parseColor(colors[0]) ?? DEFAULT_HEX_COLOR;
    const titleColor = parseColor(colors[1]) ?? DEFAULT_TITLE_COLOR;
    const textColor  = parseColor(colors[2]) ?? DEFAULT_TEXT_COLOR;

    const { x, y, width, height } = this.innerRect;
    const cx     = x + width  / 2;
    const cy     = y + height / 2;
    const radius = Math.min(width / Math.sqrt(3), height / 2);

    // ── Hex background ────────────────────────────────────────────────────
    this._bg.clear();
    this._bg.poly(pointyTopHexPoints(cx, cy, radius)).fill({ color: hexColor });
    if (this._outlineWidth > 0) {
      this._bg
        .poly(pointyTopHexPoints(cx, cy, radius))
        .stroke({ color: this._outlineColor, width: this._outlineWidth });
    }

    // ── Progress arc ──────────────────────────────────────────────────────
    const now_seconds = Date.now() / 1000;
    const active = Object.values(client_actions).filter(a =>
      a.card_id === this._card_id && isActionRunning(a),
    );

    if (active.length > 0) this.invalidateRender();

    let primary: BarInfo | null = null;
    if (active.length > 0) {
      const s0 = getRecipeByIndex(active[0].recipe)?.style;
      primary = {
        progress:   getActionProgress(active[0], now_seconds),
        dir:        s0?.direction ?? "ltr",
        leftColor:  (!s0?.leftColor  || s0.leftColor  === "default") ? titleColor : (parseColor(s0.leftColor)  ?? titleColor),
        rightColor: (!s0?.rightColor || s0.rightColor === "default") ? titleColor : (parseColor(s0.rightColor) ?? titleColor),
      };
    } else if (this._progress !== null) {
      primary = { progress: this._progress, dir: "ltr", leftColor: titleColor, rightColor: hexColor };
    }

    this._arc.clear();
    if (primary !== null) {
      this._drawProgressArc(cx, cy, radius - this._arcInset, primary);
    }

    // ── Label (display name centred) ──────────────────────────────────────
    const fontSize = Math.max(8, Math.floor(radius / 3));
    this._label.text    = definition?.display_name ?? "";
    this._label.visible = this._label.text.length > 0;
    this._label.x       = cx;
    this._label.y       = cy;
    this._label.style   = {
      fill:       textColor,
      fontFamily: "Segoe UI",
      fontSize,
      fontWeight: "700",
      align:      "center",
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _registerListener(): void {
    this._unlisten = spacetime.registerCardListener(
      this._card_id,
      () => this.invalidateRender(),
    );
  }

  /** Draw a circular arc around the hex centre.  Progress fills `dir` from
   *  the top (12 o'clock) clockwise (ltr) or counter-clockwise (rtl).  The
   *  remaining sector uses `rightColor` so a half-finished bar always shows
   *  both halves like the rect title-bar does. */
  private _drawProgressArc(cx: number, cy: number, r: number, bar: BarInfo): void {
    const clamped = Math.max(0, Math.min(1, bar.progress));
    const start   = -Math.PI / 2;
    const sweep   = Math.PI * 2;

    const filled = sweep * clamped;
    const remain = sweep - filled;

    if (bar.dir === "ltr") {
      if (filled > 0) {
        this._arc.arc(cx, cy, r, start, start + filled).stroke({ color: bar.leftColor,  width: this._arcWidth, cap: "butt" });
      }
      if (remain > 0) {
        this._arc.arc(cx, cy, r, start + filled, start + sweep).stroke({ color: bar.rightColor, width: this._arcWidth, cap: "butt" });
      }
    } else {
      if (filled > 0) {
        this._arc.arc(cx, cy, r, start + sweep - filled, start + sweep).stroke({ color: bar.leftColor, width: this._arcWidth, cap: "butt" });
      }
      if (remain > 0) {
        this._arc.arc(cx, cy, r, start, start + sweep - filled).stroke({ color: bar.rightColor, width: this._arcWidth, cap: "butt" });
      }
    }
  }

  // ─── Death animation ─────────────────────────────────────────────────────

  private _redrawDeath(card: ClientCard): void {
    if (this._deathStartTime === null) {
      this._deathStartTime = Date.now();
      const pm = ParticleManager.getInstance();
      if (pm) {
        const def        = getDefinitionByPacked(card.packed_definition);
        const hexColor   = parseColor(def?.style?.color?.[0]) ?? DEFAULT_HEX_COLOR;
        const startColor = hexColor.toString(16).padStart(6, "0");
        this._particleHandle = pm.createEmitter(this._particleContainer, "burn_up", { startColor });
      }
    }

    const t = Math.min(2, (Date.now() - this._deathStartTime) / DEATH_FADE_MS);
    this._animateDeath(t);

    if (t < 2) {
      this.invalidateRender();
    } else {
      DeathCoordinator.notifyAnimationComplete(this._card_id);
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
}
