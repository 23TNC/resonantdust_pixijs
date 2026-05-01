import { Point } from "pixi.js";
import {
  client_cards,
  macro_zone_cards,
  packMacroWorld,
  packMacroPanel,
  packMicroZone,
  packMicroPixel,
  ZONE_SIZE,
  PANEL_LAYER_INVENTORY,
  WORLD_LAYER_GROUND,
  isDraggableCardType,
  isPassableCardType,
  type CardId,
  type ClientCard,
  type MacroZone,
  type MicroZone,
  type MicroLocation,
} from "@/spacetime/Data";
import { Stack } from "@/model/Stack";
import {
  deathState, isAnimating, isDragging, isHidden,
  setAnimating, setDragging,
} from "@/model/CardModel";
import { spacetime } from "@/spacetime/SpacetimeManager";
import {
  isBottomTitleByDef,
  getEffectiveTitleOnBottom,
} from "@/definitions/CardDefinitions";
import { LayoutObject } from "@/ui/layout/LayoutObject";
import {
  type InputManager,
  type InputPointerData,
  type InputDragMoveData,
  type InputActionData,
} from "@/ui/input/InputManager";
import { Card } from "@/ui/components/Card";
import { CardStack } from "@/ui/components/CardStack";
import { Inventory } from "@/ui/components/Inventory";
import { Tile } from "@/ui/components/Tile";
import { DragOverlay, type SourceCache } from "@/ui/components/DragOverlay";

/**
 * Translates user pointer input into game-state mutations during drag-and-drop.
 *
 *   left_down       → cache target
 *   left_drag_start → validate, set card.dragging, ask DragOverlay to spawn an entry
 *   left_drag_move  → forward cursor to DragOverlay
 *   left_drag_end   → dispatch to _dropOn{Tile,Card,Inventory} or invalid path
 *
 * This class never renders or tweens — DragOverlay does that.  In return,
 * DragOverlay never reads game state beyond `card.dragging`/`card.animating`
 * to decide which entries should remain visible.
 */
export class DragController {
  private readonly _input:    InputManager;
  private readonly _overlay:  DragOverlay;

  // Hit target captured on left_down — drag_start uses it as the grab source.
  private _downTarget: LayoutObject | null = null;

  private readonly _boundDown:      (data: InputPointerData)  => void;
  private readonly _boundDragStart: (data: InputPointerData)  => void;
  private readonly _boundDragMove:  (data: InputDragMoveData) => void;
  private readonly _boundDragEnd:   (data: InputActionData)   => void;

  constructor(input: InputManager, overlay: DragOverlay) {
    this._input   = input;
    this._overlay = overlay;

    this._boundDown      = this._onDown.bind(this);
    this._boundDragStart = this._onDragStart.bind(this);
    this._boundDragMove  = this._onDragMove.bind(this);
    this._boundDragEnd   = this._onDragEnd.bind(this);

    this._input.on("left_down",       this._boundDown);
    this._input.on("left_drag_start", this._boundDragStart);
    this._input.on("left_drag_move",  this._boundDragMove);
    this._input.on("left_drag_end",   this._boundDragEnd);
  }

  destroy(): void {
    this._input.off("left_down",       this._boundDown);
    this._input.off("left_drag_start", this._boundDragStart);
    this._input.off("left_drag_move",  this._boundDragMove);
    this._input.off("left_drag_end",   this._boundDragEnd);
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
    if (deathState(dragId) !== 0)                   return;
    if (!isDraggableCardType(card.card_type))       return;
    if (card.position_locked || card.position_hold) return;

    // Origin: centre of the hit Card, in screen space.
    const origin = hitCard.toGlobal(new Point(
      hitCard.outerRect.width  / 2,
      hitCard.outerRect.height / 2,
    ));

    setDragging(dragId, true);
    this._overlay.setCursor(data.x, data.y);

    const source: SourceCache = {
      hitCard,
      hitStack,
      hitContainer: hitStack.getParentLayout(),
    };

    this._overlay.addEntry(dragId, {
      x:           origin.x,
      y:           origin.y,
      grabOffsetX: data.x - origin.x,
      grabOffsetY: data.y - origin.y,
      source,
    });
    this._invalidateSource(source);
  }

