import { Graphics, Text } from "pixi.js";
import type { CardDefinition } from "../definitions/DefinitionManager";
import type { GameContext } from "../GameContext";
import type { Card as CardRow } from "../server/bindings/types";
import {
  decodeLooseXY,
  encodeLooseXY,
  getStackedState,
  STACKED_LOOSE,
  STACKED_ON_RECT_X,
  type LooseXY,
} from "./cardData";
import { GameCard } from "./GameCard";
import { LayoutCard } from "./LayoutCard";

const FALLBACK_STYLE = ["#3a3a4a", "#7a7a8a", "#0b1426"] as const;
const FALLBACK_NAME = "?";

export const RECT_CARD_WIDTH = 72;
export const RECT_CARD_HEIGHT = 96;
export const RECT_CARD_TITLE_HEIGHT = 24;

export type RectCardTitlePosition = "top" | "bottom";

export class GameRectCard extends GameCard {
  private flags = 0;
  private microLocation = 0;

  applyData(row: CardRow): void {
    this.flags = row.flags;
    this.microLocation = row.microLocation;
  }

  isLoose(): boolean {
    return getStackedState(this.flags) === STACKED_LOOSE;
  }

  getLoosePosition(): LooseXY | null {
    if (!this.isLoose()) return null;
    return decodeLooseXY(this.microLocation);
  }

  override whereAreYou(): { x: number; y: number } {
    return this.getLoosePosition() ?? { x: 0, y: 0 };
  }

  /**
   * Write a new loose `(x, y)` into client_cards. Server doesn't see this
   * until a state-changing action triggers a reducer. No-op if the card is
   * not loose (stacked cards track parents, not their own xy).
   */
  setLoosePosition(x: number, y: number): void {
    if (!this.isLoose()) return;
    const row = this.ctx.data.get("cards", this.cardId);
    if (!row) return;
    this.ctx.data.cards.setClient({
      ...row,
      microLocation: encodeLooseXY(x, y),
    });
  }
}

export class LayoutRectCard extends LayoutCard {
  static readonly WIDTH = RECT_CARD_WIDTH;
  static readonly HEIGHT = RECT_CARD_HEIGHT;

  private readonly bg = new Graphics();
  private readonly stateOverlay = new Graphics();
  private readonly nameText: Text;
  private definition: CardDefinition | null = null;
  private currentPackedDefinition: number | null = null;
  private titlePosition: RectCardTitlePosition = "top";

  constructor(cardId: number, ctx: GameContext) {
    super(cardId, ctx);
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
    // stackHost was added by LayoutCard's constructor as the first child so
    // it draws *behind* these — stacked children peek out from behind us.
    this.container.addChild(this.bg);
    this.container.addChild(this.nameText);
    this.container.addChild(this.stateOverlay);
    // Card size is constant; position is owned by the tween in layout().
    this.setSize(RECT_CARD_WIDTH, RECT_CARD_HEIGHT);
  }

  setTitlePosition(position: RectCardTitlePosition): void {
    if (this.titlePosition === position) return;
    this.titlePosition = position;
    this.invalidate();
  }

  applyData(row: CardRow): void {
    if (row.packedDefinition !== this.currentPackedDefinition) {
      this.currentPackedDefinition = row.packedDefinition;
      const def = this.ctx.definitions.decode(row.packedDefinition);
      this.definition = def ?? null;
      this.nameText.text = def?.name ?? FALLBACK_NAME;
      this.nameText.style.fill = def?.style[2] ?? FALLBACK_STYLE[2];
      this.invalidate();
    }

    // Self-position from row. When loose, target = decoded inventory xy.
    // When top-stacked (state 1), we're parented into the parent's stackHost
    // (Card.onDataChange handled the re-parent). We sit *behind* the parent
    // at local y = -titleHeight so our own titlebar peeks out above the
    // parent's top edge. Stack chains accumulate naturally — each child is
    // -titleHeight from its own parent, so child2 ends up at -2*titleHeight
    // from the root parent.
    const stacked = getStackedState(row.flags);
    if (stacked === STACKED_LOOSE) {
      const { x, y } = decodeLooseXY(row.microLocation);
      this.setTarget(x, y);
    } else if (stacked === STACKED_ON_RECT_X) {
      this.setTitlePosition("top");
      this.setTarget(0, -RECT_CARD_TITLE_HEIGHT);
    }
  }

  protected override layout(): boolean | void {
    const style = this.definition?.style ?? FALLBACK_STYLE;
    const [primary, secondary, outline] = style;
    const baseStrokeColor = this.state.selected ? 0xffff00 : outline;
    const baseStrokeWidth = this.state.selected ? 3 : 2;

    const titleY =
      this.titlePosition === "top"
        ? 0
        : Math.max(0, this.height - RECT_CARD_TITLE_HEIGHT);

    this.bg.clear();
    // Body — full card filled with primary.
    this.bg.rect(0, 0, this.width, this.height).fill({ color: primary });
    // Title bar — top or bottom strip filled with secondary.
    this.bg
      .rect(0, titleY, this.width, RECT_CARD_TITLE_HEIGHT)
      .fill({ color: secondary });
    // Outline around the whole card.
    this.bg
      .rect(0, 0, this.width, this.height)
      .stroke({ color: baseStrokeColor, width: baseStrokeWidth });

    // Name centered within the title bar.
    this.nameText.position.set(
      this.width / 2,
      titleY + RECT_CARD_TITLE_HEIGHT / 2,
    );

    this.stateOverlay.clear();
    if (this.state.hovered) {
      this.stateOverlay
        .rect(-2, -2, this.width + 4, this.height + 4)
        .stroke({ color: 0xffffff, width: 1, alpha: 0.5 });
    }
    if (this.state.pending) {
      this.stateOverlay
        .rect(0, 0, this.width, 3)
        .fill({ color: 0xff8800 });
    }
    this.container.alpha = this.state.dragging ? 0.7 : 1;

    // Tween toward the effective target. While dragging the cursor wins
    // (parent surface is the canvas-aligned overlay, so pointer coords map
    // 1:1 to local coords); otherwise the data-driven target set in
    // applyData wins. While dragging, stay dirty even after reaching the
    // target so cursor moves continue to drive layout.
    let effX = this.targetX;
    let effY = this.targetY;
    if (this.state.dragging) {
      const ptr = this.ctx.input?.lastPointer;
      if (ptr) {
        effX = ptr.x - this.dragOffsetX;
        effY = ptr.y - this.dragOffsetY;
      }
    }
    const moving = this.tweenTo(effX, effY);
    return this.state.dragging || moving;
  }
}
