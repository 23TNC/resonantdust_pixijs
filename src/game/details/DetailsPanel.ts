import { Graphics, Text } from "pixi.js";
import { LayoutNode } from "../layout/LayoutNode";
import type { GameContext } from "../../GameContext";
import type { CardDefinition } from "../definitions/DefinitionManager";
import type { AspectInfo } from "../definitions/DefinitionManager";
import localeRaw from "../../content/locales/cards/en.json";

// ── Locale lookup ─────────────────────────────────────────────────────────────
type LocaleEntry = { label?: string; description?: { simple?: string } };

function buildLocaleMap(): Map<string, LocaleEntry> {
  const map = new Map<string, LocaleEntry>();
  for (const sub of Object.values(localeRaw as Record<string, unknown>)) {
    if (typeof sub !== "object" || !sub) continue;
    for (const cards of Object.values(sub as Record<string, unknown>)) {
      if (typeof cards !== "object" || !cards) continue;
      for (const [key, entry] of Object.entries(cards as Record<string, unknown>)) {
        if (typeof entry === "object" && entry) map.set(key, entry as LocaleEntry);
      }
    }
  }
  return map;
}

const LOCALE = buildLocaleMap();

// ── Aspect color tables (visual-only, not in aspects.json) ───────────────────
const CATEGORY_COLOR: Record<string, number> = {
  resources:  0x8B6014,
  elements:   0x1E6B9E,
  alignment:  0x7722AA,
  faculties:  0x227788,
  dimensions: 0x4455AA,
  activities: 0xAA7722,
  states:     0x556677,
};

const ELEMENT_OVERRIDE: Record<number, number> = {
  6:  0x556B2F, // earth
  7:  0x1E6B9E, // water
  8:  0xCC3311, // fire
  9:  0x33AAAA, // wind
  10: 0xCCAA22, // light
  11: 0x553377, // dark
};

function aspectColor(id: number, group: string): number {
  if (id in ELEMENT_OVERRIDE) return ELEMENT_OVERRIDE[id];
  return CATEGORY_COLOR[group] ?? 0x556677;
}

// ── Per-pip display data (populated in show(), consumed in layout()) ──────────
interface PipData { aspectId: number; value: number; icon: string; group: string }

// ── Layout constants ──────────────────────────────────────────────────────────
const WIDTH          = 180;
const COMPACT_HEIGHT = 130;
const EXPANDED_HEIGHT = 280;
const PADDING        = 8;

const HEADER_H       = 16;  // "DETAILS" micro-label
const NAME_FONT_SIZE = 13;
const NAME_H         = NAME_FONT_SIZE * 2 + 2; // allow two lines
const PIPS_Y         = HEADER_H + NAME_H + 8;
const PIP_DIAM       = 18;
const PIP_GAP        = 6;
const PIP_SLOT       = PIP_DIAM + PIP_GAP;
const PIPS_PER_ROW   = 4;
const TOGGLE_H       = 22;
const COMPACT_BODY_BOTTOM = COMPACT_HEIGHT - TOGGLE_H;  // 108

const DESC_HEADER_Y  = COMPACT_BODY_BOTTOM + 8;
const DESC_HEADER_H  = 14;
const DESC_Y         = DESC_HEADER_Y + DESC_HEADER_H + 4;
const DESC_FONT      = 12;
const DESC_LINE_H    = 17;
const EXPANDED_BODY_BOTTOM = EXPANDED_HEIGHT - TOGGLE_H; // 258

const MAX_PIPS       = 20;

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
      style: {
        fill: 0xaab5c4,
        fontFamily: "sans-serif",
        fontSize: 11,
      },
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
    this.bg
      .rect(0, 0, this.width, this.height)
      .fill({ color: 0x12161b });
    this.chevron.text = this._expanded ? "▲" : "▼";
    this.chevron.position.set(this.width / 2, this.height / 2);
  }
}

// ── DetailsPanel ──────────────────────────────────────────────────────────────
interface Pip { gfx: Graphics; label: Text }

/**
 * Left-column details panel. Sits below the ToolBar and shows information
 * about the last-clicked card or world tile.
 *
 * Standard (compact) mode: card name + style color band + aspect pips.
 * Expanded mode: same header + full text description.
 *
 * Call `show(cardId, ctx)` from a click handler to populate and display.
 * Call `hide()` to dismiss. `handleClick(hit)` returns true when the click
 * landed on the panel (including the toggle) so callers can skip dismiss logic.
 */
export class DetailsPanel extends LayoutNode {
  static readonly WIDTH          = WIDTH;
  static readonly COMPACT_HEIGHT = COMPACT_HEIGHT;
  static readonly EXPANDED_HEIGHT = EXPANDED_HEIGHT;

  private _isVisible = false;
  private _expanded  = false;

  // Current display state
  private cardName = "";
  private def: CardDefinition | null = null;
  private description = "";
  private pipData: PipData[] = [];

