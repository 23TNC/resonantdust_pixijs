import { Point } from "pixi.js";
import {
  client_cards,
  macro_location_cards,
  stacked_up_children,
  stacked_down_children,
  moveClientCard,
  stackClientCardUp,
  stackClientCardDown,
  packMacroWorld,
  packMacroPanel,
  packMicroHex,
  packMicroPixel,
  ZONE_SIZE,
  SURFACE_WORLD,
  isDraggableCardType,
  isPassableCardType,
  soul_id,
  type CardId,
  type ClientCard,
  type MacroLocation,
  type MicroLocation,
} from "@/spacetime/Data";
import { spacetime } from "@/spacetime/SpacetimeManager";
import {
  isBottomTitleByDef,
  getEffectiveTitleOnBottom,
} from "@/definitions/CardDefinitions";
import { syncStackActions } from "@/definitions/ActionCache";
import { collectUpChain, collectDownChain } from "@/definitions/RecipeDefinitions";
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

function collectFullStack(rootId: CardId): CardId[] {
  const ids: CardId[] = [];
  const seen = new Set<CardId>();
  const queue: CardId[] = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    ids.push(current);
    const up = stacked_up_children.get(current);
    if (up) for (const child of up) queue.push(child);
    const down = stacked_down_children.get(current);
    if (down) for (const child of down) queue.push(child);
  }
  return ids;
}

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
interface SourceCache {
  hitCard:      Card;
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

interface AddEntryArgs {
  x:           number;
  y:           number;
  grabOffsetX: number;
  grabOffsetY: number;
  source:      SourceCache;
}

export interface DragManagerOptions extends LayoutObjectOptions {
  input:        InputManager;
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

// ─── DragManager ─────────────────────────────────────────────────────────────

/**
 * Overlay component that visualises every card whose `dragging` or
 * `animating` flag is set in client_cards.
 *
 * Pickup mutates only `client_cards[id].dragging`.  A successful drop calls
 * Data.ts mutation helpers; an invalid drop sets `animating = true` and
 * tweens the card back to its origin before clearing the flag.  Source
 * views (Inventory, World, CardStack) update by reading the flags out of
 * client_cards on their next layout pass — DragManager pokes them via
 * invalidateLayout() on the cached source chain.
 */
export class DragManager extends LayoutObject {
  private static _instance: DragManager | null = null;
  static getInstance(): DragManager | null { return DragManager._instance; }

  private readonly _input:         InputManager;
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

  // Hit target captured on left_down — drag_start uses it as the grab source.
  private _downTarget: LayoutObject | null = null;

  private readonly _boundDown:      (data: InputPointerData)  => void;
  private readonly _boundDragStart: (data: InputPointerData)  => void;
  private readonly _boundDragMove:  (data: InputDragMoveData) => void;
  private readonly _boundDragEnd:   (data: InputActionData)   => void;

