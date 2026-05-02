import type { GameContext } from "../GameContext";
import type { Card as CardRow } from "../server/bindings/types";
import { GameCard } from "./GameCard";
import { LayoutCard } from "./LayoutCard";

export class GameHexCard extends GameCard {
  constructor(cardId: number, ctx: GameContext) {
    super(cardId, ctx);
    console.warn(
      `[GameHexCard] cardId=${cardId} — game logic not yet implemented`,
    );
  }

  applyData(_row: CardRow): void {
    // placeholder
  }
}

export class LayoutHexCard extends LayoutCard {
  constructor(cardId: number, ctx: GameContext) {
    super(cardId, ctx);
    console.warn(
      `[LayoutHexCard] cardId=${cardId} — hex visuals not yet implemented`,
    );
  }

  applyData(_row: CardRow): void {
    // placeholder
  }
}
