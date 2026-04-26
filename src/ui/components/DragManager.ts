import { Point } from "pixi.js";
import {
  client_cards,
  parseCardFlags,
  type CardId,
} from "@/spacetime/Data";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import {
  type InputManager,
  type InputPointerData,
  type InputDragMoveData,
  type InputActionData,
} from "@/ui/input/InputManager";
import { Card } from "./Card";
import { CardStack } from "./CardStack";

const MAX_CHAIN_DEPTH = 64;
const DEFAULT_TITLE_H = 24;
const DEFAULT_CARD_H  = 120;
const DEFAULT_STACK_W = 80;

// ─── Types ────────────────────────────────────────────────────────────────────

interface StackEntry {
  stack:        CardStack;
  /** Current rendered center position in DragManager (= screen) space. */
  x:            number;
  y:            number;
  /**
   * Offset from the raw cursor to the card's center, captured at drag start.
   * Applied as (cursor - grabOffset) so the grab point stays under the cursor.
   */
  grabOffsetX:  number;
  grabOffsetY:  number;
  /** Inventory position captured at drag start — where to tween back to. */
  returnOrigin: { x: number; y: number };
  /**
   * null  → dragging: entry chases the throttled cursor target.
   * set   → returning: entry lerps toward this point, then cleans up.
   */
  returnTarget: { x: number; y: number } | null;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface DragManagerOptions extends LayoutObjectOptions {
  input:             InputManager;
  titleHeight?:      number;
  cardHeight?:       number;
  stackWidth?:       number;
  /** Fraction of remaining distance moved per frame. Default: 0.18. */
  lerpFactor?:       number;
  /** Milliseconds between cursor samples that update the tween target. Default: 100. */
  sampleIntervalMs?: number;
}

// ─── DragManager ─────────────────────────────────────────────────────────────

/**
 * Overlay that renders CardStacks for cards currently being dragged or
 * returning to their inventory position after an invalid drop.
 *
 * Placed in the "overlay" LayoutLayers slot so it renders above the game UI.
 * hitTestLayout always returns null so pointer events fall through — the
 * drag visuals are display-only.
 *
 * Drag flow:
 *   left_down       → capture hit target
 *   left_drag_start → if target is a Card with movable flags, begin drag
 *   left_drag_move  → update throttled cursor target; stack lerps toward it
 *   left_drag_end   → invalid drop → set returning, tween back to origin
 *   (converged)     → clear returning, call onSync so Inventory re-shows card
 */
export class DragManager extends LayoutObject {
  private readonly _input:          InputManager;
  private readonly _titleHeight:    number;
  private readonly _cardHeight:     number;
  private readonly _stackWidth:     number;
  private readonly _lerpFactor:     number;
  private readonly _sampleInterval: number;

  private readonly _entries = new Map<CardId, StackEntry>();

  // Raw cursor — updated every drag_move event.
  private _cursorX = 0;
  private _cursorY = 0;
  // Throttled tween target for dragging stacks.
  private _targetX    = 0;
  private _targetY    = 0;
  private _lastSample = 0;

  // Hit target captured on left_down; used to identify the dragged card.
  private _downTarget: LayoutObject | null = null;

  private readonly _boundDown:      (data: InputPointerData)  => void;
  private readonly _boundDragStart: (data: InputPointerData)  => void;
  private readonly _boundDragMove:  (data: InputDragMoveData) => void;
  private readonly _boundDragEnd:   (data: InputActionData)   => void;

  constructor(options: DragManagerOptions) {
    super(options);
    this._input          = options.input;
    this._titleHeight    = options.titleHeight    ?? DEFAULT_TITLE_H;
    this._cardHeight     = options.cardHeight     ?? DEFAULT_CARD_H;
    this._stackWidth     = options.stackWidth     ?? DEFAULT_STACK_W;
    this._lerpFactor     = options.lerpFactor     ?? 0.18;
    this._sampleInterval = options.sampleIntervalMs ?? 50;

    this._boundDown      = this._onDown.bind(this);
    this._boundDragStart = this._onDragStart.bind(this);
    this._boundDragMove  = this._onDragMove.bind(this);
    this._boundDragEnd   = this._onDragEnd.bind(this);

    this._input.on("left_down",       this._boundDown);
    this._input.on("left_drag_start", this._boundDragStart);
    this._input.on("left_drag_move",  this._boundDragMove);
    this._input.on("left_drag_end",   this._boundDragEnd);
  }

