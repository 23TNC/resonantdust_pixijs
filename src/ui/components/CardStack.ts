import { client_cards, stacked_up_children, type CardId } from "@/spacetime/Data";
import { getDefinitionByPacked } from "@/data/definitions/CardDefinitions";
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
 * Starting from the root card_id, the component follows stacked_up_children,
 * building a chain of Card children.  Each child after the root is shifted by
 * titleHeight pixels and rendered at a lower depth so later cards peek out
 * with only their title bars visible.
 *
 * Grow direction is determined by the root card's definition (title_on_bottom):
 *
 *   title_on_bottom = false → grow upward (titles peek above the root):
 *
 *     ┌────────────┐  ← chain[2]  y = −2·titleHeight   — behind
 *     │ title      │
 *     ├────────────┤  ← chain[1]  y = −titleHeight
 *     │ title      │
 *     ├────────────┤  ← root      y = 0                 — on top
 *     │ title      │
 *     │   body     │
 *     └────────────┘
 *
 *   title_on_bottom = true → grow downward (titles peek below the root):
 *
 *     ┌────────────┐  ← root      y = 0                 — on top
 *     │   body     │
 *     │   title    │
 *     ├────────────┤  ← chain[1]  y = +titleHeight
 *     │   body     │
 *     │   title    │
 *     ├────────────┤  ← chain[2]  y = +2·titleHeight    — behind
 *     │   body     │
 *     │   title    │
 *     └────────────┘
 *
 * The root occupies the full card height supplied by the parent via setLayout.
 * Each additional card extends the rect in the grow direction by titleHeight.
 * All cards share the same width and height.
 */
export class CardStack extends LayoutObject {
  private _rootCardId:               CardId;
  private readonly _titleHeight:     number;
  private readonly _ignoreDragState: boolean;

  // Height given by the parent for a single card — captured in setLayout.
  private _cardHeight = 0;

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

  override setLayout(x: number, y: number, width: number, height: number): void {
    this._cardHeight = height;
    super.setLayout(x, y, width, height);
  }

  protected override updateLayoutChildren(): void {
    const chain = this._resolveChain();

    if (!this._chainEquals(chain)) {
      this._chain = chain;
      this._syncCards();
    }

    const n     = this._cards.length;
    const extra = (n - 1) * this._titleHeight;

    // Grow direction is determined by the dragged card's (chain[1]) definition.
    const stackBCard = n > 1 ? client_cards[this._chain[1]] : undefined;
    const stackBDef  = stackBCard ? getDefinitionByPacked(stackBCard.packed_definition) : undefined;
    const growDown   = stackBDef?.title_on_bottom ?? false;

    // Extend the rect in the grow direction.  Direct mutation avoids calling
    // setOrigin, which would fire invalidateLayout and create a layout cycle.
    if (growDown) {
      this.outerRect.y      = 0;
      this.outerRect.height = this._cardHeight + extra;
      this.innerRect.y      = 0;
      this.innerRect.height = this._cardHeight + extra;
    } else {
      this.outerRect.y      = -extra;
      this.outerRect.height = this._cardHeight + extra;
      this.innerRect.y      = -extra;
      this.innerRect.height = this._cardHeight + extra;
    }

    const { x, width } = this.innerRect;

    for (let i = 0; i < n; i++) {
      this._cards[i].setCardId(this._chain[i]);
      this._cards[i].setLayout(
        x,
        growDown ? i * this._titleHeight : -i * this._titleHeight,
        width,
        this._cardHeight,
      );
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  /**
   * Walk stacked_up_children from the root to build the ordered chain.
   * root_card_id is the base (non-stacked) card; each step follows one child
   * upward until no children remain. Stops early when ignoreDragState is false
   * and the next child is dragging or returning.
   * A Set guards against cycles; MAX_STACK_DEPTH provides a hard cap.
   */
  private _resolveChain(): CardId[] {
    const chain: CardId[] = [];
    if (this._rootCardId === 0) return chain;

    const seen    = new Set<CardId>();
    let   current = this._rootCardId;

    while (current !== 0 && chain.length < MAX_STACK_DEPTH) {
      if (seen.has(current)) break;
      const card = client_cards[current];
      if (!this._ignoreDragState && (card?.dragging || card?.returning)) break;
      seen.add(current);
      chain.push(current);

      const children = stacked_up_children.get(current);
      if (!children || children.size === 0) break;
      current = children.values().next().value!;
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
   * Root (index 0) gets the highest depth and renders on top.
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
