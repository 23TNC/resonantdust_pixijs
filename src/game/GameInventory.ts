import type { Card } from "../cards/Card";
import {
  getStackedState,
  STACKED_LOOSE,
  STACKED_ON_RECT_X,
  STACKED_ON_RECT_Y,
} from "../cards/cardData";
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
/** Safety bound on chain walks — prevents runaway on malformed cyclic data. */
const FIND_ROOT_MAX_DEPTH = 64;

/**
 * Game logic for a single inventory zone. Subscribes to `CardManager` for the
 * zone's cards, holds the rect-shaped Cards in a `Set`, runs overlap-push
 * every game tick.
 *
 * Stacked cards collide via their root — the loose card at the base of the
 * chain (state 0). For each tracked card we walk up via `microLocation`
 * while state is 1 (top) or 2 (bottom); state 3 (hex) is unsupported here
 * and just opts the card out of pushing. Multiple cards in the same chain
 * resolve to the same root, so we deduplicate before the pairwise pass.
 * Pushing the root carries the rest of the stack along through the
 * layout-tree parenting.
 *
 * Cards (composites) are stored rather than `GameRectCard`s so we can route
 * mutations through the canonical `Card.setPosition` setter.
 */
export class GameInventory {
  private readonly cards = new Set<Card>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly ctx: GameContext,
    zoneId: ZoneId,
  ) {
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
    const roots = new Set<Card>();
    for (const c of this.cards) {
      const root = this.findRoot(c);
      // Skip roots outside our tracked set — a chain that crosses zones
      // belongs to whichever zone holds its root, not us.
      if (root && this.cards.has(root)) roots.add(root);
    }

    const arr = [...roots];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        this.tryPush(arr[i], arr[j]);
      }
    }
  }

  /**
   * Walks `card` up via `microLocation` while its stack-state is 1 (top) or
   * 2 (bottom) and returns the root — the card whose state is 0 (loose).
   * Returns null for hex-anchored cards (state 3, not yet supported), or
   * if the chain is broken (missing parent / row).
   */
  private findRoot(card: Card): Card | null {
    let current: Card = card;
    for (let i = 0; i < FIND_ROOT_MAX_DEPTH; i++) {
      if (!(current.gameCard instanceof GameRectCard)) return null;
      const row = this.ctx.data.get("cards", current.cardId);
      if (!row) return null;
      const state = getStackedState(row.microZone);
      if (state === STACKED_LOOSE) return current;
      if (state !== STACKED_ON_RECT_X && state !== STACKED_ON_RECT_Y) {
        return null;
      }
      const parent = this.ctx.cards?.get(row.microLocation);
      if (!parent) return null;
      current = parent;
    }
    return null;
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