  private _onDragMove(data: InputDragMoveData): void {
    this._overlay.setCursor(data.x, data.y);
  }

  private _onDragEnd(data: InputActionData): void {
    this._overlay.setCursor(data.up.x, data.up.y);

    const target = data.up.target;
    // Iterate every dragging card (multi-touch isn't supported but the
    // overlay holds the canonical entry set; ask it to apply per-id).
    for (const rootId of this._draggingRootIds()) {
      const card = client_cards[rootId];
      if (!card) continue;

      const invalidate = this._performDrop(card, rootId, target);
      if (invalidate !== null) {
        setDragging(rootId, false);
        // Source views read isDragging on their next pass — kick them.
        // (DragOverlay's source ref handles the cached chain; trigger via
        //  the destination too if it's not the source.)
        if (!invalidate.destroyed) invalidate.invalidateLayout();
      }
    }
  }

  // ─── Drop dispatch ───────────────────────────────────────────────────────

  /**
   * Returns either the LayoutObject to invalidate (for successful drops that
   * complete immediately) or null (when the entry retains lifecycle, e.g.
   * tweening onto a tile or returning to origin after an invalid drop).
   */
  private _performDrop(
    card:   ClientCard,
    rootId: CardId,
    target: LayoutObject | null,
  ): LayoutObject | null {
    if (target instanceof Tile)      return this._dropOnTile(card, rootId, target);
    if (target instanceof Card)      return this._dropOnCard(rootId, target);
    if (target instanceof Inventory) return this._dropOnInventory(card, rootId, target);
    this._dropInvalid(rootId);
    return null;
  }

  // ─── Drop handlers ───────────────────────────────────────────────────────

  private _dropOnTile(card: ClientCard, rootId: CardId, tile: Tile): LayoutObject | null {
    const { worldQ, worldR } = tile.getCoords();
    const zone_q  = Math.floor(worldQ / ZONE_SIZE);
    const zone_r  = Math.floor(worldR / ZONE_SIZE);
    const local_q = worldQ - zone_q * ZONE_SIZE;
    const local_r = worldR - zone_r * ZONE_SIZE;
    const layer   = card.is_world ? card.layer : WORLD_LAYER_GROUND;
    const macro   = packMacroWorld(zone_q, zone_r);

    if (this._isHexBlocked(macro, local_q, local_r, rootId)) {
      this._dropInvalid(rootId);
      return null;
    }

    // Local commit so source/dest views snap immediately; sync the move via
    // updatePosition so the server cancels disturbed actions, applies the
    // move, and re-runs the matcher in the affected zones.
    const micro_zone = packMicroZone(local_q, local_r);
    const micro_loc  = packMicroPixel(0, 0);
    Stack.detach(rootId, layer, macro, micro_zone, micro_loc);
    const moved = client_cards[rootId];
    if (moved) {
      spacetime.updatePosition(rootId, layer, macro, micro_zone, micro_loc, moved.flags);
    }

    const centre = tile.toGlobal(new Point(
      tile.outerRect.width  / 2,
      tile.outerRect.height / 2,
    ));

    setDragging(rootId, false);
    setAnimating(rootId, true);
    this._overlay.setReturnTarget(rootId, centre.x, centre.y, tile);

    return null;
  }

