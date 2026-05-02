import { Graphics, Text } from "pixi.js";
import type { CardDefinition } from "../definitions/DefinitionManager";
import type { GameContext } from "../GameContext";
import type { Card as CardRow } from "../server/bindings/types";
import {
  decodeLooseXY,
  encodeLooseXY,
  getStackedState,
  STACKED_LOOSE,
  type LooseXY,
} from "./cardData";
import { GameCard } from "./GameCard";
import { LayoutCard } from "./LayoutCard";

const FALLBACK_STYLE = ["#3a3a4a", "#7a7a8a", "#0b1426"] as const;
const FALLBACK_NAME = "?";

export const RECT_CARD_WIDTH = 72;
export const RECT_CARD_HEIGHT = 96;

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

  constructor(cardId: number, ctx: GameContext) {
    super(cardId, ctx);
    this.nameText = new Text({
      text: FALLBACK_NAME,
      style: {
        fill: 0xffffff,
        fontFamily: "sans-serif",
        fontSize: 12,
        align: "center",
        wordWrap: true,
        wordWrapWidth: RECT_CARD_WIDTH - 8,
      },
    });
    this.nameText.anchor.set(0.5);
    this.container.addChild(this.bg);
    this.container.addChild(this.nameText);
    this.container.addChild(this.stateOverlay);
  }

  applyData(row: CardRow): void {
    if (row.packedDefinition !== this.currentPackedDefinition) {
      this.currentPackedDefinition = row.packedDefinition;
      const def = this.ctx.definitions.decode(row.packedDefinition);
      this.definition = def ?? null;
      this.nameText.text = def?.name ?? FALLBACK_NAME;
      this.invalidate();
    }

    // Self-position from row when loose. Stacked cards derive position from
    // their parent (handled later when stack chains land).
    if (getStackedState(row.flags) === STACKED_LOOSE) {
      const { x, y } = decodeLooseXY(row.microLocation);
      this.setBounds(x, y, RECT_CARD_WIDTH, RECT_CARD_HEIGHT);
    }
  }

  protected override layout(): void {
    const style = this.definition?.style ?? FALLBACK_STYLE;
    const [primary, , outline] = style;
    const baseStrokeColor = this.state.selected ? 0xffff00 : outline;
    const baseStrokeWidth = this.state.selected ? 3 : 2;
    this.bg
      .clear()
      .roundRect(0, 0, this.width, this.height, 6)
      .fill({ color: primary })
      .stroke({ color: baseStrokeColor, width: baseStrokeWidth });
    this.nameText.position.set(this.width / 2, this.height / 2);

    this.stateOverlay.clear();
    if (this.state.hovered) {
      this.stateOverlay
        .roundRect(-2, -2, this.width + 4, this.height + 4, 8)
        .stroke({ color: 0xffffff, width: 1, alpha: 0.5 });
    }
    if (this.state.pending) {
      this.stateOverlay
        .rect(0, 0, this.width, 3)
        .fill({ color: 0xff8800 });
    }
    this.container.alpha = this.state.dragging ? 0.7 : 1;
  }
}
