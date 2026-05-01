import { Point } from "pixi.js";
import {
  client_cards,
  type CardId,
  type MicroLocation,
} from "@/spacetime/Data";
import { isAnimating, isDragging, setAnimating } from "@/model/CardModel";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import { CardStack } from "./CardStack";
import { Inventory } from "./Inventory";

const DEFAULT_TITLE_H        = 24;
const DEFAULT_CARD_H         = 120;
const DEFAULT_STACK_W        = 80;
const DEFAULT_LERP           = 0.18;
const DEFAULT_RETURN_LERP    = 0.25;
const ARRIVE_THRESHOLD       = 0.5;
const DEFAULT_GAP_MIN        = -6;
const DEFAULT_GAP_SHRINK     = 0.18;
const GAP_SETTLE_THRESHOLD   = 0.05;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * References cached at drag start so the source's parent chain can be
 * invalidated when the drag completes.  Each may become destroyed mid-drag,
 * so every use is guarded by `.destroyed`.
 */
export interface SourceCache {
  hitCard:      LayoutObject;
  hitStack:     CardStack;
  hitContainer: LayoutObject | null;
}

interface Entry {
  stack:        CardStack;
  /** Current rendered position of the root card's centre, in screen space. */
  x:            number;
  y:            number;
  /** Cursor → root-centre offset captured on pickup. */
  grabOffsetX:  number;
  grabOffsetY:  number;
  /** Pickup-time origin — used as returnTarget for invalid drops. */
  returnOrigin: { x: number; y: number };
  /** null while following the cursor; set to a point while animating. */
  returnTarget: { x: number; y: number } | null;
  /**
   * View to invalidate when the tween completes so it picks up the now-
   * committed card.  null for invalid drops (default cleanup is sufficient).
   */
  destination:  LayoutObject | null;
  /** null for programmatic return tweens (no drag source to poke). */
  source:       SourceCache | null;
}

export interface AddEntryArgs {
  x:           number;
  y:           number;
  grabOffsetX: number;
  grabOffsetY: number;
  source:      SourceCache;
}

export interface DragOverlayOptions extends LayoutObjectOptions {
  titleHeight?: number;
  cardHeight?:  number;
  stackWidth?:  number;
  /** Lerp factor while following the cursor. Default: 0.18. */
  lerpFactor?:  number;
  /** Lerp factor while animating toward returnTarget. Default: 0.25. */
  returnLerp?:  number;
  /** Minimum titleGap an overlay stack shrinks toward while dragging. Default: 0. */
  gapMinimum?:    number;
  /** Lerp fraction toward gapMinimum applied each redraw. Default: 0.18. */
  gapShrinkRate?: number;
}

/**
 * Pure visual overlay for cards currently being dragged or animating back to
 * a destination.  Owns the entry pool, per-frame cursor lerp, return-target
 * tween, and title-gap shrink animation.
 *
 * Game-rule logic (which targets accept which cards, what to do on drop)
 * lives in DragController.  DragOverlay only knows how to render and tween;
 * it never reads game state beyond `card.dragging` / `card.animating`.
 */
export class DragOverlay extends LayoutObject {
  private static _instance: DragOverlay | null = null;
  static getInstance(): DragOverlay | null { return DragOverlay._instance; }

  private readonly _titleHeight:   number;
  private readonly _cardHeight:    number;
  private readonly _stackWidth:    number;
  private readonly _lerpFactor:    number;
  private readonly _returnLerp:    number;
  private readonly _gapMinimum:    number;
  private readonly _gapShrinkRate: number;

  private _inventory: Inventory | null = null;

  private readonly _entries = new Map<CardId, Entry>();

  // Latest cursor position, screen space.
  private _cursorX = 0;
  private _cursorY = 0;

  constructor(options: DragOverlayOptions = {}) {
    super(options);
    DragOverlay._instance = this;
    this._titleHeight   = options.titleHeight   ?? DEFAULT_TITLE_H;
    this._cardHeight    = options.cardHeight    ?? DEFAULT_CARD_H;
    this._stackWidth    = options.stackWidth    ?? DEFAULT_STACK_W;
    this._lerpFactor    = options.lerpFactor    ?? DEFAULT_LERP;
    this._returnLerp    = options.returnLerp    ?? DEFAULT_RETURN_LERP;
    this._gapMinimum    = options.gapMinimum    ?? DEFAULT_GAP_MIN;
    this._gapShrinkRate = options.gapShrinkRate ?? DEFAULT_GAP_SHRINK;
  }

