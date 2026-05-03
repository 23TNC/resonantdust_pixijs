import type { Card } from "../cards/Card";
import {
  GameRectCard,
  RECT_CARD_HEIGHT,
  RECT_CARD_WIDTH,
} from "../cards/RectangleCard";
import type { GameContext } from "../GameContext";
import type { ZoneId } from "../zones/zoneId";

const PUSH_FACTOR = 0.5;
const TIE_BREAK_DIRECTION_X = 1;
const TIE_BREAK_DIRECTION_Y = 0;

/**
 * Game logic for a single inventory zone. Subscribes to `CardManager` for the
 * zone's cards, holds the rect-shaped Cards in a `Set`, runs overlap-push
 * every game tick. Loose cards (stackedState == 0) get bumped; stacked cards
 * are left alone.
 *
 * Cards (composites) are stored rather than `GameRectCard`s so we can route
 * mutations through the canonical `Card.setPosition` setter.
 */
export class GameInventory {
  private readonly cards = new Set<Card>();
  private readonly unsubscribe: () => void;

  constructor(ctx: GameContext, zoneId: ZoneId) {
    if (!ctx.cards) {
      throw new Error("[GameInventory] ctx.cards is null");
    }

    for (const card of ctx.cards.cardsInZone(zoneId)) {
      if (card.gameCard instanceof GameRectCard) {
        this.cards.add(card);
      }
    }

    this.unsubscribe = ctx.cards.subscribe(zoneId, (kind, card) => {
      if (!(card.gameCard instanceof GameRectCard)) return;
      if (kind === "added") this.cards.add(card);
      else this.cards.delete(card);
    });
  }

  update(_dt: number): void {
    const loose: Card[] = [];
    for (const c of this.cards) {
      if (c.gameCard instanceof GameRectCard && c.gameCard.isLoose()) {
        loose.push(c);
      }
    }

    for (let i = 0; i < loose.length; i++) {
      for (let j = i + 1; j < loose.length; j++) {
        this.tryPush(loose[i], loose[j]);
      }
    }
  }

  dispose(): void {
    this.unsubscribe();
    this.cards.clear();
  }

  private tryPush(a: Card, b: Card): void {
    if (a.isDragging() || b.isDragging()) return;
    // Caller already filtered to GameRectCard + loose; narrow for the API.
    if (
      !(a.gameCard instanceof GameRectCard) ||
      !(b.gameCard instanceof GameRectCard)
    ) {
      return;
    }
    const ap = a.gameCard.getLoosePosition();
    const bp = b.gameCard.getLoosePosition();
    if (!ap || !bp) return;

    const dx = bp.x - ap.x;
    const dy = bp.y - ap.y;
    const overlapX = RECT_CARD_WIDTH - Math.abs(dx);
    const overlapY = RECT_CARD_HEIGHT - Math.abs(dy);
    if (overlapX <= 0 || overlapY <= 0) return;

    let dirX = dx;
    let dirY = dy;
    const dist = Math.sqrt(dirX * dirX + dirY * dirY);
    if (dist < 0.01) {
      dirX = TIE_BREAK_DIRECTION_X;
      dirY = TIE_BREAK_DIRECTION_Y;
    } else {
      dirX /= dist;
      dirY /= dist;
    }

    const push = Math.min(overlapX, overlapY) * PUSH_FACTOR;
    a.setPosition({
      kind: "loose",
      x: ap.x - dirX * push,
      y: ap.y - dirY * push,
    });
    b.setPosition({
      kind: "loose",
      x: bp.x + dirX * push,
      y: bp.y + dirY * push,
    });
  }
}
