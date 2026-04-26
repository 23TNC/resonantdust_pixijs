import { client_cards, type CardId } from "@/spacetime/Data";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import { Card } from "./Card";

export interface CardStackOptions extends LayoutObjectOptions {
  card_id?:          CardId;
  titleHeight?:      number;
  /** When true, dragging/returning cards are included in the chain. Default: false. */
  ignoreDragState?:  boolean;
}

// Prevents an infinite loop if the server ever sends a malformed link cycle.
const MAX_STACK_DEPTH = 64;

/**
 * Displays a chain of linked cards as a visual stack.
 *
 * Starting from the root card_id, the component follows link_id while
 * linked_flag is true, building a chain of Card children.  Each child after
 * the root is shifted down by titleHeight pixels and rendered at a higher
 * depth, so earlier cards peek above later ones with only their title bars
 * visible.  The final card in the chain is fully visible on top.
 *
 * Visual (3 cards, arrows show link direction):
 *
 *   ┌────────────┐  ← root (depth 0, y = 0)
 *   │ title      │
 *   ├────────────┤  ← linked card 1 (depth 1, y = titleHeight)
 *   │ title      │
 *   ├────────────┤  ← linked card 2 (depth 2, y = 2·titleHeight)
 *   │ title      │
 *   │            │
 *   │   body     │
 *   └────────────┘
 *
 * All cards share the same width and height; the height is computed so the
 * entire stack fits within innerRect:
 *   cardHeight = innerRect.height − (n − 1) · titleHeight
 *
 * Call invalidateLayout() after any data change that could alter the chain.
 */
export class CardStack extends LayoutObject {
  private _rootCardId:              CardId;
  private readonly _titleHeight:    number;
  private readonly _ignoreDragState: boolean;

  // Resolved chain and parallel Card array — kept in sync by _syncCards().
  private _chain: CardId[] = [];
  private readonly _cards: Card[] = [];

  constructor(options: CardStackOptions = {}) {
    super(options);
    this._rootCardId       = options.card_id          ?? 0;
    this._titleHeight      = options.titleHeight      ?? 24;
    this._ignoreDragState  = options.ignoreDragState  ?? false;
    this.invalidateLayout();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  setCardId(cardId: CardId): void {
    if (this._rootCardId === cardId) return;
    this._rootCardId = cardId;
    this.invalidateLayout();
  }

  getCardId(): CardId { return this._rootCardId; }

  // ─── Layout ──────────────────────────────────────────────────────────────

  protected override updateLayoutChildren(): void {
    const chain = this._resolveChain();

    // Only rebuild Card children when the chain structure changes.
    if (!this._chainEquals(chain)) {
      this._chain = chain;
      this._syncCards();
    }

    const { x, y, width, height } = this.innerRect;
    const n    = this._cards.length;
    const cardH = n > 0 ? Math.max(0, height - (n - 1) * this._titleHeight) : 0;

    for (let i = 0; i < n; i++) {
      this._cards[i].setCardId(this._chain[i]);
      this._cards[i].setLayout(x, y + i * this._titleHeight, width, cardH);
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  /**
   * Walk link_id/linked_flag from the root to build the ordered chain.
   * Stops at the first card where linked_flag is false or link_id is zero.
   * A Set guards against link cycles; MAX_STACK_DEPTH provides a hard cap.
   */
  private _resolveChain(): CardId[] {
    const chain: CardId[] = [];
    if (this._rootCardId === 0) return chain;

    const seen    = new Set<CardId>();
    let   current = this._rootCardId;

    while (current !== 0 && chain.length < MAX_STACK_DEPTH) {
      if (seen.has(current)) break; // cycle detected
      const card = client_cards[current];
      if (!this._ignoreDragState && (card?.dragging || card?.returning)) break;
      seen.add(current);
      chain.push(current);

      if (!card || !card.stackable || card.link_id === 0) break;
      const next = client_cards[card.link_id];
      if (!next?.stacked) break;
      current = card.link_id;
    }

    return chain;
  }

  private _chainEquals(other: CardId[]): boolean {
    if (this._chain.length !== other.length) return false;
    for (let i = 0; i < other.length; i++) {
      if (this._chain[i] !== other[i]) return false;
    }
    return true;
  }

  /**
   * Add or remove Card children so _cards.length matches _chain.length.
   * Cards are assigned increasing depths so later cards render on top.
   */
  private _syncCards(): void {
    while (this._cards.length < this._chain.length) {
      const card = new Card({ titleHeight: this._titleHeight });
      this._cards.push(card);
      this.addLayoutChild(card, this._cards.length - 1);
    }

    while (this._cards.length > this._chain.length) {
      const card = this._cards.pop()!;
      this.removeLayoutChild(card);
      card.destroy({ children: true });
    }
  }
}
