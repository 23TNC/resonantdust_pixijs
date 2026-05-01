import { Point } from "pixi.js";
import {
  client_cards,
  stacked_up_children,
  stacked_down_children,
  moveClientCard,
  stackClientCardUp,
  stackClientCardDown,
  packMacroPanel,
  packMicroPixel,
  packMicroStacked,
  orphaned_roots,
  soul_id,
  SURFACE_PANEL,
  CARD_FLAG_STACKED_UP,
  CARD_FLAG_STACKED_DOWN,
  type CardId,
} from "@/spacetime/Data";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import { spacetime } from "@/spacetime/SpacetimeManager";
import { syncStackActions } from "@/definitions/ActionCache";
import { Card } from "./Card";
import { DragManager } from "./DragManager";

export interface CardStackOptions extends LayoutObjectOptions {
  card_id?:         CardId;
  titleHeight?:     number;
  /** Pixels of body showing between adjacent stacked-card titles. Default: 2. */
  titleGap?:        number;
  /** When true, dragging/animating cards are included in branches. Default: false. */
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

  // Listeners keyed by card_id for every card currently in the chain (root + branches).
  // Each fires invalidateLayout() so deaths are caught on the next layout pass.
  private _chainUnlistens = new Map<CardId, () => void>();

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
    // Eagerly register the root listener so deaths fire before the first layout pass.
    // _syncChainListeners will expand coverage to branch cards during updateLayoutChildren.
    this._syncChainListeners(cardId ? new Set([cardId]) : new Set());
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
    // Use the cached chains — no re-walk needed here.
    this._growRect(this._upChain, this._downChain);
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

    if (client_cards[this._rootCardId]?.dead === 2) {
      this._detachBranchChildren(this._rootCardId, stacked_up_children,   true);
      this._detachBranchChildren(this._rootCardId, stacked_down_children, false);
      const dying_id     = this._rootCardId;
      this._rootCardId   = 0;
      this._clearAll();
      spacetime.finalizeCardRemoval(dying_id);
      return;
    }

    // Splice out any dead===2 branch cards before re-walking the chains.
    this._spliceBranchDeaths(this._upChain,   stacked_up_children,   true);
    this._spliceBranchDeaths(this._downChain, stacked_down_children, false);

    // ── Ensure root card exists ───────────────────────────────────────────
    if (!this._rootCard) {
      this._rootCard = new Card({ titleHeight: this._titleHeight });
      this.addLayoutChild(this._rootCard);
    }

    // ── Resolve branches (stops at dead>=1 cards) ─────────────────────────
    const upChain   = this._walkBranch(stacked_up_children);
    const downChain = this._walkBranch(stacked_down_children);

    const chainChanged = !this._arraysEqual(this._upChain, upChain)
                      || !this._arraysEqual(this._downChain, downChain);

    if (!this._arraysEqual(this._upChain, upChain)) {
      this._syncBranch(upChain.length, this._upCards);
      this._upChain = upChain;
    }
    if (!this._arraysEqual(this._downChain, downChain)) {
      this._syncBranch(downChain.length, this._downCards);
      this._downChain = downChain;
    }

    if (chainChanged && !this._ignoreDragState) {
      syncStackActions(
        this._rootCardId,
        [this._rootCardId, ...upChain],
        [this._rootCardId, ...downChain],
        soul_id,
      );
    }

    // Register/unregister listeners for the full current chain.
    this._syncChainListeners(new Set([this._rootCardId, ...upChain, ...downChain]));

    this._growRect(upChain, downChain);

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
  private _growRect(upChain: CardId[], downChain: CardId[]): void {
    if (this._rootCardId === 0) {
      this.outerRect.y      = 0;
      this.outerRect.height = 0;
      this.innerRect.y      = 0;
      this.innerRect.height = 0;
      return;
    }
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
   * dying/dead cards (dead >= 1), dragging/animating cards (unless
   * ignoreDragState), or MAX_STACK_DEPTH.
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
      if (!card || card.dead >= 2) break;
      if (!this._ignoreDragState && (card.dragging || card.animating)) break;
      seen.add(next);
      chain.push(next);
      current = next;
    }