  private _dropOnInventory(card: ClientCard, rootId: CardId, inventory: Inventory): LayoutObject | null {
    const { layer, macro_zone, micro_zone, micro_location } = this._inventoryDropTarget(inventory, rootId, card);

    // Naturally bottom-title source: stacked_down chain is the natural
    // arrangement, source stays the root.  Naturally top-title source:
    // walk through consecutive top-by-definition descendants — the last
    // becomes the new root, and the cards between (in chain order) get
    // flipped onto its top stack starting from the end working back
    // toward the original root.  Preserves visual order while restoring
    // each card's natural top-title display.
    const chain   = isBottomTitleByDef(rootId) ? [rootId] : new Stack(rootId).naturalTopChain();
    const newRoot = chain[chain.length - 1];

    // Capture the source's pre-detach panel anchor so the cosmetic-gate
    // check below sees the original location, not the post-detach one.
    const sourceWasInTargetPanel =
      card.is_panel && card.panel_card_id === inventory.getViewedId();

    Stack.detach(newRoot, layer, macro_zone, micro_zone, micro_location);
    for (let i = chain.length - 2; i >= 0; i--) {
      Stack.attachUp(chain[i], chain[i + 1]);
    }

    // Per the Phase 5 §5 sync table: pure intra-panel cosmetic moves don't
    // sync.  The card is server-truth in this panel already; rearranging
    // pixel positions within it is invisible to peers and not action-
    // meaningful, so we don't pay a reducer call for it.  When the source
    // crossed into this panel from elsewhere (world pickup, cross-soul
    // transfer), the position change DOES need to reach the server so the
    // new owner's subscription resolves and any disturbed actions cancel.
    if (!sourceWasInTargetPanel) {
      this._syncStackPositions(new Stack(newRoot).participants());
    }

    return inventory;
  }

  /** Push the current (layer, macro_zone, micro_zone, micro_location, flags)
   *  for every card in `stackIds` to the server via the batched
   *  updatePositions reducer.  Skips missing rows. */
  private _syncStackPositions(stackIds: readonly CardId[]): void {
    const cardIds:        CardId[]    = [];
    const layers:         number[]    = [];
    const macroZones:     MacroZone[] = [];
    const microZones:     number[]    = [];
    const microLocations: number[]    = [];
    const flags:          number[]    = [];
    for (const id of stackIds) {
      const c = client_cards[id];
      if (!c) continue;
      cardIds.push(c.card_id);
      layers.push(c.layer);
      macroZones.push(c.macro_zone);
      microZones.push(c.micro_zone);
      microLocations.push(c.micro_location);
      flags.push(c.flags);
    }
    if (cardIds.length > 0) {
      spacetime.updatePositions(cardIds, layers, macroZones, microZones, microLocations, flags);
    }
  }

  private _dropOnCard(rootId: CardId, dropCard: Card): LayoutObject | null {
    const destId = dropCard.getCardId();
    if (destId === 0 || destId === rootId)         { this._dropInvalid(rootId); return null; }

    const destRoot   = Stack.findRoot(destId);
    const sourceRoot = Stack.findRoot(rootId);
    if (destRoot === 0 || sourceRoot === 0)        { this._dropInvalid(rootId); return null; }
    if (sourceRoot === destRoot)                   { this._dropInvalid(rootId); return null; }

    const sourceStack = new Stack(rootId);
    const destStack   = new Stack(destRoot);

    // Reject the genuine "both branches" structural case.  A top-title-by-
    // definition source with a stacked_down chain (a leftover flip from a
    // previous drop) is allowed; the merge-branch rule treats it by its
    // natural top-title state regardless of how it currently displays.
    if (sourceStack.hasUpChildren() && sourceStack.hasDownChildren()) {
      this._dropInvalid(rootId);
      return null;
    }

    const useDown = this._pickMergeBranch(rootId, destStack, dropCard);
    const leafId  = useDown ? destStack.downLeaf() : destStack.upLeaf();

    // Reject if attach would push the chain past the adjacency cap (15
    // outward positions per branch — the limit imposed by the u8 packing
    // of Action.participants).
    const attached = useDown ? Stack.attachDown(rootId, leafId)
                             : Stack.attachUp  (rootId, leafId);
    if (!attached) {
      this._dropInvalid(rootId);
      return null;
    }
    // Source root is now on the chosen branch; any pre-existing
    // opposite-branch descendants would orphan because CardStack walks a
    // single direction per branch.  Flip them to match.
    sourceStack.flipDescendants(useDown ? "down" : "up");

    // Sync the merged stack via the batched updatePositions reducer; the
    // server cancels any stale actions whose claim windows the merge
    // disturbed and re-runs the matcher, starting any newly-eligible
    // top_stack/bottom_stack recipes.  Action lifecycle propagates back
    // through the actions table subscription — UI doesn't drive it.
    this._syncStackPositions(destStack.participants());

    return dropCard;
  }

