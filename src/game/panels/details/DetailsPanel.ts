import { Graphics, Text } from "pixi.js";
import { LayoutNode } from "../../layout/LayoutNode";
import type { GameContext } from "../../../GameContext";
import type { CardDefinition } from "../../definitions/DefinitionManager";
import { NOTO_EMOJI_FAMILY } from "../../../assets/fonts";
import { microLooseCell } from "../../../server/data/packing";
import localeRaw from "../../../content/locales/cards/en.json";
import { panelText } from "../panelStrings";

/** Surface threshold above which a card's `(macro_zone, micro_zone)`
 *  resolves to a world hex worth showing. Inventory (`1`) is below the
 *  cutoff and has no world position; world (`64+`) is above it. */
const WORLD_SURFACE_THRESHOLD = 31;

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

// One pip's display intent — which category bucket it should land in.
// Trait-category entries are filtered out at build time and never
// reach this stage.
type PipCategory = "aspect" | "feature";

// ── Layout constants ──────────────────────────────────────────────────────────
const WIDTH           = 320;
const PADDING         = 8;

const NAME_FONT_SIZE  = 13;
const NAME_Y          = 8;
const NAME_H          = NAME_FONT_SIZE + 6;   // single-line name area

/** Optional world-coord subtitle below the name. Reserved
 *  unconditionally so the rest of the layout (pip row, compact
 *  height) stays stable whether or not the panel was opened with
 *  coords. The text node is hidden when `coords === null`. */
const COORDS_FONT_SIZE = 10;
const COORDS_Y         = NAME_Y + NAME_H;
const COORDS_H         = COORDS_FONT_SIZE + 4;

const PIP_SIZE        = 44;
const PIP_GAP         = 6;
const PIP_SLOT        = PIP_SIZE + PIP_GAP;
const PIP_ICON_FONT   = 20;
const PIP_VALUE_FONT  = 9;

const PIPS_Y          = COORDS_Y + COORDS_H + 6;  // top of the single pip row

const TOGGLE_H        = 20;
const COMPACT_HEIGHT  = PIPS_Y + PIP_SIZE + 6 + TOGGLE_H;
const COMPACT_BODY_BOTTOM = COMPACT_HEIGHT - TOGGLE_H;

// Feature-category pips render in their own smaller row above the
// description, expanded-only. Smaller so they read as secondary
// information.
const FEATURE_PIP_SIZE   = 28;
const FEATURE_PIP_GAP    = 4;
const FEATURE_PIP_SLOT   = FEATURE_PIP_SIZE + FEATURE_PIP_GAP;
const FEATURE_PIP_ICON_FONT  = 14;
const FEATURE_PIP_VALUE_FONT = 8;
const FEATURE_PIPS_Y     = COMPACT_BODY_BOTTOM + 6;
const FEATURE_ROW_HEIGHT = FEATURE_PIP_SIZE + 6;

const DESC_HEADER_Y   = FEATURE_PIPS_Y + FEATURE_ROW_HEIGHT + 4;
const DESC_HEADER_H   = 14;
const DESC_Y          = DESC_HEADER_Y + DESC_HEADER_H + 4;
const DESC_FONT       = 12;
const DESC_LINE_H     = 17;
const EXPANDED_HEIGHT = 310;
const EXPANDED_BODY_BOTTOM = EXPANDED_HEIGHT - TOGGLE_H;

