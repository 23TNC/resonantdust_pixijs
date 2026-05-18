import { Graphics, Text } from "pixi.js";
import { LayoutNode } from "../layout/LayoutNode";
import type { GameContext } from "../../GameContext";
import type { CardDefinition } from "../definitions/DefinitionManager";
import { NOTO_EMOJI_FAMILY } from "../../assets/fonts";
import localeRaw from "../../content/locales/cards/en.json";

// ── Locale lookup ─────────────────────────────────────────────────────────────
type LocaleEntry = { label?: string; description?: { simple?: string } };

function buildLocaleMap(): Map<string, LocaleEntry> {
  const map = new Map<string, LocaleEntry>();
  for (const cards of Object.values(localeRaw as Record<string, unknown>)) {
    if (typeof cards !== "object" || !cards) continue;
    for (const [key, entry] of Object.entries(cards as Record<string, unknown>)) {
      if (typeof entry === "object" && entry) map.set(key, entry as LocaleEntry);
    }
  }
  return map;
}

const LOCALE = buildLocaleMap();

/// Neutral grey fallback when an aspect has no color (shouldn't
/// happen — the registry enforces a color on every aspect — but kept
/// as a defensive value so a stale aspectInfo lookup doesn't render
/// black).
const FALLBACK_PIP_COLOR = 0x556677;

// ── Per-pip display data ───────────────────────────────────────────────────────
interface PipData {
  aspectId: number;
  value: number;
  icon: string;
  /** Background fill colour from `AspectInfo.color`. Sub-aspects
   *  inherit their parent's colour via the registry, so an entire
   *  family renders with one hue without per-leaf wiring here. */
  color: number;
}

// ── Layout constants ──────────────────────────────────────────────────────────
const WIDTH           = 320;
const PADDING         = 8;

const NAME_FONT_SIZE  = 13;
const NAME_Y          = 8;
const NAME_H          = NAME_FONT_SIZE + 6;   // single-line name area

const PIP_SIZE        = 44;
const PIP_GAP         = 6;
const PIP_SLOT        = PIP_SIZE + PIP_GAP;
const PIP_ICON_FONT   = 20;
const PIP_VALUE_FONT  = 9;

const PIPS_Y          = NAME_Y + NAME_H + 6;  // top of the single pip row

const TOGGLE_H        = 20;
const COMPACT_HEIGHT  = PIPS_Y + PIP_SIZE + 6 + TOGGLE_H;
const COMPACT_BODY_BOTTOM = COMPACT_HEIGHT - TOGGLE_H;

const DESC_HEADER_Y   = COMPACT_BODY_BOTTOM + 8;
const DESC_HEADER_H   = 14;
const DESC_Y          = DESC_HEADER_Y + DESC_HEADER_H + 4;
const DESC_FONT       = 12;
const DESC_LINE_H     = 17;
const EXPANDED_HEIGHT = 270;
const EXPANDED_BODY_BOTTOM = EXPANDED_HEIGHT - TOGGLE_H;

const MAX_PIPS        = 20;

// ── ToggleButton ──────────────────────────────────────────────────────────────
class ToggleButton extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly chevron: Text;
  private _expanded = false;

  constructor() {
    super();
    this.container.addChild(this.bg);
    this.chevron = new Text({
      text: "▼",
      style: { fill: 0xaab5c4, fontFamily: "sans-serif", fontSize: 11 },
    });
    this.chevron.anchor.set(0.5, 0.5);
    this.container.addChild(this.chevron);
  }

  setExpanded(v: boolean): void {
    if (this._expanded === v) return;
    this._expanded = v;
    this.invalidate();
  }

  protected override layout(): void {
    this.bg.clear();
    this.bg.rect(0, 0, this.width, this.height).fill({ color: 0x12161b });
    this.chevron.text = this._expanded ? "▲" : "▼";
    this.chevron.position.set(this.width / 2, this.height / 2);
  }
}

