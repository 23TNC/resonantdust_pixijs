import { Text } from "pixi.js";
import {
  RECT_CARD_TITLE_HEIGHT,
  RECT_CARD_WIDTH,
  type RectCardTitlePosition,
} from "./RectCard";

/**
 * Magnetic-anchor indicator — a 🧲 emoji anchored at the top-right of
 * the card body. Shown when the row's `magnetic` flag (bit 12,
 * registry name in `content/cards/flags.json`) is set; positions
 * itself relative to `titlePosition` so the badge sits just below
 * the title bar regardless of chain direction.
 *
 * Host (`LayoutRectCard`) calls `update(visible, titlePosition)`
 * each layout pass with the flag-derived visibility and current
 * title position. The badge handles its own visibility + positioning
 * — the host just parents `text` once at construction.
 *
 * `RECT_CARD_*` constants are read lazily inside `update()` (not at
 * module top-level) so this file is safe under the
 * `RectCard` ↔ badge import cycle.
 */
export class MagneticBadge {
  readonly text: Text;

  constructor() {
    this.text = new Text({
      text: "🧲",
      style: { fontSize: 14 },
    });
    this.text.anchor.set(1, 0);
    this.text.visible = false;
  }

  /** Set visibility + position. Reads `RECT_CARD_WIDTH` /
   *  `RECT_CARD_TITLE_HEIGHT` from `RectCard` at call time — safe
   *  under the module-load cycle since they're not accessed at
   *  module top-level. */
  update(visible: boolean, titlePosition: RectCardTitlePosition): void {
    this.text.visible = visible;
    if (!visible) return;
    // Top-right of the card *body*: just below the title bar when
    // title is on top, just below the top edge when title is on
    // bottom. Avoids overlapping the title bar / progress bars
    // regardless of chain direction.
    const bodyTopY = titlePosition === "top" ? RECT_CARD_TITLE_HEIGHT : 0;
    this.text.position.set(RECT_CARD_WIDTH - 2, bodyTopY + 2);
  }
}
