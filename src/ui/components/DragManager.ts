import { Point } from "pixi.js";
import {
  client_cards,
  macro_location_cards,
  moveClientCard,
  stackClientCardUp,
  stackClientCardDown,
  packMacroWorld,
  packMacroPanel,
  packMicroHex,
  packMicroPixel,
  ZONE_SIZE,
  SURFACE_WORLD,
  type CardId,
  type MacroLocation,
} from "@/spacetime/Data";
import { getDefinitionByPacked } from "@/data/definitions/CardDefinitions";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";
import {
  type InputManager,
  type InputPointerData,
  type InputDragMoveData,
  type InputActionData,
} from "@/ui/input/InputManager";
import { Card } from "./Card";
import { CardStack } from "./CardStack";
import { Inventory } from "./Inventory";
import { Tile } from "./Tile";

const DEFAULT_TITLE_H     = 24;
const DEFAULT_CARD_H      = 120;
const DEFAULT_STACK_W     = 80;
const DEFAULT_LERP        = 0.18;
const DEFAULT_RETURN_LERP = 0.25;
const ARRIVE_THRESHOLD    = 0.5;
const MAX_CYCLE_DEPTH     = 64;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * References cached at drag start so we can invalidate the source's parent
 * chain when the drag completes. Each may become destroyed mid-drag, so every
 * use is guarded by .destroyed.
 */
interface SourceCache {
  hitCard:      Card;
  hitStack:     LayoutObject | null;       // Card.parent (CardStack)
  hitContainer: LayoutObject | null;       // CardStack.parent (Inventory or World overlay parent)
}

interface Entry {
  stack:        CardStack;
  /** Current rendered position of the root card's centre, in screen space. */
  x:            number;
  y:            number;
  /** Cursor → root-centre offset captured on pickup. */
  grabOffsetX:  number;
  grabOffsetY:  number;
  /** Where the entry started — return-to-origin tween destination. */
  returnOrigin: { x: number; y: number };
  /** null while following the cursor; set to a point while returning. */
  returnTarget: { x: number; y: number } | null;
  source:       SourceCache;
}

export interface DragManagerOptions extends LayoutObjectOptions {
  input:        InputManager;
  titleHeight?: number;
  cardHeight?:  number;
  stackWidth?:  number;
  /** Lerp factor while following the cursor. Default: 0.18. */
  lerpFactor?:  number;
  /** Lerp factor while returning to origin. Default: 0.25. */
  returnLerp?:  number;
}

// ─── DragManager ─────────────────────────────────────────────────────────────

/**
 * Overlay component that visualises every card whose `dragging` or `returning`
 * flag is set in client_cards.
 *
 * Pickup mutates only `client_cards[id].dragging`. Drop calls Data.ts mutation
 * helpers (moveClientCard / stackClientCardUp / stackClientCardDown) for valid
 * targets, or sets `returning = true` for invalid drops and tweens the card
 * back to its origin before clearing the flag.
 *
 * Source views (Inventory, World, CardStack) update by reading the flags out
 * of client_cards on their next layout pass — DragManager pokes them via
 * invalidateLayout() on the cached source chain.
 */
export class DragManager extends LayoutObject {
  private readonly _input:       InputManager;
  private readonly _titleHeight: number;
  private readonly _cardHeight:  number;
  private readonly _stackWidth:  number;
  private readonly _lerpFactor:  number;
  private readonly _returnLerp:  number;

  private readonly _entries = new Map<CardId, Entry>();

  // Latest cursor position, screen space.
  private _cursorX = 0;
  private _cursorY = 0;

  // Hit target captured on left_down — drag_start uses it as the grab source.
  private _downTarget: LayoutObject | null = null;

  private readonly _boundDown:      (data: InputPointerData)  => void;
  private readonly _boundDragStart: (data: InputPointerData)  => void;
  private readonly _boundDragMove:  (data: InputDragMoveData) => void;
  private readonly _boundDragEnd:   (data: InputActionData)   => void;

