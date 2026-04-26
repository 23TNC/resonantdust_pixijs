import {
  client_cards,
  type CardId,
  packZone,
  updateClientCardLocation,
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

const MAX_CHAIN_DEPTH   = 64;
const DEFAULT_TITLE_H   = 24;
const DEFAULT_CARD_H    = 120;
const DEFAULT_STACK_W   = 80;
const DEFAULT_PUSH_RATE = 0.25;
const DEFAULT_Z         = 1; // inventory surface

/**
 * Displays and manages CardStack objects for cards owned by a given soul.
 *
 * Only cards that pass all of these filters are shown:
 *   • soul_id === viewed_id
 *   • z === the configured z layer (1 = inventory surface, default)
 *   • dragging === false
 *   • returning === false
 *   • world_flag === false
 *   • not the sentinel position (zone_q === -1 && zone_r === -1 && local_q === 0 && local_r === 0)
 *   • card_type is in the provided card_types set
 *   • not a link target of another qualifying card (so each chain shows once)
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
    super(options);
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
          x: card?.zone_q ?? 0,
          y: card?.zone_r ?? 0,
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
      const n  = this._chainLength(rootId);
      const sh = this._cardHeight + (n - 1) * this._titleHeight;
      stack.setLayout(
        cx + pos.x - this._stackWidth / 2,
        cy + pos.y - this._cardHeight / 2,
        this._stackWidth,
        sh,
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

  /**
   * Run the push simulation synchronously until no overlaps remain or the
   * iteration cap is reached, then clamp and write back.  Used to settle
   * initial positions before the first render pass.
   */
  private _findRoots(): Set<CardId> {
    const candidates = new Set<CardId>();

    for (const key in client_cards) {
      const card = client_cards[Number(key) as CardId];
      if (!card) continue;
      if (card.soul_id !== this._viewedId)    continue;
      if (card.z       !== this._z)            continue;
      if (card.dragging)                       continue;
      if (card.returning)                      continue;
      if (card.world_flag)                     continue;
      if (card.stacked) continue;
      if (!this._cardTypeSet.has(card.card_type)) continue;
      candidates.add(card.card_id);
    }

    return candidates;
  }

  private _chainLength(rootId: CardId): number {
    let n = 0;
    const seen = new Set<CardId>();
    let current = rootId;
    while (current !== 0 && n < MAX_CHAIN_DEPTH) {
      if (seen.has(current)) break;
      const card = client_cards[current];
      if (card?.dragging || card?.returning) break;
      seen.add(current);
      n++;
      if (!card || !card.stackable || card.link_id === 0) break;
      const next = client_cards[card.link_id];
      if (!next?.stacked) break;
      current = card.link_id;
    }
    return n;
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
    const halfH = ids.map(id => {
      const len = this._chainLength(id);
      return (this._cardHeight + (len - 1) * this._titleHeight) / 2;
    });

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
      const len = this._chainLength(id);
      const sh  = this._cardHeight + (len - 1) * this._titleHeight;
      pos.x = Math.max(-hw + sHW, Math.min(hw - sHW, pos.x));
      pos.y = Math.max(-hh + this._cardHeight / 2, Math.min(hh + this._cardHeight / 2 - sh, pos.y));
    }
  }

  /**
   * Round float positions to integers and write zone_q / zone_r back into
   * client_cards via updateClientCardLocation so other systems see the move.
   */
  private _writeBack(): void {
    for (const [id, pos] of this._floatPos) {
      const card = client_cards[id];
      if (!card) continue;
      const newQ = Math.round(pos.x);
      const newR = Math.round(pos.y);
      if (newQ === card.zone_q && newR === card.zone_r) continue;
      updateClientCardLocation(id, packZone(newQ, newR, card.z), card.position);
    }
  }
}
