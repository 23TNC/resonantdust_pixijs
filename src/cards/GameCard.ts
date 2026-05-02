import type { GameContext } from "../GameContext";
import type { Card as CardRow } from "../server/bindings/types";

export abstract class GameCard {
  readonly cardId: number;
  protected readonly ctx: GameContext;

  constructor(cardId: number, ctx: GameContext) {
    this.cardId = cardId;
    this.ctx = ctx;
  }

  abstract applyData(row: CardRow): void;

  whereAreYou(): { x: number; y: number } {
    return { x: 0, y: 0 };
  }

  destroy(): void {}
}