// ── DetailsPanel ──────────────────────────────────────────────────────────────
interface Pip {
  gfx: Graphics;
  iconText: Text;
  valueText: Text;
}

/**
 * Details panel. Sits to the left of the inventory and shows information
 * about the last-clicked card.
 *
 * Compact mode: card name + aspect pips (single horizontal row, NotoEmoji
 * icons centred, value at bottom-right of each square).
 * Expanded mode: same header + full text description.
 */
export class DetailsPanel extends LayoutNode {
  static readonly WIDTH           = WIDTH;
  static readonly COMPACT_HEIGHT  = COMPACT_HEIGHT;
  static readonly EXPANDED_HEIGHT = EXPANDED_HEIGHT;

  private _isVisible = false;
  private _expanded  = false;

  private cardName    = "";
  private def: CardDefinition | null = null;
  private description = "";
  private pipData: PipData[] = [];

  private readonly bg              = new Graphics();
  private readonly nameText:       Text;
  private readonly pips:           Pip[];
  private readonly dividerGfx      = new Graphics();
  private readonly descHeaderText: Text;
  private readonly descText:       Text;
  readonly toggleButton: ToggleButton;

  get currentHeight(): number {
    if (!this._isVisible) return 0;
    return this._expanded ? EXPANDED_HEIGHT : COMPACT_HEIGHT;
  }

  get isVisible(): boolean { return this._isVisible; }

  constructor() {
    super();
    this.container.visible = false;
    this.container.addChild(this.bg);

    this.nameText = new Text({
      text: "",
      style: {
        fill: 0xecd6aa,
        fontFamily: "sans-serif",
        fontSize: NAME_FONT_SIZE,
        fontWeight: "700",
        wordWrap: true,
        wordWrapWidth: WIDTH - PADDING * 2,
      },
    });
    this.nameText.anchor.set(0, 0);
    this.container.addChild(this.nameText);

    // Pip pool — one row of squares, each with a centred emoji and a
    // small value number at the bottom-right corner.
    this.pips = Array.from({ length: MAX_PIPS }, (): Pip => {
      const gfx = new Graphics();
      gfx.visible = false;

      const iconText = new Text({
        text: "",
        style: {
          fill: 0xffffff,
          fontFamily: NOTO_EMOJI_FAMILY,
          fontSize: PIP_ICON_FONT,
        },
      });
      iconText.anchor.set(0.5, 0.5);
      iconText.visible = false;

      const valueText = new Text({
        text: "",
        style: {
          fill: 0xffffff,
          fontFamily: "sans-serif",
          fontSize: PIP_VALUE_FONT,
          fontWeight: "700",
        },
      });
      valueText.anchor.set(1, 1);
      valueText.visible = false;

      this.container.addChild(gfx);
      this.container.addChild(iconText);
      this.container.addChild(valueText);
      return { gfx, iconText, valueText };
    });

    this.container.addChild(this.dividerGfx);

    this.descHeaderText = new Text({
      text: "Description",
      style: {
        fill: 0x778899,
        fontFamily: "sans-serif",
        fontSize: 10,
        fontStyle: "italic",
      },
    });
    this.descHeaderText.anchor.set(0, 0);
    this.container.addChild(this.descHeaderText);

    this.descText = new Text({
      text: "",
      style: {
        fill: 0xc0c8d8,
        fontFamily: "sans-serif",
        fontSize: DESC_FONT,
        lineHeight: DESC_LINE_H,
        wordWrap: true,
        wordWrapWidth: WIDTH - PADDING * 2,
      },
    });
    this.descText.anchor.set(0, 0);
    this.container.addChild(this.descText);

    this.toggleButton = new ToggleButton();
    this.addChild(this.toggleButton);
  }

