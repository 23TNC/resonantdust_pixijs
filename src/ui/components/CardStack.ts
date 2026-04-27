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
 * Displays a chain of stacked cards as a visual stack.
 *
 * Starting from the root card_id, the component follows stacked_on_id,
 * building a chain of Card children.  Each child after the root is shifted
 * down by titleHeight pixels and rendered at a higher depth, so earlier cards
 * peek above later ones with only their title bars visible.  The final card
 * in the chain is fully visible on top.
 *
 * Visual (3 cards, arrows show link direction):
 *
 *   ┌────────────┐  ← linked card 2 (depth 0, y = 0)           — behind
 *   │ title      │
 *   ├────────────┤  ← linked card 1 (depth 1, y = titleHeight)
 *   │ title      │
 *   ├────────────┤  ← root (depth 2, y = 2·titleHeight)         — on top
 *   │ title      │
 *   │            │
 *   │   body     │
 *   └────────────┘
 *
 * Cards stack upward: the root sits at the bottom of the rect and renders on
 * top; each linked card peeks above it, drawn behind the card below it.
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

    const n = this._cards.length;
    this.setOrigin(0, n > 0 ? -(n - 1) * this._titleHeight : 0);

    const { x, width, height } = this.innerRect;
    const cardH = n > 0 ? Math.max(0, height - (n - 1) * this._titleHeight) : 0;

    for (let i = 0; i < n; i++) {
      this._cards[i].setCardId(this._chain[i]);
      this._cards[i].setLayout(x, -i * this._titleHeight, width, cardH);
    }

  }

  // ─── Private ─────────────────────────────────────────────────────────────

  /**
   * Walk stacked_on_id from the root to build the ordered chain.
   * Stops when a card has no parent (stacked_on_id === 0).
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

      if (!card || card.stacked_on_id === 0) break;
      current = card.stacked_on_id;
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
    const n = this._chain.length;

    while (this._cards.length < n) {
      const card = new Card({ titleHeight: this._titleHeight });
      this._cards.push(card);
      this.addLayoutChild(card, 0);
    }

    while (this._cards.length > n) {
      const card = this._cards.pop()!;
      this.removeLayoutChild(card);
      card.destroy({ children: true });
    }

    // Root (index 0) on top; deepest child (index n-1) behind.
    for (let i = 0; i < n; i++) {
      this.setChildDepth(this._cards[i], n - 1 - i);
    }
  }
}
