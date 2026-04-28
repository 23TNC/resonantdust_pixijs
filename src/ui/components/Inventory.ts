import { Graphics } from "pixi.js";
import {
  client_cards,
  macro_location_cards,
  moveClientCard,
  packMacroPanel,
  packMicroPixel,
  type CardId,
} from "@/spacetime/Data";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import { type InputManager, type InputKeyData } from "@/ui/input/InputManager";
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
  /** When provided, holding gridSnapKey pulls stacks toward grid points. */
  input?:           InputManager;
  /** KeyboardEvent.key (compared case-insensitively). Default: "e". */
  gridSnapKey?:     string;
  /** Grid cell width in inventory pixel space. Default: stackWidth. */
  gridCellWidth?:   number;
  /** Grid cell height in inventory pixel space. Default: cardHeight. */
  gridCellHeight?:  number;
  /** Fraction of remaining distance covered per frame while snapping. Default: 0.15. */
  gridSnapRate?:    number;
  /** Grid line color when visible. Default: 0xffffff. */
  gridColor?:       number;
  /** Peak alpha while gridSnapKey is held. Default: 0.25. */
  gridMaxAlpha?:    number;
  /** Pixel width of the grid lines. Default: 1. */
  gridLineWidth?:   number;
  /** Lerp fraction toward target alpha each redraw (in/out fade speed). Default: 0.18. */
  gridFadeRate?:    number;
}

