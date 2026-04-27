import {
  client_cards,
  macro_location_cards,
  moveClientCard,
  packMacroPanel,
  packMicroPixel,
  type CardId,
} from "@/spacetime/Data";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import { CardStack } from "./CardStack";

export interface InventoryOptions extends LayoutObjectOptions {
  observer_id:   CardId;
  viewed_id:     CardId;
  card_types:    number[];
  /** z layer that identifies this surface type. 1 = inventory (default). */
  z?:            number;
  titleHeight?:  number;
  cardHeight?:   number;
  stackWidth?:   number;
  pushRate?:     number;
}

const DEFAULT_TITLE_H   = 24;
const DEFAULT_CARD_H    = 120;
const DEFAULT_STACK_W   = 80;
const DEFAULT_PUSH_RATE = 0.25;
const DEFAULT_Z         = 1; // inventory surface

/**
 * Displays and manages CardStack objects for cards at a soul's panel.
 *
 * Only cards that pass all of these filters are shown:
 *   • macro_location === packMacroPanel(viewed_id, z)
 *   • dragging === false
 *   • returning === false
 *   • not stacked (stacked_up === false && stacked_down === false)
 *   • card_type is in the provided card_types set
 *
 * Reconciliation (add/remove stacks) happens in updateLayoutChildren so that
 * any invalidateLayout() — including those triggered by flag mutations like
 * dragging/returning — automatically keeps the displayed set consistent.
 */
export class Inventory extends LayoutObject {
  private readonly _observerId:  CardId;
  private          _viewedId:    CardId;
  private readonly _cardTypeSet: Set<number>;
  private readonly _z:           number;
  private readonly _titleHeight: number;
  private readonly _cardHeight:  number;
  private readonly _stackWidth:  number;
  private readonly _pushRate:    number;

  private readonly _stacks:   Map<CardId, CardStack>                 = new Map();
  private readonly _floatPos: Map<CardId, { x: number; y: number }> = new Map();