  show(cardId: number, ctx: GameContext): void {
    const row = ctx.data.cardsLocal.get(cardId);
    if (!row) return;

    this.def      = ctx.definitions.decode(row.packedDefinition);
    this.cardName = ctx.definitions.label(row.packedDefinition);

    const locEntry = this.def ? LOCALE.get(this.def.key) : undefined;
    this.description = locEntry?.description?.simple ?? "";

    this.pipData = (this.def?.aspects ?? []).map(([aspectId, value]) => {
      const info = ctx.definitions.aspectInfo(aspectId);
      return {
        aspectId,
        value,
        icon:  info?.icon  ?? "?",
        color: info?.color ?? FALLBACK_PIP_COLOR,
      };
    });

    this._isVisible = true;
    this.container.visible = true;
    this.parent?.invalidate();
    this.invalidate();
  }

  hide(): void {
    if (!this._isVisible) return;
    this._isVisible = false;
    this.container.visible = false;
    this.parent?.invalidate();
  }

  handleClick(hit: LayoutNode | null): boolean {
    if (!this._isVisible) return false;
    if (hit === this.toggleButton) {
      this._expanded = !this._expanded;
      this.toggleButton.setExpanded(this._expanded);
      this.parent?.invalidate();
      this.invalidate();
      return true;
    }
    let node: LayoutNode | null = hit;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }

  protected override layout(): void {
    if (!this._isVisible) return;

    const h = this._expanded ? EXPANDED_HEIGHT : COMPACT_HEIGHT;

    this.bg.clear();
    this.bg.rect(0, 0, WIDTH, h).fill({ color: 0x1a1f24 });
    this.bg.rect(WIDTH - 1, 0, 1, h).fill({ color: 0x2a2f36 });

    // ── Card name ─────────────────────────────────────────────────────
    this.nameText.text = this.cardName;
    this.nameText.position.set(PADDING, NAME_Y);

    // ── Aspect pips — single left-to-right row ────────────────────────
    const count = Math.min(this.pipData.length, MAX_PIPS);

    for (let i = 0; i < MAX_PIPS; i++) {
      const { gfx, iconText, valueText } = this.pips[i];
      if (i >= count) {
        gfx.visible       = false;
        iconText.visible  = false;
        valueText.visible = false;
        continue;
      }
      const { value, icon, color } = this.pipData[i];
      const x = PADDING + i * PIP_SLOT;
      const y = PIPS_Y;

      gfx.clear();
      gfx.rect(x, y, PIP_SIZE, PIP_SIZE).fill({ color });
      gfx.rect(x, y, PIP_SIZE, PIP_SIZE).stroke({ color: 0xffffff, width: 0.5, alpha: 0.2 });
      gfx.visible = true;

      iconText.text = icon;
      iconText.position.set(x + PIP_SIZE / 2, y + PIP_SIZE / 2);
      iconText.visible = true;

      valueText.text = String(value);
      valueText.position.set(x + PIP_SIZE - 2, y + PIP_SIZE - 2);
      valueText.visible = true;
    }

    // ── Divider (expanded only) ───────────────────────────────────────
    this.dividerGfx.clear();
    if (this._expanded) {
      this.dividerGfx
        .rect(PADDING, COMPACT_BODY_BOTTOM, WIDTH - PADDING * 2, 1)
        .fill({ color: 0x2a2f36 });
    }

    // ── Description (expanded only) ───────────────────────────────────
    const showDesc = this._expanded;
    this.descHeaderText.visible = showDesc;
    this.descText.visible       = showDesc;
    if (showDesc) {
      this.descHeaderText.position.set(PADDING, DESC_HEADER_Y);
      this.descText.text = this.description.length > 0
        ? this.description
        : "No description available.";
      this.descText.position.set(PADDING, DESC_Y);
      void (EXPANDED_BODY_BOTTOM - DESC_Y); // available height for future clamp
    }

    // ── Toggle button ─────────────────────────────────────────────────
    const toggleY = h - TOGGLE_H;
    this.toggleButton.setBounds(0, toggleY, WIDTH, TOGGLE_H);
    this.toggleButton.layoutIfDirty();
  }
}