  private _dropInvalid(rootId: CardId): void {
    if (!client_cards[rootId]) return;
    setDragging(rootId, false);
    setAnimating(rootId, true);
    this._overlay.setReturnToOrigin(rootId);
  }

  // ─── Drop-target helpers ─────────────────────────────────────────────────

  private _inventoryDropTarget(
    inventory: Inventory,
    rootId:    CardId,
    _card:     ClientCard,
  ): { layer: number; macro_zone: MacroZone; micro_zone: MicroZone; micro_location: MicroLocation } {
    const pos = this._overlay.getEntryPosition(rootId);
    const macro_zone = packMacroPanel(inventory.getViewedId());
    if (!pos) {
      return {
        layer:          PANEL_LAYER_INVENTORY,
        macro_zone,
        micro_zone:     0,
        micro_location: packMicroPixel(0, 0),
      };
    }
    const local = inventory.toLocal(new Point(pos.x, pos.y));
    const cx = inventory.innerRect.x + inventory.innerRect.width  / 2;
    const cy = inventory.innerRect.y + inventory.innerRect.height / 2;
    const px = Math.round(local.x - cx);
    const py = Math.round(local.y - cy);
    return {
      layer:          PANEL_LAYER_INVENTORY,
      macro_zone,
      micro_zone:     0,
      micro_location: packMicroPixel(px, py),
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
  private _pickMergeBranch(rootId: CardId, destStack: Stack, dropCard: Card): boolean {
    if (isBottomTitleByDef(rootId)) return true;

    const destBottomTitle = getEffectiveTitleOnBottom(destStack.rootId);
    const hasOpposite     = destBottomTitle ? destStack.hasUpChildren() : destStack.hasDownChildren();

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
    return this._overlay.getCursor().y > centre.y;
  }

  /**
   * True if any non-passable card occupies (local_q, local_r) at this macro_zone.
   * Skips: ignoreId, dragging/animating cards, stacked cards, hidden cards,
   * and tile-type cards (they are the floor, not occupants).
   */
  private _isHexBlocked(macro_zone: MacroZone, local_q: number, local_r: number, ignoreId: CardId): boolean {
    const cardIds = macro_zone_cards.get(macro_zone);
    if (!cardIds) return false;
    for (const cid of cardIds) {
      if (cid === ignoreId) continue;
      const c = client_cards[cid];
      if (!c) continue;
      if (isDragging(cid) || isAnimating(cid)) continue;
      if (c.stacked_up || c.stacked_down)      continue;
      if (isHidden(cid))                       continue;
      if (c.local_q !== local_q || c.local_r !== local_r) continue;
      if (isPassableCardType(c.card_type)) continue;
      return true;
    }
    return false;
  }

  // ─── Misc ────────────────────────────────────────────────────────────────

  /** Snapshot of card_ids whose entries are currently in pickup-follow mode. */
  private _draggingRootIds(): CardId[] {
    const ids: CardId[] = [];
    for (const id in client_cards) {
      const cardId = Number(id);
      if (isDragging(cardId) && this._overlay.hasEntry(cardId)) ids.push(cardId);
    }
    return ids;
  }

  private _invalidateSource(src: SourceCache | null): void {
    if (!src) return;
    if (!src.hitCard.destroyed)                          src.hitCard.invalidateLayout();
    if (!src.hitStack.destroyed)                         src.hitStack.invalidateLayout();
    if (src.hitContainer && !src.hitContainer.destroyed) src.hitContainer.invalidateLayout();
  }
}
