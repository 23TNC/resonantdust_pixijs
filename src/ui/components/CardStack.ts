import { client_cards, stacked_up_children, stacked_down_children, type CardId } from "@/spacetime/Data";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import { Card } from "./Card";

export interface CardStackOptions extends LayoutObjectOptions {
  card_id?:         CardId;
  titleHeight?:     number;
  /** Pixels of body showing between adjacent stacked-card titles. Default: 2. */
  titleGap?:        number;
  /** When true, dragging/returning cards are included in branches. Default: false. */
  ignoreDragState?: boolean;
}

const MAX_STACK_DEPTH = 64;

/**
 * Displays a root card with two independent branches of stacked children.
 *
 * The root has neither CARD_FLAG_STACKED_UP nor CARD_FLAG_STACKED_DOWN.
 * Cards in stacked_up_children   form the UP   branch — each peeks above the
 * previous card with only its top title bar visible.
 * Cards in stacked_down_children form the DOWN branch — each peeks below the
 * previous card with only its bottom title bar visible.
 *
 * Visual (2 up-branch cards, 1 down-branch card):
 *
 *   ┌────────────┐  ← up[1]    y = −2·titleHeight   — furthest behind
 *   │ title      │
 *   ├────────────┤  ← up[0]    y = −titleHeight
 *   │ title      │
 *   ├────────────┤  ← root     y = 0                 — on top
 *   │ title/body │
 *   ├────────────┤
 *   │   body     │
 *   │   title    │
 *   └────────────┘  ← down[0]  y = +titleHeight      — behind
 *
 * The rect origin is placed at the root's top-left corner by the parent.
 * updateLayoutChildren grows the rect upward by upCount*titleHeight and
 * downward by downCount*titleHeight without calling setOrigin (which would
 * fire invalidateLayout and create a layout cycle with the parent).
 */
export class CardStack extends LayoutObject {
  private _rootCardId:               CardId;
  private readonly _titleHeight:     number;
  private _titleGap:                 number;
  private readonly _ignoreDragState: boolean;

  // Single-card height supplied by the parent via setLayout.
  private _cardHeight = 0;

  // Root card display object — created on first non-zero rootCardId.
  private _rootCard: Card | null = null;

  // UP branch: index 0 is the direct child of root in stacked_up_children.
  private _upChain: CardId[] = [];
  private readonly _upCards: Card[] = [];

  // DOWN branch: index 0 is the direct child of root in stacked_down_children.
  private _downChain: CardId[] = [];
  private readonly _downCards: Card[] = [];

  constructor(options: CardStackOptions = {}) {
    super(options);
    this._rootCardId      = options.card_id         ?? 0;
    this._titleHeight     = options.titleHeight     ?? 24;
    this._titleGap        = options.titleGap        ?? -2;
    this._ignoreDragState = options.ignoreDragState ?? false;
    this.invalidateLayout();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  setCardId(cardId: CardId): void {
    if (this._rootCardId === cardId) return;
    this._rootCardId = cardId;
    this.invalidateLayout();
  }

  getCardId(): CardId { return this._rootCardId; }

  /** The Card display object for the root, or null when rootCardId is 0. */
  getRootCard(): Card | null { return this._rootCard; }

  getTitleGap(): number { return this._titleGap; }

  /**
   * Update the gap between adjacent stacked-card titles.  Triggers a layout
   * pass so card positions and the rect bounds re-compute.  No-op if the
   * value matches the current gap.
   */
  setTitleGap(gap: number): void {
    if (this._titleGap === gap) return;
    this._titleGap = gap;
    this.invalidateLayout();
  }

  // ─── Layout ──────────────────────────────────────────────────────────────

  override setLayout(x: number, y: number, width: number, height: number): void {
    this._cardHeight = height;
    super.setLayout(x, y, width, height);
    // super.setLayout resets innerRect to single-card size.  Re-grow it
    // immediately so layout calculations that read outerRect/innerRect
    // (Inventory's clamp / push, debug visualisation) see the correct
    // extent without waiting for the recursive updateLayoutChildren pass.
    this._growRect();
  }

  /**
   * Hit testing on a CardStack defers entirely to its child cards.
   * The default innerRect-based hit test would short-circuit on the
   * single-card-sized rect that super.setLayout reset before _growRect
   * had a chance to extend it for this frame, AND it doesn't account for
   * a child whose layout hasn't yet been refreshed in this pass.  Asking
   * each card directly is both simpler and correct: a card is hit iff
   * the cursor falls within that card's own innerRect (in its local
   * space), regardless of how the parent stack thinks of its own extent.
   */
  override hitTestLayout(
    globalX: number,
    globalY: number,
    ignore?: ReadonlySet<LayoutObject>,
  ): LayoutObject | null {
    if (ignore?.has(this)) return null;
    const children = this.getLayoutChildren();
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (!child.visible) continue;
      const hit = child.hitTestLayout(globalX, globalY, ignore);
      if (hit) return hit;
    }
    return null;
  }