  // Visuals
  private readonly bg             = new Graphics();
  private readonly headerLabel:   Text;
  private readonly nameText:      Text;
  private readonly pips:          Pip[];
  private readonly dividerGfx     = new Graphics();
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

    this.headerLabel = new Text({
      text: "DETAILS",
      style: {
        fill: 0x556677,
        fontFamily: "sans-serif",
        fontSize: 9,
        letterSpacing: 1,
      },
    });
    this.headerLabel.anchor.set(0, 0.5);
    this.container.addChild(this.headerLabel);

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

    // Pip pool
    this.pips = Array.from({ length: MAX_PIPS }, (): Pip => {
      const gfx = new Graphics();
      gfx.visible = false;
      const label = new Text({
        text: "",
        style: {
          fill: 0xffffff,
          fontFamily: "sans-serif",
          fontSize: 9,
          fontWeight: "700",
        },
      });
      label.anchor.set(0.5, 0.5);
      label.visible = false;
      this.container.addChild(gfx);
      this.container.addChild(label);
      return { gfx, label };
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

    this.def = ctx.definitions.decode(row.packedDefinition);
    this.cardName = ctx.definitions.label(row.packedDefinition);

    const locEntry = this.def ? LOCALE.get(this.def.key) : undefined;
    this.description =
      locEntry?.description?.simple ??
      (this.def ? "" : "");

    this.pipData = (this.def?.aspects ?? []).map(([aspectId, value]) => {
      const info: AspectInfo | null = ctx.definitions.aspectInfo(aspectId);
      return {
        aspectId,
        value,
        icon: info?.icon ?? "?",
        group: info?.group ?? "states",
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

  /**
   * Call from the scene's left_click handler. Returns `true` when the
   * click was inside the panel (consume it — don't hide). Handles the
   * toggle button itself.
   */
  handleClick(hit: LayoutNode | null): boolean {
    if (!this._isVisible) return false;
    if (hit === this.toggleButton) {
      this._expanded = !this._expanded;
      this.toggleButton.setExpanded(this._expanded);
      this.parent?.invalidate();
      this.invalidate();
      return true;
    }
    // Any other hit inside our subtree: keep panel visible.
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
    // Subtle right border to visually separate from world view.
    this.bg.rect(WIDTH - 1, 0, 1, h).fill({ color: 0x2a2f36 });

    // ── Header micro-label ────────────────────────────────────────────
    this.headerLabel.position.set(PADDING, HEADER_H / 2);

    // ── Card name ─────────────────────────────────────────────────────
    this.nameText.text = this.cardName;
    this.nameText.position.set(PADDING, HEADER_H + 2);

    // ── Aspect pips ───────────────────────────────────────────────────
    // In compact, cap at 3 rows (12 pips); in expanded show all.
    const maxPips = this._expanded ? MAX_PIPS : PIPS_PER_ROW * 3;
    const count = Math.min(this.pipData.length, maxPips);

    for (let i = 0; i < MAX_PIPS; i++) {
      const { gfx, label } = this.pips[i];
      if (i >= count) {
        gfx.visible = false;
        label.visible = false;
        continue;
      }
      const { aspectId, value, icon, group } = this.pipData[i];
      const col = i % PIPS_PER_ROW;
      const row = Math.floor(i / PIPS_PER_ROW);
      const cx = PADDING + col * PIP_SLOT + PIP_DIAM / 2;
      const cy = PIPS_Y + row * PIP_SLOT + PIP_DIAM / 2;
      const r = PIP_DIAM / 2;
      const color = aspectColor(aspectId, group);

      gfx.clear();
      gfx.rect(cx - r, cy - r, PIP_DIAM, PIP_DIAM).fill({ color });
      gfx.rect(cx - r, cy - r, PIP_DIAM, PIP_DIAM).stroke({ color: 0xffffff, width: 0.5, alpha: 0.2 });
      gfx.visible = true;

      label.text = `${icon}\n${value}`;
      label.style.fontSize = 9;
      label.position.set(cx, cy);
      label.visible = true;
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
    this.descText.visible = showDesc;
    if (showDesc) {
      this.descHeaderText.position.set(PADDING, DESC_HEADER_Y);
      this.descText.text = this.description.length > 0
        ? this.description
        : "No description available.";
      this.descText.position.set(PADDING, DESC_Y);
      // Clamp description rendering to available height.
      const maxDescH = EXPANDED_BODY_BOTTOM - DESC_Y;
      void maxDescH; // future: could mask or truncate
    }

    // ── Toggle button ─────────────────────────────────────────────────
    const toggleY = (this._expanded ? EXPANDED_HEIGHT : COMPACT_HEIGHT) - TOGGLE_H;
    this.toggleButton.setBounds(0, toggleY, WIDTH, TOGGLE_H);
    this.toggleButton.layoutIfDirty();
  }
}
