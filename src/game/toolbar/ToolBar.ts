import { Graphics, Text } from "pixi.js";
import { LayoutNode } from "../layout/LayoutNode";
import { TitleBar } from "../titlebar/TitleBar";
import { NOTO_EMOJI_FAMILY } from "../../assets/fonts";

const HEIGHT = TitleBar.HEIGHT;
const PADDING = 8;
/** Per-button square slot. Roomy enough for an emoji glyph at
 *  `BUTTON_FONT_SIZE` without crowding the bar's vertical edges. */
const BUTTON_SLOT = HEIGHT - 8;
const BUTTON_SPACING = 4;
const BUTTON_FONT_SIZE = 18;
const BUTTON_FONT_WEIGHT = "400";

/** Hardcoded button glyphs. Add new entries here; `WIDTH` recomputes
 *  automatically. No click handlers wired yet — wire-up is a follow-up
 *  alongside the title bar's settings gear. */
const BUTTON_LABELS = ["💡", "🔧", "☑"] as const;

/** Top-left tool strip rendered directly under the title bar. Width is
 *  derived from the fixed button list — `GameLayout` reads `ToolBar.WIDTH`
 *  to size its bounds. */
export class ToolBar extends LayoutNode {
  static readonly HEIGHT = HEIGHT;
  static readonly WIDTH =
    PADDING * 2 +
    BUTTON_LABELS.length * BUTTON_SLOT +
    Math.max(0, BUTTON_LABELS.length - 1) * BUTTON_SPACING;

  private readonly bg = new Graphics();
  private readonly buttons: Text[];

  constructor() {
    super();
    this.container.addChild(this.bg);
    this.buttons = BUTTON_LABELS.map((label) => {
      const t = new Text({
        text: label,
        style: {
          fill: 0xffffff,
          fontFamily: NOTO_EMOJI_FAMILY,
          fontSize: BUTTON_FONT_SIZE,
          fontWeight: BUTTON_FONT_WEIGHT,
        },
      });
      t.anchor.set(0.5, 0.5);
      this.container.addChild(t);
      return t;
    });
  }

  protected override layout(): void {
    this.bg.clear();
    this.bg.rect(0, 0, this.width, this.height).fill({ color: 0x1a1f24 });

    const cy = this.height / 2;
    let x = PADDING + BUTTON_SLOT / 2;
    for (const t of this.buttons) {
      t.position.set(x, cy);
      x += BUTTON_SLOT + BUTTON_SPACING;
    }
  }
}
