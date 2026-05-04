import type { Card } from "../cards/Card";
import {
  getStackedState,
  STACKED_LOOSE,
  STACKED_ON_RECT_X,
  STACKED_ON_RECT_Y,
} from "../cards/cardData";
import { GameHexCard, HEX_HEIGHT, HEX_WIDTH } from "../cards/HexagonCard";
import {
  GameRectCard,
  RECT_CARD_HEIGHT,
  RECT_CARD_TITLE_HEIGHT,
  RECT_CARD_WIDTH,
} from "../cards/RectangleCard";
import type { GameContext } from "../GameContext";
import type { ZoneId } from "../zones/zoneId";

const GRID_PAD = 8;
export const GRID_W = RECT_CARD_WIDTH + GRID_PAD;
export const GRID_H = RECT_CARD_HEIGHT + GRID_PAD;

const PUSH_FACTOR = 0.5;
const TIE_BREAK_DIRECTION_X = 1;
const TIE_BREAK_DIRECTION_Y = 0;
/** Safety bound on chain walks — prevents runaway on malformed cyclic data. */
const FIND_ROOT_MAX_DEPTH = 64;

/**
 * Game logic for a single inventory zone. Subscribes to `CardManager` for the
 * zone's cards, holds rect- and hex-shaped Cards in a `Set`, runs overlap-push
 * every game tick.
 *
 * Stacked cards collide via their root — the loose card at the base of the
 * chain (state 0). For each tracked card we walk up via `microLocation`
 * while state is 1 (top) or 2 (bottom). Hex cards are always loose roots.
 * Multiple cards in the same chain resolve to the same root, so we deduplicate
 * before the pairwise pass. Pushing the root carries the rest of the stack
 * along through the layout-tree parenting.
 *
 * Cards (composites) are stored rather than card subtypes so we can route
 * mutations through the canonical `Card.setPosition` setter.
 */