  override destroy(options?: Parameters<LayoutObject["destroy"]>[0]): void {
    this._input.off("left_down",       this._boundDown);
    this._input.off("left_drag_start", this._boundDragStart);
    this._input.off("left_drag_move",  this._boundDragMove);
    this._input.off("left_drag_end",   this._boundDragEnd);
    super.destroy(options);
  }

  // ─── Hit test ────────────────────────────────────────────────────────────

  /** Drag visuals are display-only — clicks pass through to the layer below. */
  override hitTestLayout(
    _globalX: number,
    _globalY: number,
    _ignore?: ReadonlySet<LayoutObject>,
  ): LayoutObject | null {
    return null;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Reconcile entries with current client_cards state.
   * Removes entries for cards that are neither dragging nor returning.
   * Adds entries for newly dragging cards not yet tracked (fallback for
   * external state changes; normal flow goes through _onDragStart).
   */
  sync(): void {
    for (const [rootId, entry] of this._entries) {
      const card = client_cards[rootId];
      if (!card || (!card.dragging && !card.returning)) {
        this._removeEntry(rootId, entry);
      }
    }

    for (const key in client_cards) {
      const card = client_cards[Number(key) as CardId];
      if (!card?.dragging) continue;
      if (this._entries.has(card.card_id)) continue;
      this._addEntry(card.card_id, this._cursorX, this._cursorY, this._cursorX, this._cursorY);
    }

    this.invalidateLayout();
  }

  // ─── Layout ──────────────────────────────────────────────────────────────

  protected override updateLayoutChildren(): void {
    const dead: CardId[] = [];

    for (const [rootId, entry] of this._entries) {
      const card = client_cards[rootId];
      if (!card?.dragging && !card?.returning) {
        dead.push(rootId);
        continue;
      }
      const n  = this._chainLength(rootId);
      const sh = this._cardHeight + (n - 1) * this._titleHeight;
      entry.stack.setLayout(
        entry.x - this._stackWidth / 2,
        entry.y - sh / 2,
        this._stackWidth,
        sh,
      );
    }

    for (const rootId of dead) {
      this._removeEntry(rootId, this._entries.get(rootId)!);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  protected override redraw(): void {
    if (this._entries.size === 0) return;

    let moved = false;
    const completed: CardId[] = [];

    for (const [rootId, entry] of this._entries) {
      const tx = entry.returnTarget
        ? entry.returnTarget.x
        : this._targetX - entry.grabOffsetX;
      const ty = entry.returnTarget
        ? entry.returnTarget.y
        : this._targetY - entry.grabOffsetY;

      const dx = tx - entry.x;
      const dy = ty - entry.y;

      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        entry.x = tx;
        entry.y = ty;
        if (entry.returnTarget) completed.push(rootId);
        continue;
      }

      entry.x += dx * this._lerpFactor;
      entry.y += dy * this._lerpFactor;
      moved = true;
    }

    for (const rootId of completed) {
      this._finishReturn(rootId);
    }

    if (moved) this.invalidateLayout();
  }

  // ─── Private — event handlers ─────────────────────────────────────────────

  private _onDown(data: InputPointerData): void {
    this._downTarget = data.target;
    this._cursorX    = data.x;
    this._cursorY    = data.y;
  }

  private _onDragStart(data: InputPointerData): void {
    if (!(this._downTarget instanceof Card)) return;

    const hitCard  = this._downTarget;
    if (!(hitCard.getParentLayout() instanceof CardStack)) return;

    const dragId     = hitCard.getCardId();
    const clientCard = client_cards[dragId];
    if (!clientCard) return;

    const flags = parseCardFlags(clientCard.flags);
    if (flags.position_locked || flags.position_hold) return;

    // Center of the specific card that was grabbed, in screen space.
    const origin = hitCard.toGlobal(new Point(
      hitCard.outerRect.width  / 2,
      hitCard.outerRect.height / 2,
    ));

    clientCard.dragging = true;

    // entry.y is the stack center, but origin.y is the grabbed card's center.
    // Card 0 sits at stackTop + cardHeight/2 = stackCenter - (n-1)*titleHeight/2,
    // so we shift the stack center up by that amount to align card 0 with origin.
    const n          = this._chainLength(dragId);
    const stackCY    = origin.y + (n - 1) * this._titleHeight / 2;

    // Grab offset keeps the exact grab point pinned under the cursor.
    const grabOffsetX = data.x - origin.x;
    const grabOffsetY = data.y - stackCY;

    // Seed the throttled target at the current cursor so the card doesn't
    // jump on the first redraw before a drag_move sample is recorded.
    this._targetX    = data.x;
    this._targetY    = data.y;
    this._lastSample = Date.now();

    this._addEntry(dragId, origin.x, stackCY, origin.x, stackCY, grabOffsetX, grabOffsetY);
    this.invalidateLayout();
  }

  private _onDragMove(data: InputDragMoveData): void {
    this._cursorX = data.x;
    this._cursorY = data.y;

    const now = Date.now();
    if (now - this._lastSample < this._sampleInterval) return;

    this._targetX    = data.x;
    this._targetY    = data.y;
    this._lastSample = now;
    this.invalidateLayout();
  }

  private _onDragEnd(data: InputActionData): void {
    // Flush the final cursor position unconditionally so the stack is always
    // at the true release point before the return animation begins.
    this._targetX = data.up.x;
    this._targetY = data.up.y;

    // TODO: check data.up.target for valid drop targets.
    // All drops are invalid for now — return every dragging stack to its origin.
    let any = false;
    for (const [rootId, entry] of this._entries) {
      if (entry.returnTarget !== null) continue;
      const card = client_cards[rootId];
      if (!card) continue;
      card.dragging  = false;
      card.returning = true;
      entry.returnTarget = { x: entry.returnOrigin.x, y: entry.returnOrigin.y };
      any = true;
    }
    if (any) {
      this.invalidateLayout();
    }
  }

  // ─── Private — helpers ────────────────────────────────────────────────────

  private _addEntry(
    rootId:        CardId,
    startX:        number,
    startY:        number,
    returnOriginX: number,
    returnOriginY: number,
    grabOffsetX    = 0,
    grabOffsetY    = 0,
  ): void {
    const stack = new CardStack({ titleHeight: this._titleHeight, ignoreDragState: true });
    stack.setCardId(rootId);
    this._entries.set(rootId, {
      stack,
      x:            startX,
      y:            startY,
      grabOffsetX,
      grabOffsetY,
      returnOrigin: { x: returnOriginX, y: returnOriginY },
      returnTarget: null,
    });
    this.addLayoutChild(stack);
  }

  private _removeEntry(rootId: CardId, entry: StackEntry): void {
    this._entries.delete(rootId);
    this.removeLayoutChild(entry.stack);
    entry.stack.destroy({ children: true });
  }

  private _finishReturn(rootId: CardId): void {
    const card = client_cards[rootId];
    if (card) card.returning = false;
    this.invalidateLayout();
  }

  private _chainLength(rootId: CardId): number {
    let n = 0;
    const seen = new Set<CardId>();
    let current = rootId;
    while (current !== 0 && n < MAX_CHAIN_DEPTH) {
      if (seen.has(current)) break;
      seen.add(current);
      n++;
      const card = client_cards[current];
      if (!card || !card.linked_flag || card.link_id === 0) break;
      current = card.link_id;
    }
    return n;
  }
}