  constructor(options: InventoryOptions) {
    super({ hitSelf: true, ...options });
    this._observerId  = options.observer_id;
    this._viewedId    = options.viewed_id;
    this._cardTypeSet = new Set(options.card_types);
    this._z           = options.z           ?? DEFAULT_Z;
    this._titleHeight = options.titleHeight ?? DEFAULT_TITLE_H;
    this._cardHeight  = options.cardHeight  ?? DEFAULT_CARD_H;
    this._stackWidth  = options.stackWidth  ?? DEFAULT_STACK_W;
    this._pushRate    = options.pushRate    ?? DEFAULT_PUSH_RATE;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  setViewedId(viewedId: CardId): void {
    if (this._viewedId === viewedId) return;
    this._viewedId = viewedId;
    this.invalidateLayout();
  }

  getViewedId(): CardId { return this._viewedId; }
  getObserverId(): CardId { return this._observerId; }

  // ─── Layout ──────────────────────────────────────────────────────────────

  /**
   * Reconcile stacks with current client_cards state, then clamp and place.
   * Runs on every layout pass so flag mutations (dragging, returning) are
   * picked up automatically without external sync calls.
   */
  protected override updateLayoutChildren(): void {
    const roots = this._findRoots();

    // Remove stacks that no longer qualify.
    for (const [rootId, stack] of this._stacks) {
      if (!roots.has(rootId)) {
        this._stacks.delete(rootId);
        this._floatPos.delete(rootId);
        this.removeLayoutChild(stack);
        stack.destroy({ children: true });
      }
    }

    // Add stacks for newly qualifying roots.
    for (const rootId of roots) {
      if (!this._stacks.has(rootId)) {
        const card  = client_cards[rootId];
        const stack = new CardStack({ titleHeight: this._titleHeight });
        stack.setCardId(rootId);
        this._stacks.set(rootId, stack);
        this._floatPos.set(rootId, {
          x: card?.pixel_x ?? 0,
          y: card?.pixel_y ?? 0,
        });
        this.addLayoutChild(stack);
      }
    }

    if (this.innerRect.width > 0 && this.innerRect.height > 0) {
      this._clamp();
    }

    const cx = this.innerRect.x + this.innerRect.width  / 2;
    const cy = this.innerRect.y + this.innerRect.height / 2;

    for (const [rootId, stack] of this._stacks) {
      const pos = this._floatPos.get(rootId);
      if (!pos) continue;
      stack.setLayout(
        cx + pos.x - this._stackWidth / 2,
        cy + pos.y - this._cardHeight / 2,
        this._stackWidth,
        this._cardHeight,
      );
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  /**
   * Run one push-separation step.  If any stack moved, clamp, write back, and
   * invalidate layout so the next frame runs another pass.  The loop terminates
   * naturally once no pair overlaps.
   */
  protected override redraw(): void {
    if (this._stacks.size < 2) return;
    if (this._push()) {
      this._clamp();
      this._writeBack();
      this.invalidateLayout();
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _findRoots(): Set<CardId> {
    const roots = new Set<CardId>();
    const ids   = macro_location_cards.get(packMacroPanel(this._viewedId, this._z));
    if (!ids) return roots;

    for (const card_id of ids) {
      const card = client_cards[card_id];
      if (!card)                                continue;
      if (card.dragging)                        continue;
      if (card.returning)                       continue;
      if (card.stacked_up || card.stacked_down) continue;
      if (!this._cardTypeSet.has(card.card_type)) continue;
      roots.add(card_id);
    }

    return roots;
  }

  /**
   * One pairwise AABB push iteration.  Each overlapping pair is separated
   * along the centroid-to-centroid axis; speed is proportional to the smaller
   * overlap dimension so barely-touching stacks move slowly and deeply nested
   * ones separate quickly.  Returns true if any stack moved.
   */
  private _push(): boolean {
    const ids  = [...this._stacks.keys()];
    const n    = ids.length;
    let moved  = false;

    const halfW = ids.map(() => this._stackWidth / 2);
    const halfH = ids.map(_id => this._cardHeight / 2);

    for (let i = 0; i < n - 1; i++) {
      const pi = this._floatPos.get(ids[i])!;
      for (let j = i + 1; j < n; j++) {
        const pj = this._floatPos.get(ids[j])!;

        const dx = pj.x - pi.x;
        const dy = pj.y - pi.y;
        const ox = halfW[i] + halfW[j] - Math.abs(dx);
        const oy = halfH[i] + halfH[j] - Math.abs(dy);

        if (ox <= 0 || oy <= 0) continue;

        const speed = Math.min(ox, oy) * this._pushRate * 0.5;
        const dist  = Math.sqrt(dx * dx + dy * dy);
        const nx    = dist < 0.001 ? 1 : dx / dist;
        const ny    = dist < 0.001 ? 0 : dy / dist;

        pi.x -= nx * speed;
        pi.y -= ny * speed;
        pj.x += nx * speed;
        pj.y += ny * speed;
        moved = true;
      }
    }

    return moved;
  }

  /** Clamp all float positions so each stack's AABB stays within innerRect. */
  private _clamp(): void {
    const hw = this.innerRect.width  / 2;
    const hh = this.innerRect.height / 2;

    for (const [id, pos] of this._floatPos) {
      const sHW = this._stackWidth / 2;
      pos.x = Math.max(-hw + sHW, Math.min(hw - sHW, pos.x));
      pos.y = Math.max(-hh + this._cardHeight / 2, Math.min(hh - this._cardHeight / 2, pos.y));
    }
  }

  /** Round float positions to integers and write pixel_x/pixel_y back into client_cards. */
  private _writeBack(): void {
    const macro = packMacroPanel(this._viewedId, this._z);
    for (const [id, pos] of this._floatPos) {
      const card = client_cards[id];
      if (!card) continue;
      const newX = Math.round(pos.x);
      const newY = Math.round(pos.y);
      if (newX === card.pixel_x && newY === card.pixel_y) continue;
      moveClientCard(id, macro, packMicroPixel(newX, newY));
    }
  }
}