const MAX_PIPS         = 20;
const MAX_FEATURE_PIPS = 10;

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

  /** Subscribers fired on every `_isVisible` flip. `MainLayout`'s
   *  `detailsHostPanel` (the PixiPanel wrapper) listens so the host
   *  opens / closes in lockstep with `show()` / `hide()` calls.
   *  Anyone else that cares about the panel's visibility (a future
   *  selection-state mirror, etc.) can subscribe too. */
  private readonly visibilityListeners = new Set<(visible: boolean) => void>();
  /** Subscribers fired whenever `currentHeight` changes — that's
   *  visibility flips (0 ↔ COMPACT_HEIGHT) AND expand toggles
   *  (COMPACT_HEIGHT ↔ EXPANDED_HEIGHT). The PixiPanel wrapper
   *  in `MainLayout` uses this to drive its `"auto"` heightMode:
   *  push `currentHeight` into `setContentNaturalHeight(...)` and
   *  the host outer panel resizes to wrap the content. */
  private readonly sizeChangeListeners = new Set<(height: number) => void>();

  private cardName    = "";
  private def: CardDefinition | null = null;
  private description = "";
  private pipData: PipData[] = [];
  /** Same shape as `pipData` but for feature-category entries —
   *  rendered in a smaller second row, expanded-only. */
  private featurePipData: PipData[] = [];
  /** World hex (q, r) for cards / tiles on a surface above
   *  `WORLD_SURFACE_THRESHOLD`. `null` for inventory cards and any
   *  call site that didn't supply a position. Rendered as a small
   *  subtitle under the card name. */
  private coords: { q: number; r: number } | null = null;

  private readonly bg              = new Graphics();
  private readonly nameText:       Text;
  private readonly coordsText:     Text;
  private readonly pips:           Pip[];
  private readonly featurePips:    Pip[];
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

    this.coordsText = new Text({
      text: "",
      style: {
        fill: 0x778899,
        fontFamily: "sans-serif",
        fontSize: COORDS_FONT_SIZE,
        fontStyle: "italic",
      },
    });
    this.coordsText.anchor.set(0, 0);
    this.coordsText.visible = false;
    this.container.addChild(this.coordsText);

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

    // Feature pip pool — smaller squares, rendered in their own row
    // below the divider, expanded-only.
    this.featurePips = Array.from({ length: MAX_FEATURE_PIPS }, (): Pip => {
      const gfx = new Graphics();
      gfx.visible = false;

      const iconText = new Text({
        text: "",
        style: {
          fill: 0xffffff,
          fontFamily: NOTO_EMOJI_FAMILY,
          fontSize: FEATURE_PIP_ICON_FONT,
        },
      });
      iconText.anchor.set(0.5, 0.5);
      iconText.visible = false;

      const valueText = new Text({
        text: "",
        style: {
          fill: 0xffffff,
          fontFamily: "sans-serif",
          fontSize: FEATURE_PIP_VALUE_FONT,
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
      text: panelText("gameDetailsPanel", "descriptionHeader"),
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

  /** Open the panel for a card instance — looks up the row in
   *  `cardsLocal` to grab its `packedDefinition`, then delegates to
   *  [`showByPackedDefinition`]. No-op when the row isn't in the
   *  local mirror.
   *
   *  Tile-cards (promoted zone tiles, `card_type == 7`) carry their
   *  current stocks in `flags_bk.tile_stock_{0,1}` — surfaced as
   *  `stockValues` so stock-bound aspect pips reflect post-action
   *  mutations (e.g. wood decremented after cut_tree). Non-tile
   *  cards have empty `def.stock` so passing `undefined` here keeps
   *  their pip rendering unchanged. See `docs/TILE_AS_CARD.md`. */
  show(cardId: number, ctx: GameContext): void {
    const row = ctx.data.cardsLocal.get(cardId);
    if (!row) return;
    const cardType = (row.packedDefinition >> 12) & 0xf;
    const stockValues =
      cardType === 7
        ? [
            ctx.definitions.cardFlagFieldValueIn("cards_bk", row.flagsBk, "tile_stock_0") ?? 0,
            ctx.definitions.cardFlagFieldValueIn("cards_bk", row.flagsBk, "tile_stock_1") ?? 0,
          ]
        : undefined;
    // World hex from `(macro_zone, micro_zone)` for any card above
    // the surface threshold. `unpackMacroZone` returns the world
    // origin of the chunk; `unpackMicroZone` returns the in-chunk
    // offset. For inventory / out-of-world cards the row's
    // micro_zone packs different bits (loose xy, parent pointers),
    // so the threshold gate keeps the panel quiet for those.
    let worldHex: { q: number; r: number } | null = null;
    if (row.macroZone.surface > WORLD_SURFACE_THRESHOLD) {
      const { localQ, localR } = microLooseCell(row.microLocation);
      worldHex = { q: row.macroZone.zoneQ + localQ, r: row.macroZone.zoneR + localR };
    }
    this.showByPackedDefinition(row.packedDefinition, ctx, stockValues, worldHex);
  }

  /** Open the panel for a `packedDefinition` directly. Used by the
   *  world-tile click path — the tile has no card row, just a def in
   *  the zone's packed tile data. The panel's body (name, aspects,
   *  description) only depends on the def, so the from-row and
   *  from-packed entry points share this implementation.
   *
   *  `stockValues` carries the current per-slot stock counters
   *  (indexed by `def.stock` slot order — `stockValues[0]` ↔
   *  `def.stock[0]`). When provided, stock-derived pips display the
   *  current value and are omitted entirely for slots whose current
   *  count is 0. When absent, no stock pips are shown — non-tile
   *  defs have empty `stock` so this only affects tiles. */
  showByPackedDefinition(
    packedDefinition: number,
    ctx: GameContext,
    stockValues?: readonly number[],
    worldHex?: { q: number; r: number } | null,
  ): void {
    this.def      = ctx.definitions.decode(packedDefinition);
    this.cardName = ctx.definitions.label(packedDefinition);
    this.coords   = worldHex ?? null;

    const locEntry = this.def ? LOCALE.get(this.def.key) : undefined;
    this.description = locEntry?.description?.simple ?? "";

    // Static aspects + stock-slot aspects. Stock pips show the
    // current per-slot count (from `stockValues`) and are omitted
    // when that count is 0. Dedupe by aspectId first-wins so a def
    // that still declares both renders once.
    //
    // Categories: aspects render in the main pip row (always);
    // features in their own smaller row (expanded only); traits are
    // sim-only and skipped entirely.
    const aspectPips: PipData[] = [];
    const featurePips: PipData[] = [];
    const seen = new Set<number>();
    const push = (aspectId: number, value: number): void => {
      if (seen.has(aspectId)) return;
      seen.add(aspectId);
      const info = ctx.definitions.aspectInfo(aspectId);
      if (!info) return;
      if (info.category === "trait") return;
      const pip: PipData = {
        aspectId,
        value,
        icon:  info.icon  || "?",
        color: info.color || FALLBACK_PIP_COLOR,
      };
      (info.category === "feature" ? featurePips : aspectPips).push(pip);
    };
    for (const [aspectId, value] of this.def?.aspects ?? []) push(aspectId, value);
    if (stockValues) {
      const slots = this.def?.stock ?? [];
      for (let i = 0; i < slots.length; i++) {
        const current = stockValues[i] ?? 0;
        if (current === 0) continue;
        push(slots[i].aspectId, current);
      }
    }
    this.pipData = aspectPips;
    this.featurePipData = featurePips;

    this.setVisible(true);
    this.parent?.invalidate();
    this.invalidate();
  }

  hide(): void {
    if (!this._isVisible) return;
    this.setVisible(false);
    this.parent?.invalidate();
  }

  /** Internal helper that flips `_isVisible` + the Pixi container's
   *  visibility AND notifies subscribers. Folded out so `show()` /
   *  `hide()` can share the listener-fire path. Also fires the
   *  size-change listeners since `currentHeight` jumps to / from 0
   *  on every visibility flip. */
  private setVisible(visible: boolean): void {
    if (this._isVisible === visible) return;
    this._isVisible = visible;
    this.container.visible = visible;
    for (const cb of this.visibilityListeners) {
      try { cb(visible); }
      catch (err) { console.error("[DetailsPanel] visibility listener threw", err); }
    }
    this.fireSizeChange();
  }

  /** Fire `sizeChangeListeners` with the current natural height.
   *  Called from `setVisible` and from the expand toggle in
   *  `handleClick`. */
  private fireSizeChange(): void {
    const h = this.currentHeight;
    for (const cb of this.sizeChangeListeners) {
      try { cb(h); }
      catch (err) { console.error("[DetailsPanel] size-change listener threw", err); }
    }
  }

  /** Subscribe to visibility flips. Fires synchronously on every
   *  `show()` / `hide()`. Returns an unsubscribe fn. */
  onVisibilityChange(cb: (visible: boolean) => void): () => void {
    this.visibilityListeners.add(cb);
    return () => this.visibilityListeners.delete(cb);
  }

  /** Subscribe to `currentHeight` changes — visibility flips +
   *  compact / expanded toggles. Returns an unsubscribe fn. */
  onSizeChange(cb: (height: number) => void): () => void {
    this.sizeChangeListeners.add(cb);
    return () => this.sizeChangeListeners.delete(cb);
  }

  handleClick(hit: LayoutNode | null): boolean {
    if (!this._isVisible) return false;
    if (hit === this.toggleButton) {
      this._expanded = !this._expanded;
      this.toggleButton.setExpanded(this._expanded);
      this.parent?.invalidate();
      this.invalidate();
      // `currentHeight` jumped between COMPACT and EXPANDED — let
      // anyone tracking natural height (e.g. the host PixiPanel in
      // `"auto"` mode) resize accordingly.
      this.fireSizeChange();
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

    // ── World coords (cards / tiles above surface threshold) ──────────
    if (this.coords !== null) {
      this.coordsText.text = `world (${this.coords.q}, ${this.coords.r})`;
      this.coordsText.position.set(PADDING, COORDS_Y);
      this.coordsText.visible = true;
    } else {
      this.coordsText.visible = false;
    }

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

    // ── Feature pips — expanded-only secondary row ────────────────────
    const featureCount = this._expanded
      ? Math.min(this.featurePipData.length, MAX_FEATURE_PIPS)
      : 0;
    for (let i = 0; i < MAX_FEATURE_PIPS; i++) {
      const { gfx, iconText, valueText } = this.featurePips[i];
      if (i >= featureCount) {
        gfx.visible       = false;
        iconText.visible  = false;
        valueText.visible = false;
        continue;
      }
      const { value, icon, color } = this.featurePipData[i];
      const x = PADDING + i * FEATURE_PIP_SLOT;
      const y = FEATURE_PIPS_Y;

      gfx.clear();
      gfx.rect(x, y, FEATURE_PIP_SIZE, FEATURE_PIP_SIZE).fill({ color });
      gfx.rect(x, y, FEATURE_PIP_SIZE, FEATURE_PIP_SIZE)
        .stroke({ color: 0xffffff, width: 0.5, alpha: 0.2 });
      gfx.visible = true;

      iconText.text = icon;
      iconText.position.set(x + FEATURE_PIP_SIZE / 2, y + FEATURE_PIP_SIZE / 2);
      iconText.visible = true;

      // Hide the value badge when it's the trivial "1" — most
      // feature entries are presence markers (`inventory: 1`,
      // `faction.chorus: 1`); the visible icon already conveys "carried".
      if (value === 1) {
        valueText.visible = false;
      } else {
        valueText.text = String(value);
        valueText.position.set(
          x + FEATURE_PIP_SIZE - 2,
          y + FEATURE_PIP_SIZE - 2,
        );
        valueText.visible = true;
      }
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