const DEFAULT_TITLE_H     = 24;
const DEFAULT_CARD_H      = 120;
const DEFAULT_STACK_W     = 80;
const DEFAULT_PUSH_RATE   = 0.25;
const DEFAULT_Z           = 1; // inventory surface
const DEFAULT_SNAP_KEY    = "e";
const DEFAULT_SNAP_RATE   = 0.15;
const DEFAULT_GRID_COLOR  = 0xffffff;
const DEFAULT_GRID_ALPHA  = 0.25;
const DEFAULT_GRID_LINE   = 1;
const DEFAULT_GRID_FADE   = 0.18;
const GRID_FADE_THRESHOLD = 0.005;

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

  private readonly _input:          InputManager | null;
  private readonly _gridSnapKey:    string;
  private readonly _gridCellWidth:  number;
  private readonly _gridCellHeight: number;
  private readonly _gridSnapRate:   number;
  private          _snapping = false;

  // Visual snap-grid overlay.
  private readonly _gridColor:     number;
  private readonly _gridMaxAlpha:  number;
  private readonly _gridLineWidth: number;
  private readonly _gridFadeRate:  number;
  private          _gridAlpha    = 0;
  private readonly _gridGraphics = new Graphics();

  private readonly _stacks:   Map<CardId, CardStack>                 = new Map();
  private readonly _floatPos: Map<CardId, { x: number; y: number }> = new Map();

  private readonly _boundKeyDown: (data: InputKeyData) => void;
  private readonly _boundKeyUp:   (data: InputKeyData) => void;

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

    this._input          = options.input ?? null;
    this._gridSnapKey    = (options.gridSnapKey ?? DEFAULT_SNAP_KEY).toLowerCase();
    this._gridCellWidth  = options.gridCellWidth  ?? this._stackWidth;
    this._gridCellHeight = options.gridCellHeight ?? this._cardHeight;
    this._gridSnapRate   = options.gridSnapRate   ?? DEFAULT_SNAP_RATE;

    this._gridColor      = options.gridColor      ?? DEFAULT_GRID_COLOR;
    this._gridMaxAlpha   = options.gridMaxAlpha   ?? DEFAULT_GRID_ALPHA;
    this._gridLineWidth  = options.gridLineWidth  ?? DEFAULT_GRID_LINE;
    this._gridFadeRate   = options.gridFadeRate   ?? DEFAULT_GRID_FADE;
    // addDisplay places the grid below all layout children (CardStacks),
    // so cards always render on top of it.
    this.addDisplay(this._gridGraphics);

    this._boundKeyDown = this._onKeyDown.bind(this);
    this._boundKeyUp   = this._onKeyUp.bind(this);
    if (this._input) {
      this._input.on("key_down", this._boundKeyDown);
      this._input.on("key_up",   this._boundKeyUp);
    }
  }

  override destroy(options?: Parameters<LayoutObject["destroy"]>[0]): void {
    if (this._input) {
      this._input.off("key_down", this._boundKeyDown);
      this._input.off("key_up",   this._boundKeyUp);
    }
    super.destroy(options);
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
   * Per-frame simulation: pairwise push-separation always runs (when there
   * are at least two stacks), and grid-snap runs while the configured key
   * is held.  If anything moved, clamp + write back + invalidate so the
   * next frame iterates again.  The simulation settles naturally — push
   * stops when no pair overlaps, snap stops when each stack is on a grid
   * point — both honour the same arrive threshold via abs<0.5 inside the
   * inner methods.
   */
  protected override redraw(): void {
    let moved = false;
    if (this._stacks.size >= 2 && this._push()) moved = true;
    if (this._snapping && this._snap())         moved = true;
    if (moved) {
      this._clamp();
      this._writeBack();
      this.invalidateLayout();
    }
    this._tickGrid();
  }

  /**
   * Step the grid overlay's alpha toward its target (max while snapping, 0
   * otherwise) and redraw it.  Self-schedules via invalidateRender until the
   * fade has settled.
   */
  private _tickGrid(): void {
    const target = this._snapping ? this._gridMaxAlpha : 0;
    const diff   = target - this._gridAlpha;
    if (Math.abs(diff) > GRID_FADE_THRESHOLD) {
      this._gridAlpha += diff * this._gridFadeRate;
      this.invalidateRender();
    } else if (this._gridAlpha !== target) {
      this._gridAlpha = target;
      this.invalidateRender();
    }
    this._drawGrid();
  }

  /**
   * Repaint the grid lines.  Uses inventory innerRect for bounds and the
   * gridCellWidth/Height for spacing, anchored so cell centres align with the
   * snap targets used by _snap (multiples of cellW/cellH from the inventory
   * centre).  No-op when alpha is fully faded.
   */
  private _drawGrid(): void {
    const g = this._gridGraphics;
    g.clear();
    if (this._gridAlpha <= 0) return;

    const left   = this.innerRect.x;
    const top    = this.innerRect.y;
    const right  = left + this.innerRect.width;
    const bottom = top  + this.innerRect.height;
    if (right <= left || bottom <= top) return;

    const cx    = (left + right)  / 2;
    const cy    = (top  + bottom) / 2;
    const cellW = this._gridCellWidth;
    const cellH = this._gridCellHeight;

    // Vertical lines fall halfway between adjacent cell centres
    // (cell centres are at cx + n*cellW; boundaries at cx + (n + 0.5)*cellW).
    const baseX  = cx + cellW / 2;
    const firstX = left + (((baseX - left) % cellW) + cellW) % cellW;
    for (let x = firstX; x <= right; x += cellW) {
      g.moveTo(x, top);
      g.lineTo(x, bottom);
    }

    const baseY  = cy + cellH / 2;
    const firstY = top + (((baseY - top) % cellH) + cellH) % cellH;
    for (let y = firstY; y <= bottom; y += cellH) {
      g.moveTo(left,  y);
      g.lineTo(right, y);
    }

    g.stroke({
      color: this._gridColor,
      width: this._gridLineWidth,
      alpha: this._gridAlpha,
    });

    // Keep the redraw cycle alive while the grid is on screen so the fade
    // animation continues frame-to-frame even when nothing else is dirtying
    // this node (e.g. the user holds E with a quiet inventory, or releases
    // E and we need a few more frames to fade out from peak alpha to zero).
    this.invalidateRender();
  }

  // ─── Key handlers ────────────────────────────────────────────────────────

  private _onKeyDown(data: InputKeyData): void {
    if (data.key.toLowerCase() !== this._gridSnapKey) return;
    if (this._snapping) return;
    this._snapping = true;
    // Kick the simulation in case nothing else is currently invalidating.
    this.invalidateLayout();
  }

  private _onKeyUp(data: InputKeyData): void {
    if (data.key.toLowerCase() !== this._gridSnapKey) return;
    this._snapping = false;
  }

  /**
   * One pass of grid-snap.  Each stack's float position is lerped toward
   * the nearest grid point by gridSnapRate.  Returns true if any stack
   * moved by more than 0.5 px, so redraw can decide to keep iterating.
   */
  private _snap(): boolean {
    if (this._stacks.size === 0) return false;
    const cellW = this._gridCellWidth;
    const cellH = this._gridCellHeight;
    const rate  = this._gridSnapRate;
    let moved = false;
    for (const pos of this._floatPos.values()) {
      const targetX = Math.round(pos.x / cellW) * cellW;
      const targetY = Math.round(pos.y / cellH) * cellH;
      const dx = targetX - pos.x;
      const dy = targetY - pos.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      pos.x += dx * rate;
      pos.y += dy * rate;
      moved = true;
    }
    return moved;
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
    const entries = [...this._stacks.entries()];
    const n       = entries.length;
    let moved     = false;

    const halfW = entries.map(() => this._stackWidth / 2);
    const halfH = entries.map(([, stack]) => stack.outerRect.height / 2);
    // pos.y is the root-card centre.  For an asymmetric stack (up-only or
    // down-only branch), the AABB centre is offset from the root: above for
    // an up-branch, below for a down-branch.  centreY[i] is that offset, so
    // (pos.y + centreY[i]) is the actual AABB centre y in inventory space.
    const centreY = entries.map(([, stack]) =>
      stack.outerRect.y + stack.outerRect.height / 2 - this._cardHeight / 2
    );

    for (let i = 0; i < n - 1; i++) {
      const pi = this._floatPos.get(entries[i][0])!;
      for (let j = i + 1; j < n; j++) {
        const pj = this._floatPos.get(entries[j][0])!;

        const dx = pj.x - pi.x;
        const dy = (pj.y + centreY[j]) - (pi.y + centreY[i]);
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

  /** Clamp all float positions so each stack's full visual AABB stays within innerRect. */
  private _clamp(): void {
    const hw = this.innerRect.width  / 2;
    const hh = this.innerRect.height / 2;
    const hch = this._cardHeight / 2;

    for (const [id, pos] of this._floatPos) {
      const stack    = this._stacks.get(id);
      // stackTop/stackBot are in CardStack local space relative to its container origin.
      // Container origin is placed at pos.y - cardHeight/2 by updateLayoutChildren.
      const stackTop = stack?.outerRect.y                                           ?? 0;
      const stackBot = stack ? stack.outerRect.y + stack.outerRect.height : this._cardHeight;
      pos.x = Math.max(-hw + this._stackWidth / 2, Math.min(hw - this._stackWidth / 2, pos.x));
      pos.y = Math.max(-hh + hch - stackTop, Math.min(hh + hch - stackBot, pos.y));
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