    return chain;
  }

  /** Move a card to the soul's inventory; its stacked children follow. Tweens visually if DragManager is available. */
  private _returnToInventory(card_id: CardId, depthFromRoot = 0, upChain = false): void {
    if (!client_cards[card_id]) return;
    const root = client_cards[this._rootCardId];
    let micro: number;
    if (root?.surface === SURFACE_PANEL && root.panel_card_id === soul_id) {
      const dy = depthFromRoot * this._titleHeight * (upChain ? -1 : 1);
      micro = packMicroPixel(root.pixel_x, root.pixel_y + dy);
    } else {
      micro = DragManager.getInstance()?.randomInventoryMicro() ?? packMicroPixel(0, 0);
    }
    orphaned_roots.add(card_id);
    moveClientCard(card_id, packMacroPanel(soul_id, 1), micro);
    spacetime.notifyCardListeners(card_id);

    const dm = DragManager.getInstance();
    if (dm) {
      const center = this.toGlobal(new Point(
        this.innerRect.x + this.innerRect.width  / 2,
        this.innerRect.y + this.innerRect.height / 2,
      ));
      dm.beginReturnTween(card_id, center.x, center.y);
    }
  }

  /** For each dead===2 card in a previous chain, splice its children onto the predecessor then finalize. */
  private _spliceBranchDeaths(chain: CardId[], index: Map<CardId, Set<CardId>>, upChain: boolean): void {
    for (let i = 0; i < chain.length; i++) {
      const id = chain[i];
      if (client_cards[id]?.dead !== 2) continue;
      const predecessorId = i === 0 ? this._rootCardId : chain[i - 1];
      for (const child of (index.get(id) ?? [])) this._spliceChild(child, predecessorId, upChain);
      spacetime.finalizeCardRemoval(id);
    }
  }

  /** Re-parent a child onto a new parent after its old parent dies, syncing to the server. */
  private _spliceChild(childId: CardId, newParentId: CardId, upChain: boolean): void {
    const child     = client_cards[childId];
    const newParent = client_cards[newParentId];
    if (!child || !newParent) {
      this._returnToInventory(childId, 0, upChain);
      return;
    }

    if (upChain) stackClientCardUp(childId, newParentId);
    else         stackClientCardDown(childId, newParentId);

    const flag     = upChain ? CARD_FLAG_STACKED_UP : CARD_FLAG_STACKED_DOWN;
    const newFlags = (child.flags & ~(CARD_FLAG_STACKED_UP | CARD_FLAG_STACKED_DOWN)) | flag;
    spacetime.setCardPositions(
      [childId],
      [newParent.macro_location],
      [packMicroStacked(newParentId)],
      [newFlags],
    );
  }

  /** When the root dies, send its direct branch children back to inventory. */
  private _detachBranchChildren(rootId: CardId, index: Map<CardId, Set<CardId>>, upChain: boolean): void {
    for (const child of (index.get(rootId) ?? [])) this._returnToInventory(child, 1, upChain);
  }

  /** Keep _chainUnlistens in sync with the set of active chain card IDs. */
  private _syncChainListeners(activeIds: Set<CardId>): void {
    for (const [id, unlisten] of this._chainUnlistens) {
      if (!activeIds.has(id)) { unlisten(); this._chainUnlistens.delete(id); }
    }
    for (const id of activeIds) {
      if (!this._chainUnlistens.has(id)) {
        this._chainUnlistens.set(id, spacetime.registerCardListener(id, () => this.invalidateLayout()));
      }
    }
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

  /** Remove all cards, clear all chain listeners, and reset rect. */
  private _clearAll(): void {
    for (const unlisten of this._chainUnlistens.values()) unlisten();
    this._chainUnlistens.clear();

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
  // dragging/animating state — the goal is the true data leaf, not where a
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