  override destroy(options?: Parameters<LayoutObject["destroy"]>[0]): void {
    if (DragOverlay._instance === this) DragOverlay._instance = null;
    super.destroy(options);
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  setInventory(inventory: Inventory): void {
    this._inventory = inventory;
  }

  randomInventoryMicro(): MicroLocation | null {
    return this._inventory?.randomMicro() ?? null;
  }

  hasEntry(rootId: CardId): boolean { return this._entries.has(rootId); }

  /** Snapshot of an entry's current screen position. Returns null if no entry. */
  getEntryPosition(rootId: CardId): { x: number; y: number } | null {
    const e = this._entries.get(rootId);
    return e ? { x: e.x, y: e.y } : null;
  }

  /** Set the cursor position the overlay's drag-tracking entries lerp toward. */
  setCursor(x: number, y: number): void {
    this._cursorX = x;
    this._cursorY = y;
    this.invalidateLayout();
  }

  getCursor(): { x: number; y: number } { return { x: this._cursorX, y: this._cursorY }; }

  /**
   * Begin a drag-tracking entry — the entry follows the cursor each frame
   * until DragController calls `setReturnTarget` or `setReturnToOrigin`.
   * No-op if an entry already exists for `rootId`.
   */
  addEntry(rootId: CardId, args: AddEntryArgs): void {
    if (this._entries.has(rootId)) return;
    const stack = new CardStack({
      titleHeight:     this._titleHeight,
      // Inherit the source stack's current gap so the overlay starts in
      // visual continuity with where the cards came from, then shrinks each
      // frame in redraw() toward _gapMinimum.
      titleGap:        args.source.hitStack.getTitleGap(),
      ignoreDragState: true,
    });
    stack.setCardId(rootId);
    this._entries.set(rootId, {
      stack,
      x:            args.x,
      y:            args.y,
      grabOffsetX:  args.grabOffsetX,
      grabOffsetY:  args.grabOffsetY,
      returnOrigin: { x: args.x, y: args.y },
      returnTarget: null,
      destination:  null,
      source:       args.source,
    });
    this.addLayoutChild(stack);
    this.invalidateLayout();
  }

  /**
   * Switch an existing entry from cursor-follow to a return tween toward a
   * destination point.  When the tween completes, `destination?.invalidateLayout()`
   * fires and the entry is torn down on the next layout pass (which sees the
   * card's `animating` flag cleared).
   */
  setReturnTarget(rootId: CardId, x: number, y: number, destination: LayoutObject | null): void {
    const entry = this._entries.get(rootId);
    if (!entry) return;
    entry.returnTarget = { x, y };
    entry.destination  = destination;
  }

  /** Send an entry back to its pickup origin (used for invalid drops). */
  setReturnToOrigin(rootId: CardId): void {
    const entry = this._entries.get(rootId);
    if (!entry) return;
    entry.returnTarget = { x: entry.returnOrigin.x, y: entry.returnOrigin.y };
    entry.destination  = null;
  }

  /**
   * Tween a card from screen position (fromX, fromY) to its committed
   * inventory pixel_x/pixel_y position.  Used by CardStack._returnToInventory
   * to animate orphaned cards into their new home.  Sets card.animating;
   * clears it when the tween arrives and invalidates the inventory so it
   * picks up the card.
   */
  beginReturnTween(cardId: CardId, fromX: number, fromY: number): void {
    const card = client_cards[cardId];
    if (!card || !this._inventory) return;
    if (this._entries.has(cardId)) return;

    const inv = this._inventory;
    const cx  = inv.innerRect.x + inv.innerRect.width  / 2;
    const cy  = inv.innerRect.y + inv.innerRect.height / 2;
    const dst = inv.toGlobal(new Point(cx + card.pixel_x, cy + card.pixel_y));

    const stack = new CardStack({
      titleHeight:     this._titleHeight,
      titleGap:        this._gapMinimum,
      ignoreDragState: true,
    });
    stack.setCardId(cardId);

    setAnimating(cardId, true);
    this._entries.set(cardId, {
      stack,
      x:            fromX,
      y:            fromY,
      grabOffsetX:  0,
      grabOffsetY:  0,
      returnOrigin: { x: fromX, y: fromY },
      returnTarget: { x: dst.x, y: dst.y },
      destination:  inv,
      source:       null,
    });
    this.addLayoutChild(stack);
    this.invalidateLayout();
  }

  // ─── Hit test ────────────────────────────────────────────────────────────

  /** Overlay is non-interactive — clicks pass through to the layer below. */
  override hitTestLayout(): LayoutObject | null { return null; }

  // ─── Layout ──────────────────────────────────────────────────────────────

  protected override updateLayoutChildren(): void {
    for (const [rootId, entry] of this._entries) {
      if (!isDragging(rootId) && !isAnimating(rootId)) {
        this._removeEntry(rootId, entry);
        continue;
      }
      entry.stack.setLayout(
        entry.x - this._stackWidth / 2,
        entry.y - this._cardHeight / 2,
        this._stackWidth,
        this._cardHeight,
      );
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  protected override redraw(): void {
    if (this._entries.size === 0) return;

    let moved = false;
    const completed: CardId[] = [];

    for (const [rootId, entry] of this._entries) {
      // Title gap shrink — independent of position settling, so the gap
      // continues to compact even after the cards have caught up to the
      // cursor.  Uses exponential approach toward _gapMinimum.
      const currentGap = entry.stack.getTitleGap();
      if (currentGap > this._gapMinimum + GAP_SETTLE_THRESHOLD) {
        const nextGap = currentGap + (this._gapMinimum - currentGap) * this._gapShrinkRate;
        entry.stack.setTitleGap(nextGap);
        moved = true;
      }

      const tx = entry.returnTarget
        ? entry.returnTarget.x
        : this._cursorX - entry.grabOffsetX;
      const ty = entry.returnTarget
        ? entry.returnTarget.y
        : this._cursorY - entry.grabOffsetY;

      const dx = tx - entry.x;
      const dy = ty - entry.y;

      if (Math.abs(dx) < ARRIVE_THRESHOLD && Math.abs(dy) < ARRIVE_THRESHOLD) {
        entry.x = tx;
        entry.y = ty;
        if (entry.returnTarget) completed.push(rootId);
        continue;
      }

      const f = entry.returnTarget ? this._returnLerp : this._lerpFactor;
      entry.x += dx * f;
      entry.y += dy * f;
      moved = true;
    }

    for (const rootId of completed) this._finishAnim(rootId);
    if (moved) this.invalidateLayout();
  }

  // ─── Tween completion ────────────────────────────────────────────────────

  private _finishAnim(rootId: CardId): void {
    const entry = this._entries.get(rootId);
    if (!entry) return;
    if (client_cards[rootId]) setAnimating(rootId, false);
    if (entry.source) {
      if (!entry.source.hitCard.destroyed)                                  entry.source.hitCard.invalidateLayout();
      if (!entry.source.hitStack.destroyed)                                 entry.source.hitStack.invalidateLayout();
      if (entry.source.hitContainer && !entry.source.hitContainer.destroyed) entry.source.hitContainer.invalidateLayout();
    }
    if (entry.destination && !entry.destination.destroyed) {
      entry.destination.invalidateLayout();
    }
    // Animating flag cleared — schedule a layout pass so updateLayoutChildren
    // removes the entry promptly rather than waiting for an unrelated invalidation.
    this.invalidateLayout();
  }

  // ─── Entry lifecycle ─────────────────────────────────────────────────────

  private _removeEntry(rootId: CardId, entry: Entry): void {
    if (!this._entries.has(rootId)) return;
    this._entries.delete(rootId);
    this.removeLayoutChild(entry.stack);
    if (!entry.stack.destroyed) entry.stack.destroy({ children: true });
  }
}