  constructor(options: DragManagerOptions) {
    super(options);
    DragManager._instance = this;
    this._input         = options.input;
    this._titleHeight   = options.titleHeight   ?? DEFAULT_TITLE_H;
    this._cardHeight    = options.cardHeight    ?? DEFAULT_CARD_H;
    this._stackWidth    = options.stackWidth    ?? DEFAULT_STACK_W;
    this._lerpFactor    = options.lerpFactor    ?? DEFAULT_LERP;
    this._returnLerp    = options.returnLerp    ?? DEFAULT_RETURN_LERP;
    this._gapMinimum    = options.gapMinimum    ?? DEFAULT_GAP_MIN;
    this._gapShrinkRate = options.gapShrinkRate ?? DEFAULT_GAP_SHRINK;

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
    if (DragManager._instance === this) DragManager._instance = null;
    this._input.off("left_down",       this._boundDown);
    this._input.off("left_drag_start", this._boundDragStart);
    this._input.off("left_drag_move",  this._boundDragMove);
    this._input.off("left_drag_end",   this._boundDragEnd);
    super.destroy(options);
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  setInventory(inventory: Inventory): void {
    this._inventory = inventory;
  }

  randomInventoryMicro(): MicroLocation | null {
    return this._inventory?.randomMicro() ?? null;
  }

  /**
   * Tween a card from screen position (fromX, fromY) to its committed
   * inventory pixel_x/pixel_y position.  Call after moveClientCard so the
   * destination is already encoded in the card's data.  Sets card.animating;
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

    card.animating = true;
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
      const card = client_cards[rootId];
      if (!card?.dragging && !card?.animating) {
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

  // ─── Input handlers ──────────────────────────────────────────────────────

  private _onDown(data: InputPointerData): void {
    this._downTarget = data.target;
  }

  private _onDragStart(data: InputPointerData): void {
    if (!(this._downTarget instanceof Card)) return;
    const hitCard  = this._downTarget;
    const hitStack = hitCard.getParentLayout();
    if (!(hitStack instanceof CardStack)) return;

    const dragId = hitCard.getCardId();
    const card   = client_cards[dragId];
    if (!card)                                      return;
    if (card.dead)                                  return;
    if (!isDraggableCardType(card.card_type))       return;
    if (card.position_locked || card.position_hold) return;

    // Origin: centre of the hit Card, in screen space.
    const origin = hitCard.toGlobal(new Point(
      hitCard.outerRect.width  / 2,
      hitCard.outerRect.height / 2,
    ));

    card.dragging = true;
    this._cursorX = data.x;
    this._cursorY = data.y;

    const source: SourceCache = {
      hitCard,
      hitStack,
      hitContainer: hitStack.getParentLayout(),
    };

    this._addEntry(dragId, {
      x:           origin.x,
      y:           origin.y,
      grabOffsetX: data.x - origin.x,
      grabOffsetY: data.y - origin.y,
      source,
    });
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
      if (entry.returnTarget !== null) continue;     // already tweening back

      const card = client_cards[rootId];
      if (!card) {
        any = true;
        continue;
      }

      // Drop handlers return either the LayoutObject to invalidate (success)
      // or null (handler called _dropInvalid; entry stays alive for tween).
      const invalidate = this._performDrop(card, rootId, entry, target);
      if (invalidate !== null) {
        card.dragging = false;
        this._invalidateSource(entry.source);
        if (!invalidate.destroyed) invalidate.invalidateLayout();
      }
      any = true;
    }

    if (any) this.invalidateLayout();
  }

  private _performDrop(
    card:   ClientCard,
    rootId: CardId,
    entry:  Entry,
    target: LayoutObject | null,
  ): LayoutObject | null {
    if (target instanceof Tile)      return this._dropOnTile(card, rootId, entry, target);
    if (target instanceof Card)      return this._dropOnCard(rootId, entry, target);
    if (target instanceof Inventory) return this._dropOnInventory(card, rootId, entry, target);
    this._dropInvalid(rootId, entry);
    return null;
  }

  // ─── Drop handlers ───────────────────────────────────────────────────────

  private _dropOnTile(card: ClientCard, rootId: CardId, entry: Entry, tile: Tile): LayoutObject | null {
    const { worldQ, worldR } = tile.getCoords();
    const zone_q  = Math.floor(worldQ / ZONE_SIZE);
    const zone_r  = Math.floor(worldR / ZONE_SIZE);
    const local_q = worldQ - zone_q * ZONE_SIZE;
    const local_r = worldR - zone_r * ZONE_SIZE;
    const layer   = card.surface === SURFACE_WORLD ? card.layer : 1;
    const macro   = packMacroWorld(zone_q, zone_r, layer);

    if (this._isHexBlocked(macro, local_q, local_r, rootId)) {
      this._dropInvalid(rootId, entry);
      return null;
    }

    // Commit the move now; the animating flag keeps both source and
    // destination views from rendering the card until the tween reaches
    // the tile centre, at which point _finishAnim invalidates the tile so
    // World picks the card up at its new location.
    moveClientCard(rootId, macro, packMicroHex(local_q, local_r));

    const centre = tile.toGlobal(new Point(
      tile.outerRect.width  / 2,
      tile.outerRect.height / 2,
    ));

    card.dragging      = false;
    card.animating     = true;
    entry.returnTarget = { x: centre.x, y: centre.y };
    entry.destination  = tile;

    // Returning null tells the dispatcher to skip the success teardown —
    // the redraw tween owns this entry's lifecycle until _finishAnim.
    return null;
  }

  private _dropOnInventory(card: ClientCard, rootId: CardId, entry: Entry, inventory: Inventory): LayoutObject | null {
    const { macro, micro } = this._inventoryDropTarget(inventory, entry, card);

    // Naturally bottom-title source: stacked_down chain is the natural
    // arrangement, source stays the root.  Naturally top-title source:
    // walk through consecutive top-by-definition descendants — the last
    // becomes the new root, and the cards between (in chain order) get
    // flipped onto its top stack starting from the end working back
    // toward the original root.  Preserves visual order while restoring
    // each card's natural top-title display.
    const chain   = isBottomTitleByDef(rootId) ? [rootId] : this._naturalTopChain(rootId);
    const newRoot = chain[chain.length - 1];

    moveClientCard(newRoot, macro, micro);
    for (let i = chain.length - 2; i >= 0; i--) {
      stackClientCardUp(chain[i], chain[i + 1]);
    }

    return inventory;
  }

  private _dropOnCard(rootId: CardId, entry: Entry, dropCard: Card): LayoutObject | null {
    const destId = dropCard.getCardId();
    if (destId === 0 || destId === rootId)         { this._dropInvalid(rootId, entry); return null; }

    const destRoot   = this._findRoot(destId);
    const sourceRoot = this._findRoot(rootId);
    if (destRoot === 0 || sourceRoot === 0)        { this._dropInvalid(rootId, entry); return null; }
    if (sourceRoot === destRoot)                   { this._dropInvalid(rootId, entry); return null; }

    // Reject the genuine "both branches" structural case.  A top-title-by-
    // definition source with a stacked_down chain (a leftover flip from a
    // previous drop) is allowed; the merge-branch rule treats it by its
    // natural top-title state regardless of how it currently displays.
    const sourceHasUp   = (stacked_up_children.get(rootId)?.size   ?? 0) > 0;
    const sourceHasDown = (stacked_down_children.get(rootId)?.size ?? 0) > 0;
    if (sourceHasUp && sourceHasDown)              { this._dropInvalid(rootId, entry); return null; }

    const useDown = this._pickMergeBranch(rootId, destRoot, dropCard);
    const leafId  = useDown ? CardStack.findDownLeaf(destRoot) : CardStack.findUpLeaf(destRoot);

    if (useDown) {
      stackClientCardDown(rootId, leafId);
      // Source root is now on a down-branch; any pre-existing up-branch
      // descendants would orphan because CardStack walks a single direction
      // per branch.  Flip them to match.
      this._flipDescendants(rootId, true);
    } else {
      stackClientCardUp(rootId, leafId);
      this._flipDescendants(rootId, false);
    }

    const stackIds = collectFullStack(destRoot);
    const cardIds:        CardId[] = [];
    const macroLocations: bigint[] = [];
    const microLocations: number[] = [];
    const flags:          number[] = [];
    for (const id of stackIds) {
      const c = client_cards[id];
      if (!c) continue;
      cardIds.push(c.card_id);
      macroLocations.push(c.macro_location);
      microLocations.push(c.micro_location);
      flags.push(c.flags);
    }
    spacetime.setCardPositions(cardIds, macroLocations, microLocations, flags);
    syncStackActions(destRoot, collectUpChain(destRoot), collectDownChain(destRoot), soul_id);

    return dropCard;
  }

  private _dropInvalid(rootId: CardId, entry: Entry): void {
    const card = client_cards[rootId];
    if (!card) return;
    card.dragging      = false;
    card.animating     = true;
    entry.returnTarget = { x: entry.returnOrigin.x, y: entry.returnOrigin.y };
  }

  // ─── Tween completion ────────────────────────────────────────────────────

  private _finishAnim(rootId: CardId): void {
    const entry = this._entries.get(rootId);
    if (!entry) return;
    const card = client_cards[rootId];
    if (card) card.animating = false;
    this._invalidateSource(entry.source);
    if (entry.destination && !entry.destination.destroyed) {
      entry.destination.invalidateLayout();
    }
    // Animating flag cleared — schedule a layout pass so updateLayoutChildren
    // removes the entry promptly rather than waiting for the next unrelated invalidation.
    this.invalidateLayout();
  }

  // ─── Drop-target helpers ─────────────────────────────────────────────────

  private _inventoryDropTarget(
    inventory: Inventory,
    entry:     Entry,
    card:      ClientCard,
  ): { macro: MacroLocation; micro: MicroLocation } {
    const local = inventory.toLocal(new Point(entry.x, entry.y));
    const cx = inventory.innerRect.x + inventory.innerRect.width  / 2;
    const cy = inventory.innerRect.y + inventory.innerRect.height / 2;
    const px = Math.round(local.x - cx);
    const py = Math.round(local.y - cy);
    return {
      macro: packMacroPanel(inventory.getViewedId(), card.layer || 1),
      micro: packMicroPixel(px, py),
    };
  }

  /**
   * Decide which branch of destRoot a merge drop should attach to.
   *
   * Uses the source's NATURAL title (its definition) — not the current
   * effective state.  A top-title card flipped into a bottom stack is
   * still treated as a top-title source on its next drop.
   *
   *   • Source naturally bottom-title → bottom, always.
   *   • Source naturally top-title    → the dest has a "natural" branch
   *     (top for a top-title dest, bottom for a bottom-title dest).  If
   *     the opposite branch exists on the dest, the cursor's vertical
   *     position decides (above dest centre → top, below → bottom).
   *     Otherwise the dest's natural branch is used regardless of cursor.
   */
  private _pickMergeBranch(rootId: CardId, destRoot: CardId, dropCard: Card): boolean {
    if (isBottomTitleByDef(rootId)) return true;

    const hasUp           = (stacked_up_children.get(destRoot)?.size   ?? 0) > 0;
    const hasDown         = (stacked_down_children.get(destRoot)?.size ?? 0) > 0;
    const destBottomTitle = getEffectiveTitleOnBottom(destRoot);
    const hasOpposite     = destBottomTitle ? hasUp : hasDown;

    if (!hasOpposite) return destBottomTitle;
    return this._cursorBelowCardCentre(dropCard);
  }

  /** True when the current cursor Y lies below the centre of the card's parent CardStack root. */
  private _cursorBelowCardCentre(dropCard: Card): boolean {
    const destStack = dropCard.getParentLayout();
    if (!(destStack instanceof CardStack)) return false;
    const destRootCard = destStack.getRootCard();
    if (!destRootCard) return false;
    const centre = destRootCard.toGlobal(new Point(
      destRootCard.outerRect.width  / 2,
      destRootCard.outerRect.height / 2,
    ));
    return this._cursorY > centre.y;
  }

  /**
   * Walk rootId's stacked_down chain through consecutive cards whose
   * definition is top-title.  Returns the chain [rootId, child, …, last_top]
   * — stops just before any bottom-title-by-definition card or the end of
   * the chain.
   */
  private _naturalTopChain(rootId: CardId): CardId[] {
    const chain: CardId[] = [rootId];
    const seen  = new Set<CardId>([rootId]);
    let current = rootId;

    while (true) {
      const children = stacked_down_children.get(current);
      if (!children || children.size === 0) break;
      const next = children.values().next().value!;
      if (seen.has(next)) break;
      if (!client_cards[next]) break;
      if (isBottomTitleByDef(next)) break;
      seen.add(next);
      chain.push(next);
      current = next;
    }

    return chain;
  }

  // ─── Entry lifecycle ─────────────────────────────────────────────────────

  private _addEntry(rootId: CardId, args: AddEntryArgs): void {
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
  }

  private _removeEntry(rootId: CardId, entry: Entry): void {
    if (!this._entries.has(rootId)) return;
    this._entries.delete(rootId);
    this.removeLayoutChild(entry.stack);
    if (!entry.stack.destroyed) entry.stack.destroy({ children: true });
  }

  private _invalidateSource(src: SourceCache | null): void {
    if (!src) return;
    if (!src.hitCard.destroyed)                          src.hitCard.invalidateLayout();
    if (!src.hitStack.destroyed)                         src.hitStack.invalidateLayout();
    if (src.hitContainer && !src.hitContainer.destroyed) src.hitContainer.invalidateLayout();
  }

  // ─── Graph helpers ───────────────────────────────────────────────────────

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

  /**
   * Walk every descendant of cardId on the OPPOSITE branch direction and
   * re-stack it onto its existing parent in the target direction.  Without
   * this, a pre-existing chain on one branch is orphaned when the drop puts
   * its root on the other branch — CardStack._walkBranch is direction-locked.
   *
   * Each flip mutates the index we're iterating, so children are snapshotted.
   */
  private _flipDescendants(cardId: CardId, toDown: boolean): void {
    const oppositeIndex = toDown ? stacked_up_children : stacked_down_children;
    const flipFn        = toDown ? stackClientCardDown : stackClientCardUp;

    const queue: CardId[] = [cardId];
    const seen  = new Set<CardId>([cardId]);

    while (queue.length > 0) {
      const current  = queue.shift()!;
      const children = oppositeIndex.get(current);
      if (!children || children.size === 0) continue;

      const childIds = [...children];
      for (const childId of childIds) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        flipFn(childId, current);
        queue.push(childId);
      }
    }
  }

  /**
   * True if any non-passable card occupies (local_q, local_r) at this macro.
   * Skips: ignoreId, dragging/animating cards, stacked cards, hidden cards,
   * and tile-type cards (they are the floor, not occupants).
   */
  private _isHexBlocked(macro: MacroLocation, local_q: number, local_r: number, ignoreId: CardId): boolean {
    const cardIds = macro_location_cards.get(macro);
    if (!cardIds) return false;
    for (const cid of cardIds) {
      if (cid === ignoreId) continue;
      const c = client_cards[cid];
      if (!c) continue;
      if (c.dragging || c.animating)      continue;
      if (c.stacked_up || c.stacked_down) continue;
      if (c.hidden)                       continue;
      if (c.local_q !== local_q || c.local_r !== local_r) continue;
      if (isPassableCardType(c.card_type)) continue;
      return true;
    }
    return false;
  }
}