  constructor(options: DragManagerOptions) {
    super(options);
    this._input       = options.input;
    this._titleHeight = options.titleHeight ?? DEFAULT_TITLE_H;
    this._cardHeight  = options.cardHeight  ?? DEFAULT_CARD_H;
    this._stackWidth  = options.stackWidth  ?? DEFAULT_STACK_W;
    this._lerpFactor  = options.lerpFactor  ?? DEFAULT_LERP;
    this._returnLerp  = options.returnLerp  ?? DEFAULT_RETURN_LERP;

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

  /** Overlay is non-interactive — clicks pass through to the layer below. */
  override hitTestLayout(
    _globalX: number,
    _globalY: number,
    _ignore?: ReadonlySet<LayoutObject>,
  ): LayoutObject | null {
    return null;
  }

  // ─── Layout ──────────────────────────────────────────────────────────────

  protected override updateLayoutChildren(): void {
    // Tear down entries whose flags have been cleared elsewhere.
    for (const [rootId, entry] of this._entries) {
      const card = client_cards[rootId];
      if (!card?.dragging && !card?.returning) {
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

    for (const rootId of completed) this._finishReturn(rootId);
    if (moved) this.invalidateLayout();
  }

  // ─── Input handlers ──────────────────────────────────────────────────────

  private _onDown(data: InputPointerData): void {
    this._downTarget = data.target;
    this._cursorX    = data.x;
    this._cursorY    = data.y;
  }

  private _onDragStart(data: InputPointerData): void {
    if (!(this._downTarget instanceof Card)) return;
    const hitCard = this._downTarget;

    const hitStack = hitCard.getParentLayout();
    if (!(hitStack instanceof CardStack)) return;

    const dragId = hitCard.getCardId();
    const card   = client_cards[dragId];
    if (!card) return;

    // Eligibility — same gate as the previous DragManager.
    if (card.card_type < 1 || card.card_type > 4) return;
    if (card.position_locked || card.position_hold) return;

    // Origin: centre of the hit Card, in screen space.
    const origin = hitCard.toGlobal(new Point(
      hitCard.outerRect.width  / 2,
      hitCard.outerRect.height / 2,
    ));

    card.dragging = true;

    const grabOffsetX = data.x - origin.x;
    const grabOffsetY = data.y - origin.y;

    this._cursorX = data.x;
    this._cursorY = data.y;

    const source: SourceCache = {
      hitCard,
      hitStack,
      hitContainer: hitStack.getParentLayout(),
    };

    this._addEntry(dragId, origin.x, origin.y, grabOffsetX, grabOffsetY, source);
    this._invalidateSource(source);
    this.invalidateLayout();
  }

  private _onDragMove(data: InputDragMoveData): void {
    this._cursorX = data.x;
    this._cursorY = data.y;
    this.invalidateLayout();
  }

  private _onDragEnd(data: InputActionData): void {
    this._cursorX = data.up.x;
    this._cursorY = data.up.y;

    const target = data.up.target;
    let any = false;

    for (const [rootId, entry] of this._entries) {
      // Already returning from a previous invalid drop; let it finish.
      if (entry.returnTarget !== null) continue;

      if      (target instanceof Tile)      this._dropOnTile(rootId, target, entry);
      else if (target instanceof Card)      this._dropOnCard(rootId, target, entry);
      else if (target instanceof Inventory) this._dropOnInventory(rootId, target, entry);
      else                                  this._dropInvalid(rootId, entry);

      any = true;
    }

    if (any) this.invalidateLayout();
  }

  // ─── Drop handlers ───────────────────────────────────────────────────────

  private _dropOnTile(rootId: CardId, tile: Tile, entry: Entry): void {
    const card = client_cards[rootId];
    if (!card) { this._removeEntry(rootId, entry); return; }

    const { worldQ, worldR } = tile.getCoords();
    const zone_q  = Math.floor(worldQ / ZONE_SIZE);
    const zone_r  = Math.floor(worldR / ZONE_SIZE);
    const local_q = worldQ - zone_q * ZONE_SIZE;
    const local_r = worldR - zone_r * ZONE_SIZE;
    const layer   = card.surface === SURFACE_WORLD ? card.layer : 1;
    const macro   = packMacroWorld(zone_q, zone_r, layer);

    if (this._isHexBlocked(macro, local_q, local_r, rootId)) {
      this._dropInvalid(rootId, entry);
      return;
    }

    moveClientCard(rootId, macro, packMicroHex(local_q, local_r));
    card.dragging = false;
    this._removeEntry(rootId, entry);
    this._invalidateSource(entry.source);
    if (!tile.destroyed) tile.invalidateLayout();
  }

  private _dropOnInventory(rootId: CardId, inventory: Inventory, entry: Entry): void {
    const card = client_cards[rootId];
    if (!card) { this._removeEntry(rootId, entry); return; }

    const local = inventory.toLocal(new Point(entry.x, entry.y));
    const cx = inventory.innerRect.x + inventory.innerRect.width  / 2;
    const cy = inventory.innerRect.y + inventory.innerRect.height / 2;
    const px = Math.round(local.x - cx);
    const py = Math.round(local.y - cy);

    moveClientCard(
      rootId,
      packMacroPanel(inventory.getViewedId(), card.layer || 1),
      packMicroPixel(px, py),
    );
    card.dragging = false;
    this._removeEntry(rootId, entry);
    this._invalidateSource(entry.source);
    if (!inventory.destroyed) inventory.invalidateLayout();
  }

  private _dropOnCard(rootId: CardId, dropCard: Card, entry: Entry): void {
    const card = client_cards[rootId];
    if (!card) { this._removeEntry(rootId, entry); return; }

    const destId = dropCard.getCardId();
    if (destId === 0 || destId === rootId)         { this._dropInvalid(rootId, entry); return; }
    if (this._isCycle(rootId, destId))             { this._dropInvalid(rootId, entry); return; }

    const destRoot = this._findRoot(destId);
    if (destRoot === 0)                            { this._dropInvalid(rootId, entry); return; }

    // Direction rule: down if either source root or destination root is a
    // bottom-titled type. Otherwise up.
    const sourceRoot = this._findRoot(rootId);
    const sourceDef  = this._defOf(sourceRoot);
    const destDef    = this._defOf(destRoot);
    const useDown    = (sourceDef?.title_on_bottom ?? false) || (destDef?.title_on_bottom ?? false);

    const leafId = useDown
      ? CardStack.findDownLeaf(destRoot)
      : CardStack.findUpLeaf(destRoot);

    if (useDown) stackClientCardDown(rootId, leafId);
    else         stackClientCardUp(rootId, leafId);

    card.dragging = false;
    this._removeEntry(rootId, entry);
    this._invalidateSource(entry.source);
    if (!dropCard.destroyed) dropCard.invalidateLayout();
  }

  private _dropInvalid(rootId: CardId, entry: Entry): void {
    const card = client_cards[rootId];
    if (!card) { this._removeEntry(rootId, entry); return; }
    card.dragging      = false;
    card.returning     = true;
    entry.returnTarget = { x: entry.returnOrigin.x, y: entry.returnOrigin.y };
  }

  // ─── Return completion ───────────────────────────────────────────────────

  private _finishReturn(rootId: CardId): void {
    const entry = this._entries.get(rootId);
    if (!entry) return;
    const card = client_cards[rootId];
    if (card) card.returning = false;
    this._removeEntry(rootId, entry);
    this._invalidateSource(entry.source);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private _addEntry(
    rootId:      CardId,
    x:           number,
    y:           number,
    grabOffsetX: number,
    grabOffsetY: number,
    source:      SourceCache,
  ): void {
    const stack = new CardStack({ titleHeight: this._titleHeight, ignoreDragState: true });
    stack.setCardId(rootId);
    this._entries.set(rootId, {
      stack,
      x,
      y,
      grabOffsetX,
      grabOffsetY,
      returnOrigin: { x, y },
      returnTarget: null,
      source,
    });
    this.addLayoutChild(stack);
  }

  private _removeEntry(rootId: CardId, entry: Entry): void {
    if (!this._entries.has(rootId)) return;
    this._entries.delete(rootId);
    this.removeLayoutChild(entry.stack);
    if (!entry.stack.destroyed) entry.stack.destroy({ children: true });
  }

  private _invalidateSource(src: SourceCache): void {
    if (!src.hitCard.destroyed)                          src.hitCard.invalidateLayout();
    if (src.hitStack     && !src.hitStack.destroyed)     src.hitStack.invalidateLayout();
    if (src.hitContainer && !src.hitContainer.destroyed) src.hitContainer.invalidateLayout();
  }

  /** Walk stacked_on_id upward; return the unstacked root, or 0 on cycle/missing. */
  private _findRoot(cardId: CardId): CardId {
    const seen = new Set<CardId>();
    let current = cardId;
    while (current !== 0) {
      if (seen.has(current)) return 0;
      seen.add(current);
      const c = client_cards[current];
      if (!c) return 0;
      if (c.stacked_on_id === 0) return current;
      current = c.stacked_on_id;
    }
    return 0;
  }

  private _defOf(cardId: CardId) {
    const c = client_cards[cardId];
    return c ? getDefinitionByPacked(c.packed_definition) : undefined;
  }

  /** True if rootId already appears in destId's ancestor chain. */
  private _isCycle(rootId: CardId, destId: CardId): boolean {
    const seen = new Set<CardId>();
    let current = destId;
    let steps = 0;
    while (current !== 0 && steps < MAX_CYCLE_DEPTH) {
      if (current === rootId) return true;
      if (seen.has(current))  return false;
      seen.add(current);
      const c = client_cards[current];
      if (!c || c.stacked_on_id === 0) return false;
      current = c.stacked_on_id;
      steps++;
    }
    return false;
  }

  /**
   * True if any non-passable card occupies (local_q, local_r) at this macro.
   * Skips: ignoreId, dragging/returning cards, stacked cards, hidden cards,
   * and tile-type cards (they are the floor, not occupants).
   */
  private _isHexBlocked(macro: MacroLocation, local_q: number, local_r: number, ignoreId: CardId): boolean {
    const cardIds = macro_location_cards.get(macro);
    if (!cardIds) return false;
    for (const cid of cardIds) {
      if (cid === ignoreId) continue;
      const c = client_cards[cid];
      if (!c) continue;
      if (c.dragging || c.returning)        continue;
      if (c.stacked_up || c.stacked_down)   continue;
      if (c.hidden)                         continue;
      if (c.local_q !== local_q || c.local_r !== local_r) continue;
      if (c.card_type === 6 || c.card_type === 7 || c.card_type === 8) continue;
      return true;
    }
    return false;
  }
}
