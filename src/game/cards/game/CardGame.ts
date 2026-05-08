import type { GameContext } from "../../../GameContext";
import type { Card as CardRow } from "../../../server/spacetime/bindings/types";

export abstract class GameCard {
  readonly cardId: number;
  protected readonly ctx: GameContext;
  private _dragging = false;

  constructor(cardId: number, ctx: GameContext) {
    this.cardId = cardId;
    this.ctx = ctx;
  }

  abstract applyData(row: CardRow): void;

  whereAreYou(): { x: number; y: number } {
    return { x: 0, y: 0 };
  }

  setDragging(value: boolean): void {
    this._dragging = value;
  }

  isDragging(): boolean {
    return this._dragging;
  }

  destroy(): void {}
}