  protected override updateLayoutChildren(): void {
    if (this._rootCardId === 0) {
      this._clearAll();
      return;
    }

    // ── Ensure root card exists ───────────────────────────────────────────
    if (!this._rootCard) {
      this._rootCard = new Card({ titleHeight: this._titleHeight });
      this.addLayoutChild(this._rootCard);
    }

    // ── Resolve branches ─────────────────────────────────────────────────
    const upChain   = this._walkBranch(stacked_up_children);
    const downChain = this._walkBranch(stacked_down_children);

    if (!this._arraysEqual(this._upChain, upChain)) {
      this._syncBranch(upChain.length, this._upCards);
      this._upChain = upChain;
    }
    if (!this._arraysEqual(this._downChain, downChain)) {
      this._syncBranch(downChain.length, this._downCards);
      this._downChain = downChain;
    }

    this._growRect();

    const upCount   = this._upCards.length;
    const downCount = this._downCards.length;
    const step      = this._titleHeight + this._titleGap;

    const { x, width } = this.innerRect;

    // ── Position cards ────────────────────────────────────────────────────
    this._rootCard.setCardId(this._rootCardId);
    this._rootCard.setLayout(x, 0, width, this._cardHeight);

    for (let i = 0; i < upCount; i++) {
      this._upCards[i].setCardId(this._upChain[i]);
      this._upCards[i].setLayout(x, -(i + 1) * step, width, this._cardHeight);
    }

    for (let i = 0; i < downCount; i++) {
      this._downCards[i].setCardId(this._downChain[i]);
      this._downCards[i].setLayout(x, (i + 1) * step, width, this._cardHeight);
    }

    // ── Depth: root on top; each branch recedes behind the previous card ──
    const total = upCount + downCount;
    this.setChildDepth(this._rootCard, total);
    for (let i = 0; i < upCount; i++) {
      this.setChildDepth(this._upCards[i], upCount - 1 - i);
    }
    for (let i = 0; i < downCount; i++) {
      this.setChildDepth(this._downCards[i], downCount - 1 - i);
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  /**
   * Resize outerRect/innerRect from the current chain state.  Called both by
   * setLayout (so the hitbox is correct immediately) and by
   * updateLayoutChildren (so it stays in sync after chain changes).  Direct
   * mutation avoids setOrigin, which would fire invalidateLayout and create
   * a layout cycle with the parent.
   */
  private _growRect(): void {
    if (this._rootCardId === 0) {
      this.outerRect.y      = 0;
      this.outerRect.height = 0;
      this.innerRect.y      = 0;
      this.innerRect.height = 0;
      return;
    }
    const upChain   = this._walkBranch(stacked_up_children);
    const downChain = this._walkBranch(stacked_down_children);
    const step      = this._titleHeight + this._titleGap;
    const upExtra   = upChain.length   * step;
    const downExtra = downChain.length * step;
    this.outerRect.y      = -upExtra;
    this.outerRect.height = this._cardHeight + upExtra + downExtra;
    this.innerRect.y      = -upExtra;
    this.innerRect.height = this._cardHeight + upExtra + downExtra;
  }

  /**
   * Walk one branch index from the root, returning the ordered chain of
   * child card IDs (root not included).  Stops at cycles, missing cards,
   * dragging/returning cards (unless ignoreDragState), or MAX_STACK_DEPTH.
   */
  private _walkBranch(index: Map<CardId, Set<CardId>>): CardId[] {
    const chain: CardId[] = [];
    const seen  = new Set<CardId>([this._rootCardId]);
    let current = this._rootCardId;

    while (chain.length < MAX_STACK_DEPTH) {
      const children = index.get(current);
      if (!children || children.size === 0) break;
      const next = children.values().next().value!;
      if (seen.has(next)) break;
      const card = client_cards[next];
      if (!this._ignoreDragState && (card?.dragging || card?.returning)) break;
      seen.add(next);
      chain.push(next);
      current = next;
    }

    return chain;
  }

  /** Grow or shrink a branch card pool to match targetLength. */
  private _syncBranch(targetLength: number, cards: Card[]): void {
    while (cards.length < targetLength) {
      const card = new Card({ titleHeight: this._titleHeight });
      cards.push(card);
      this.addLayoutChild(card, 0);
    }
    while (cards.length > targetLength) {
      const card = cards.pop()!;
      this.removeLayoutChild(card);
      card.destroy({ children: true });
    }
  }

  /** Remove all cards and reset rect when rootCardId is 0. */
  private _clearAll(): void {
    if (this._rootCard) {
      this.removeLayoutChild(this._rootCard);
      this._rootCard.destroy({ children: true });
      this._rootCard = null;
    }
    this._syncBranch(0, this._upCards);
    this._syncBranch(0, this._downCards);
    this._upChain   = [];
    this._downChain = [];
    this.outerRect.y      = 0;
    this.outerRect.height = 0;
    this.innerRect.y      = 0;
    this.innerRect.height = 0;
  }

  private _arraysEqual(a: CardId[], b: CardId[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // ─── Static leaf walks ───────────────────────────────────────────────────
  // Pure data walks for callers (e.g. drag-and-drop merges) that need the
  // attachment point of an existing stack.  Unlike _walkBranch, these ignore
  // dragging/returning state — the goal is the true data leaf, not where a
  // visual chain happens to stop.

  /** Walk stacked_up_children from rootId; return the up-branch leaf (or rootId if empty). */
  static findUpLeaf(rootId: CardId): CardId {
    return CardStack._walkToLeaf(rootId, stacked_up_children);
  }

  /** Walk stacked_down_children from rootId; return the down-branch leaf (or rootId if empty). */
  static findDownLeaf(rootId: CardId): CardId {
    return CardStack._walkToLeaf(rootId, stacked_down_children);
  }

  private static _walkToLeaf(rootId: CardId, index: Map<CardId, Set<CardId>>): CardId {
    const seen  = new Set<CardId>([rootId]);
    let current = rootId;
    let steps   = 0;

    while (steps < MAX_STACK_DEPTH) {
      const children = index.get(current);
      if (!children || children.size === 0) break;
      const next = children.values().next().value!;
      if (seen.has(next)) break;
      seen.add(next);
      current = next;
      steps++;
    }

    return current;
  }
}
