import type { GameContext } from "../../../GameContext";
import type { Card as CardRow } from "../../../server/spacetime/bindings/types";
import { decodeLooseXY, microIsCard, type LooseXY } from "../cardData";

/**
 * The data / sim half of a card — shape-agnostic. Tracks whether the card is
 * loose (freely placed) vs. a stack member, and decodes its loose xy from
 * `microLocation`.
 *
 * Formerly split into the identical `GameRectCard` / `GameHexCard` subclasses;
 * collapsed once card rendering went fully generic (the rect/hex distinction
 * no longer exists at runtime — every card uses `LayoutGenericCard`).
 */
export class GameCard {
  readonly cardId: number;
  protected readonly ctx: GameContext;
  private _dragging = false;
  private isMember = false;
  private microLocation = 0;

  constructor(cardId: number, ctx: GameContext) {
    this.cardId = cardId;
    this.ctx = ctx;
  }

  applyData(row: CardRow): void {
    this.isMember = microIsCard(row.flags);
    this.microLocation = row.microLocation;
  }

  isLoose(): boolean {
    return !this.isMember;
  }

  getLoosePosition(): LooseXY | null {
    if (!this.isLoose()) return null;
    return decodeLooseXY(this.microLocation);
  }

  whereAreYou(): { x: number; y: number } {
    return this.getLoosePosition() ?? { x: 0, y: 0 };
  }

  setDragging(value: boolean): void {
    this._dragging = value;
  }

  isDragging(): boolean {
    return this._dragging;
  }

  destroy(): void {}
}
