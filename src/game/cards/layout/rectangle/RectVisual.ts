import { Container, Graphics, Text } from "pixi.js";
import type { CardDefinition } from "../../../definitions/DefinitionManager";
import {
  RECT_CARD_HEIGHT,
  RECT_CARD_TITLE_HEIGHT,
  RECT_CARD_WIDTH,
  type RectCardTitlePosition,
} from "./RectCard";

const FALLBACK_STYLE = ["#3a3a4a", "#7a7a8a", "#0b1426"] as const;
const FALLBACK_NAME  = "?";

/**
 * Lightweight reusable rect-card *body*: body fill, title-bar fill,
 * outline, and name label. No art / portrait — those layer on top
 * at display time, sourced per-instance via
 * `CardTextureManager.getCardArt` so a future bake (which doesn't
 * exist today but `getRect` is wired for one) would stay keyed
 * purely on the def. See [docs/AGENTS.md] in `assets/textures/` for
 * the two-tier card-texture cache rationale.
 *
 * Width = RECT_CARD_WIDTH, Height = RECT_CARD_HEIGHT. Origin is the
 * top-left corner of the bounding box.
 *
 * Children are kept as **separate** Graphics so the caller
 * (`LayoutRectCard`) can re-parent the body fill below the
 * in-front-objects overlay while keeping the title-bar fill,
 * outline, and label above it — preserves readability when nearby
 * trees / rocks would otherwise occlude the card's identifying
 * elements.
 */
export class RectCardVisual extends Container {
  /** Card body rectangle. Owned by this visual; sits at the bottom
   *  of the z-order so per-instance art and the in-front-objects
   *  overlay can layer on top. */
  private readonly body = new Graphics();
  /** Title-bar rectangle. Public so `LayoutRectCard` can re-parent
   *  it above the in-front-objects overlay alongside the label /
   *  outline / progress bars — the title is the card's primary
   *  identifier and should stay readable through the overlay. */
  readonly titleBar  = new Graphics();
  readonly cardOutline = new Graphics();
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
    this.addChild(this.body);
    this.addChild(this.titleBar);
    this.addChild(this.nameText);
    this.addChild(this.cardOutline);
  }

  draw(
    definition: CardDefinition | null,
    titlePosition: RectCardTitlePosition = "top",
    label?: string,
  ): void {
    // style[0] = background fill, style[1] = title bar fill, style[2] = text
    // (and outline). FALLBACK_STYLE follows the same ordering.
    const [background, titleBar, textColor] = definition?.style ?? FALLBACK_STYLE;
    const name = label ?? definition?.key ?? FALLBACK_NAME;
    const w = RECT_CARD_WIDTH;
    const h = RECT_CARD_HEIGHT;
    const titleY = titlePosition === "top" ? 0 : h - RECT_CARD_TITLE_HEIGHT;

    this.body.clear();
    this.body.rect(0, 0, w, h).fill({ color: background });

    this.titleBar.clear();
    this.titleBar.rect(0, titleY, w, RECT_CARD_TITLE_HEIGHT).fill({ color: titleBar });

    this.nameText.text = name;
    this.nameText.style.fill = textColor;
    this.nameText.position.set(w / 2, titleY + RECT_CARD_TITLE_HEIGHT / 2);

    this.cardOutline.clear();
    this.cardOutline.rect(0, 0, w, h).stroke({ color: textColor, width: 2 });
  }
}