export class GameInventory {
  private readonly cards = new Set<Card>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly ctx: GameContext,
    private readonly zoneId: ZoneId,
  ) {
    if (!ctx.cards) {
      throw new Error("[GameInventory] ctx.cards is null");
    }

    for (const card of ctx.cards.cardsInZone(zoneId)) {
      if (card.gameCard instanceof GameRectCard || card.gameCard instanceof GameHexCard) {
        this.cards.add(card);
      }
    }

    this.unsubscribe = ctx.cards.subscribe(zoneId, (kind, card) => {
      if (!(card.gameCard instanceof GameRectCard) && !(card.gameCard instanceof GameHexCard)) return;
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

    this.clampToSurface(roots);
  }

  snapToGrid(): void {
    const surface = this.ctx.layout?.surfaceFor(this.zoneId);
    const sw = surface?.width ?? Infinity;
    const sh = surface?.height ?? Infinity;
    const seen = new Set<Card>();
    for (const card of this.cards) {
      const root = this.findRoot(card);
      if (!root || !this.cards.has(root) || seen.has(root)) continue;
      seen.add(root);
      if (root.isDragging()) continue;
      const b = this.getBounds(root);
      if (!b) continue;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const ox = (sw % GRID_W) / 2;
      const oy = (sh % GRID_H) / 2;
      const halfW = GRID_W / 2;
      const halfH = GRID_H / 2;
      const tx = Math.round((cx - ox - halfW) / GRID_W) * GRID_W + ox + halfW - b.w / 2;
      const ty = Math.round((cy - oy - halfH) / GRID_H) * GRID_H + oy + halfH - b.h / 2;
      const nx = Math.max(0, Math.min(tx, sw - b.w));
      const ny = Math.max(0, Math.min(ty, sh - b.h));
      root.setPosition({ kind: "loose", x: nx, y: ny });
    }
  }

  private clampToSurface(roots: Set<Card>): void {
    const surface = this.ctx.layout?.surfaceFor(this.zoneId);
    if (!surface) return;
    const sw = surface.width;
    const sh = surface.height;
    for (const card of roots) {
      if (card.isDragging()) continue;
      const cb = this.getChainBounds(card);
      if (!cb) continue;
      const rootX = cb.x;
      const rootY = cb.y + cb.rootOffsetY;

      if (rootX === 0 && rootY === 0) {
        const slot = this.findEmptyGridSlot(card, roots, sw, sh);
        if (slot) {
          card.setPosition({ kind: "loose", x: slot.x, y: slot.y });
        } else {
          card.setPosition({ kind: "loose", x: (sw - cb.w) / 2, y: (sh - cb.h) / 2 + cb.rootOffsetY });
        }
        continue;
      }

      const cx = Math.max(1, Math.min(cb.x, sw - cb.w));
      const cy = Math.max(1, Math.min(cb.y, sh - cb.h));
      const newRootX = cx;
      const newRootY = cy + cb.rootOffsetY;
      if (newRootX !== rootX || newRootY !== rootY) {
        card.setPosition({ kind: "loose", x: newRootX, y: newRootY });
      }
    }
  }

  private findEmptyGridSlot(
    card: Card,
    roots: Set<Card>,
    sw: number,
    sh: number,
  ): { x: number; y: number } | null {
    const cardCb = this.getChainBounds(card);
    if (!cardCb) return null;
    const gox = (sw % GRID_W) / 2;
    const goy = (sh % GRID_H) / 2;
    const cols = Math.floor((sw - gox) / GRID_W);
    const rows = Math.floor((sh - goy) / GRID_H);
    outer: for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tx = gox + col * GRID_W;
        const ty = goy + row * GRID_H;
        // Chain bounds when root is placed at (tx, ty).
        const chainY = ty - cardCb.rootOffsetY;
        const candidateCx = tx + cardCb.w / 2;
        const candidateCy = chainY + cardCb.h / 2;
        for (const other of roots) {
          if (other === card) continue;
          const ocb = this.getChainBounds(other);
          if (!ocb) continue;
          const overlapX = (cardCb.w + ocb.w) / 2 - Math.abs(candidateCx - (ocb.x + ocb.w / 2));
          const overlapY = (cardCb.h + ocb.h) / 2 - Math.abs(candidateCy - (ocb.y + ocb.h / 2));
          if (overlapX > 0 && overlapY > 0) continue outer;
        }
        return { x: tx, y: ty };
      }
    }
    return null;
  }

  /**
   * Returns the bounding box of the full visual chain rooted at `root`,
   * accounting for cards stacked above (STACKED_ON_RECT_X) and below
   * (STACKED_ON_RECT_Y). Each stacked card extends the chain by
   * RECT_CARD_TITLE_HEIGHT in its direction.
   *
   * `rootOffsetY` is the distance from the chain's top edge to the root
   * card's top edge — use it to convert a clamped chain position back to
   * a root setPosition call: rootY = chainY + rootOffsetY.
   */
  private getChainBounds(
    root: Card,
  ): { x: number; y: number; w: number; h: number; rootOffsetY: number } | null {
    const b = this.getBounds(root);
    if (!b) return null;
    if (!(root.gameCard instanceof GameRectCard)) {
      return { ...b, rootOffsetY: 0 };
    }
    let topCount = 0;
    let topId = root.stackedTop;
    while (topId !== 0 && topCount < FIND_ROOT_MAX_DEPTH) {
      const c = this.ctx.cards?.get(topId);
      if (!c) break;
      topCount++;
      topId = c.stackedTop;
    }
    let bottomCount = 0;
    let bottomId = root.stackedBottom;
    while (bottomId !== 0 && bottomCount < FIND_ROOT_MAX_DEPTH) {
      const c = this.ctx.cards?.get(bottomId);
      if (!c) break;
      bottomCount++;
      bottomId = c.stackedBottom;
    }
    const extendUp   = topCount    * RECT_CARD_TITLE_HEIGHT;
    const extendDown = bottomCount * RECT_CARD_TITLE_HEIGHT;
    return {
      x: b.x,
      y: b.y - extendUp,
      w: b.w,
      h: b.h + extendUp + extendDown,
      rootOffsetY: extendUp,
    };
  }

  /**
   * Walks `card` up via `microLocation` while its stack-state is 1 (top) or
   * 2 (bottom) and returns the root — the card whose state is 0 (loose).
   * Hex cards are always loose, so they return immediately. Returns null for
   * hex-anchored rect cards (state 3) or if the chain is broken.
   */
  private findRoot(card: Card): Card | null {
    let current: Card = card;
    for (let i = 0; i < FIND_ROOT_MAX_DEPTH; i++) {
      const row = this.ctx.data.get("cards", current.cardId);
      if (!row) return null;
      const state = getStackedState(row.microZone);
      if (state === STACKED_LOOSE) return current;
      if (state !== STACKED_ON_RECT_X && state !== STACKED_ON_RECT_Y) return null;
      const parent = this.ctx.cards?.get(row.microLocation);
      if (!parent) return null;
      current = parent;
    }
    return null;
  }

  private getBounds(card: Card): { x: number; y: number; w: number; h: number } | null {
    if (card.gameCard instanceof GameRectCard) {
      const pos = card.gameCard.getLoosePosition();
      if (!pos) return null;
      return { x: pos.x, y: pos.y, w: RECT_CARD_WIDTH, h: RECT_CARD_HEIGHT };
    }
    if (card.gameCard instanceof GameHexCard) {
      const pos = card.gameCard.getLoosePosition();
      if (!pos) return null;
      return { x: pos.x, y: pos.y, w: HEX_WIDTH, h: HEX_HEIGHT };
    }
    return null;
  }

  dispose(): void {
    this.unsubscribe();
    this.cards.clear();
  }

  private tryPush(a: Card, b: Card): void {
    if (a.isDragging() || b.isDragging()) return;
    const acb = this.getChainBounds(a);
    const bcb = this.getChainBounds(b);
    const arb = this.getBounds(a);
    const brb = this.getBounds(b);
    if (!acb || !bcb || !arb || !brb) return;

    // Overlap detection uses the full chain bounds of each root.
    const dx = (bcb.x + bcb.w / 2) - (acb.x + acb.w / 2);
    const dy = (bcb.y + bcb.h / 2) - (acb.y + acb.h / 2);
    const overlapX = (acb.w + bcb.w) / 2 - Math.abs(dx);
    const overlapY = (acb.h + bcb.h) / 2 - Math.abs(dy);
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

    // Apply the push to the root card — the chain travels with it.
    const push = Math.min(overlapX, overlapY) * PUSH_FACTOR;
    a.setPosition({ kind: "loose", x: arb.x - dirX * push, y: arb.y - dirY * push });
    b.setPosition({ kind: "loose", x: brb.x + dirX * push, y: brb.y + dirY * push });
  }
}
