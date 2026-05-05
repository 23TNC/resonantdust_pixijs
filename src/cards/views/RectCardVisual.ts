import { Container, Graphics, Text } from "pixi.js";
import type { CardDefinition } from "../../definitions/DefinitionManager";
import {
  RECT_CARD_HEIGHT,
  RECT_CARD_TITLE_HEIGHT,
  RECT_CARD_WIDTH,
  type RectCardTitlePosition,
} from "./RectangleCard";

const FALLBACK_STYLE = ["#3a3a4a", "#7a7a8a", "#0b1426"] as const;
const FALLBACK_NAME  = "?";

/**
 * Lightweight reusable rect-card visual: body fill, title bar, outline stroke,
 * and name label. No progress bar, no state overlay, no death effect — those
 * are the caller's responsibility.
 *
 * Width = RECT_CARD_WIDTH, Height = RECT_CARD_HEIGHT. Origin is the top-left
 * corner of the bounding box.
 */
export class RectCardVisual extends Container {
  private readonly bg = new Graphics();
  private readonly cardOutline = new Graphics();
  readonly nameText: Text;

  constructor() {
    super();
    this.nameText = new Text({
      text: FALLBACK_NAME,
      style: {
        fill: FALLBACK_STYLE[2],
        fontFamily: "Segoe UI",
        fontSize: Math.max(8, Math.floor(RECT_CARD_TITLE_HEIGHT * 0.55)),
        fontWeight: "700",
        align: "center",
        wordWrap: true,
        wordWrapWidth: RECT_CARD_WIDTH - 4,
      },
    });
    this.nameText.anchor.set(0.5);
    this.addChild(this.bg);
    this.addChild(this.nameText);
    this.addChild(this.cardOutline);
  }

  draw(
    definition: CardDefinition | null,
    titlePosition: RectCardTitlePosition = "top",
  ): void {
    const style = definition?.style ?? FALLBACK_STYLE;
    const [primary, secondary, outline] = style;
    const w = RECT_CARD_WIDTH;
    const h = RECT_CARD_HEIGHT;
    const titleY = titlePosition === "top" ? 0 : h - RECT_CARD_TITLE_HEIGHT;

    this.bg.clear();
    this.bg.rect(0, 0, w, h).fill({ color: primary });
    this.bg.rect(0, titleY, w, RECT_CARD_TITLE_HEIGHT).fill({ color: secondary });

    this.nameText.text = definition?.name ?? FALLBACK_NAME;
    this.nameText.style.fill = definition?.style[2] ?? FALLBACK_STYLE[2];
    this.nameText.position.set(w / 2, titleY + RECT_CARD_TITLE_HEIGHT / 2);

    this.cardOutline.clear();
    this.cardOutline.rect(0, 0, w, h).stroke({ color: outline, width: 2 });
  }
}
