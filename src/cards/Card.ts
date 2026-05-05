import type { CachedAction } from "../actions/ActionManager";
import { DefinitionManager } from "../definitions/DefinitionManager";
import { debug } from "../debug";
import type { GameContext } from "../GameContext";
import type { LayoutNode } from "../layout/LayoutNode";
import type { Card as CardRow } from "../server/bindings/types";
import type { ShadowedChange } from "../state/ShadowedStore";
import { packZoneId, type ZoneId } from "../zones/zoneId";
import {
  getStackedState,
  STACKED_ON_HEX,
  STACKED_ON_RECT_X,
  STACKED_ON_RECT_Y,
} from "./cardData";
import type { CardManager } from "./CardManager";
import type { GameCard } from "./GameCard";
import { GameHexCard, LayoutHexCard } from "./views/HexagonCard";
import type { LayoutCard } from "./views/LayoutCard";
import { GameRectCard, LayoutRectCard } from "./views/RectangleCard";

const INVENTORY_LAYER = 1;

export type StackDirection = "top" | "bottom" | "hex";

/** What `Card.setPosition` accepts. Loose = freely placed inventory xy;
 *  inventory = return to owner's inventory at given xy (resets layer/zone);
 *  stacked = pinned to another card's stack-host with a direction;
 *  world = placed at a specific world hex tile (q, r axial coords). */
export type CardPositionState =
  | { kind: "loose"; x: number; y: number }
  | { kind: "inventory"; x: number; y: number }
  | { kind: "stacked"; parentId: number; direction: StackDirection }
  | { kind: "world"; q: number; r: number };

export class Card {
  readonly cardId: number;
  readonly gameCard: GameCard;
  readonly layoutCard: LayoutCard;
  public currentAction: CachedAction | null = null;
  private readonly cardManager: CardManager;
  private unsubscribe: (() => void) | null = null;
  private unsubAction: (() => void) | null = null;
  private currentZoneId: ZoneId;
  /** card_id we're stacked on, or 0 when loose. Drives layout-side parenting:
   *  loose → zone surface, stacked → parent card's stackHost. */
  private currentParentId = 0;
  /** Mirror of `getStackedState(microZone)` in semantic form. null when loose. */
  private currentStackDirection: StackDirection | null = null;

  /**
   * Card stacked directly on top of us (state 1), or 0 if none. Public so
   * `CardManager.stack`'s chain-walk can read these without ceremony. The
   * authoritative state still lives in the child's row (microLocation +
   * microZone's stackedState bits); these are convenience back-pointers that
   * let us walk down a chain in O(1) per step instead of scanning every
   * card. Kept in sync by Card.onDataChange (incoming data) and Card.destroy
   * (removal).
   */
  public stackedTop = 0;
  /** Card stacked directly below us (state 2), or 0 if none. Same caveat. */
  public stackedBottom = 0;
  /** Rect card mounted on top of us (state 3, STACKED_ON_HEX), or 0 if none. */
  public stackedHex = 0;

  private static stackParentOf(row: CardRow): number {
    const state = getStackedState(row.microZone);
    if (state === STACKED_ON_RECT_X || state === STACKED_ON_RECT_Y || state === STACKED_ON_HEX) {
      return row.microLocation;
    }
    return 0;
  }

  private static stackDirectionOf(row: CardRow): StackDirection | null {
    const state = getStackedState(row.microZone);
    if (state === STACKED_ON_RECT_X) return "top";
    if (state === STACKED_ON_RECT_Y) return "bottom";
    if (state === STACKED_ON_HEX) return "hex";
    return null;
  }

  static create(
    cardId: number,
    ctx: GameContext,
    cardManager: CardManager,
  ): Card | null {
    const row = ctx.data.get("cards", cardId);
    if (!row) {
      debug.warn(["cards"], `[Card] no row for card ${cardId}, skipping spawn`);
      return null;
    }
    const { typeId } = DefinitionManager.unpack(row.packedDefinition);
    const shape = ctx.definitions.shape(typeId);
    if (shape === undefined) {
      debug.warn(["cards"], `[Card] unknown shape for typeId=${typeId} (card ${cardId}); defaulting to rect`);
    }
    if (shape === "hex") {
      return new Card(
        cardId,
        ctx,
        cardManager,
        new GameHexCard(cardId, ctx),
        new LayoutHexCard(cardId, ctx),
      );
    }
    return new Card(
      cardId,
      ctx,
      cardManager,
      new GameRectCard(cardId, ctx),
      new LayoutRectCard(cardId, ctx),
    );
  }

  constructor(
    cardId: number,
    ctx: GameContext,
    cardManager: CardManager,
    gameCard: GameCard,
    layoutCard: LayoutCard,
  ) {
    this.cardId = cardId;
    this.cardManager = cardManager;
    this.gameCard = gameCard;
    this.layoutCard = layoutCard;

    const initialRow = ctx.data.get("cards", cardId);
    this.currentZoneId = initialRow
      ? packZoneId(initialRow.macroZone, initialRow.layer)
      : Number.NaN;

    if (initialRow) {
      // Decide where this card lives on the layout tree before we apply data,
      // so applyData's setTarget calls are interpreted in the correct coord
      // space. Orphan stacked cards (parent missing) get rewritten loose to
      // the owner's inventory and then attached there.
      this.currentParentId = Card.stackParentOf(initialRow);
      this.currentStackDirection = Card.stackDirectionOf(initialRow);
      let row: CardRow = initialRow;
      if (this.currentParentId !== 0 && !cardManager.get(this.currentParentId)) {
        this.fallbackToInventory(initialRow);
        row = ctx.data.get("cards", cardId) ?? initialRow;
        this.currentZoneId = packZoneId(row.macroZone, row.layer);
        this.currentParentId = 0;
        this.currentStackDirection = null;
      }
      this.gameCard.applyData(row);
      this.layoutCard.applyData(row);
      this.attachToCurrent();
      // Best-effort back-pointer: if our parent already exists, claim our
      // slot on it. If the parent hasn't spawned yet, CardManager's
      // post-init repair pass picks it up.
      if (this.currentParentId !== 0 && this.currentStackDirection) {
        this.setBackPointerOn(this.currentParentId, this.currentStackDirection);
      }
    }

    this.unsubscribe = ctx.data.subscribeKey("cards", cardId, (change) => {
      this.onDataChange(change as ShadowedChange<CardRow>);
    });

    if (ctx.actions) {
      this.unsubAction = ctx.actions.subscribeCard(cardId, (action) => {
        this.currentAction = action;
        this.layoutCard.invalidate();
      });
    }
  }

  /**
   * Canonical setter for a card's position. Always go through here so we
   * (a) flow through the same setClient → onDataChange path the rest of the
   * system uses, which keeps the layout-side re-parent + tween + back-pointer
   * maintenance in lockstep with the data, and (b) callers don't need to
   * know about flag bit-fiddling or which slot to touch on which neighbor.
   *
   * The back-pointer cleanup (clearing our slot on the old parent if any,
   * claiming our slot on the new parent if stacked) happens in onDataChange
   * — single funnel for both our writes here and any server-driven update.
   */
  setPosition(state: CardPositionState): void {
    this.cardManager.setCardPosition(this.cardId, state);
  }

  private clearBackPointerOn(parentId: number, direction: StackDirection): void {
    const parent = this.cardManager.get(parentId);
    if (!parent) return;
    if (direction === "top") {
      if (parent.stackedTop === this.cardId) parent.stackedTop = 0;
    } else if (direction === "bottom") {
      if (parent.stackedBottom === this.cardId) parent.stackedBottom = 0;
    } else {
      if (parent.stackedHex === this.cardId) parent.stackedHex = 0;
    }
  }

  private setBackPointerOn(parentId: number, direction: StackDirection): void {
    const parent = this.cardManager.get(parentId);
    if (!parent) return;
    if (direction === "top") parent.stackedTop = this.cardId;
    else if (direction === "bottom") parent.stackedBottom = this.cardId;
    else parent.stackedHex = this.cardId;
  }

  /** Attach layoutCard to whichever surface matches our current state. */
  private attachToCurrent(): void {
    if (this.currentParentId !== 0) {
      const parent = this.cardManager.get(this.currentParentId);
      if (parent) {
        if (this.currentStackDirection === "hex" && parent.layoutCard.hexMount) {
          parent.layoutCard.hexMount.addChild(this.layoutCard);
        } else {
          this.layoutCard.attachToStack(
            parent.layoutCard,
            this.currentStackDirection === "bottom" ? "bottom" : "top",
          );
        }
        return;
      }
      // Defensive: parent vanished between routing and attach. Fall through
      // to the zone surface so the card is at least visible.
    }
    this.layoutCard.attach(this.currentZoneId);
  }

  /**
   * Re-parent layoutCard preserving on-screen position via global→local
   * conversion. Used when zone or stack-parent changes after the initial
   * spawn — keeps the visual transition seamless rather than snapping.
   */
  private reparentSmoothly(newParent: LayoutNode | null): void {
    const g = this.layoutCard.container.getGlobalPosition();
    this.layoutCard.detach();
    if (!newParent) return;
    newParent.addChild(this.layoutCard);
    const sg = newParent.container.getGlobalPosition();
    this.layoutCard.setDisplayPosition(g.x - sg.x, g.y - sg.y);
  }

  /**
   * Stacked card whose parent doesn't exist — orphan. Writes a corrected
   * loose row into DataManager. `setClientCard` fires subscribers, so the
   * post-init data path will see the fixed row through onDataChange too.
   */
  private fallbackToInventory(row: CardRow): void {
    this.layoutCard.ctx.data.setClientCard({
      ...row,
      macroZone: row.ownerId,
      layer: INVENTORY_LAYER,
      // microZone: 0 clears localQ/localR/stackedState — fully resets the
      // packed sub-fields since none of them are meaningful for a loose card
      // dropped into the owner's inventory.
      microZone: 0,
      microLocation: 0,
    });
  }

  zoneId(): ZoneId {
    return this.currentZoneId;
  }

  whereAreYou(): { x: number; y: number } {
    return this.gameCard.whereAreYou();
  }

  /**
   * Forwards drag state to both halves so game logic (overlap-push skip) and
   * visual state stay in sync. On drag start, also re-parents the layout half
   * from its zone surface up to the global overlay so the card can roam
   * freely above the rest of the scene; on drag stop, returns it to the
   * surface for its current zone. The on-screen position is preserved across
   * each re-parent (display is converted between coord spaces) so the
   * transition is seamless.
   *
   * `offsetX` / `offsetY` are the cursor → card top-left offsets at grab time
   * (in surface-local coords). They get plumbed to LayoutCard which uses them
   * to keep the card under the cursor while dragging.
   */
  setDragging(value: boolean, offsetX = 0, offsetY = 0): void {
    this.gameCard.setDragging(value);
    if (value) {
      const overlay = this.layoutCard.ctx.layout?.overlay;
      if (overlay) {
        const g = this.layoutCard.container.getGlobalPosition();
        this.layoutCard.detach();
        overlay.addChild(this.layoutCard);
        this.layoutCard.setDisplayPosition(g.x, g.y);
      }
      this.layoutCard.setDragging(true, offsetX, offsetY);
    } else {
      const g = this.layoutCard.container.getGlobalPosition();
      this.layoutCard.detach();
      // Re-attach to whatever the current data implies: stackHost for a
      // stacked card, zone surface for a loose one. If the drop ends up
      // changing state (loose → stack, stack → loose, stack → other parent),
      // onDataChange will reparent again — but landing on the right surface
      // here means a "drop on same parent" path doesn't strand us on the
      // zone surface when no data actually changes.
      this.attachToCurrent();
      // Use the actual PIXI parent (e.g. worldCardLayer) rather than the
      // LayoutNode surface's container, which may differ for world cards.
      const pixiParent = this.layoutCard.container.parent;
      if (pixiParent) {
        const sg = pixiParent.getGlobalPosition();
        this.layoutCard.setDisplayPosition(g.x - sg.x, g.y - sg.y);
      }
      this.layoutCard.setDragging(false);
    }
  }

  isDragging(): boolean {
    return this.gameCard.isDragging();
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubAction?.();
    this.unsubAction = null;
    // Free our slot on the parent so its back-pointer doesn't dangle.
    if (this.currentParentId !== 0 && this.currentStackDirection) {
      this.clearBackPointerOn(this.currentParentId, this.currentStackDirection);
    }
    this.gameCard.destroy();
    this.layoutCard.destroy();
  }

  private onDataChange(change: ShadowedChange<CardRow>): void {
    if (change.kind === "delete") return;
    const row = change.newValue;
    if (!row) return;

    const newZoneId = packZoneId(row.macroZone, row.layer);
    const newParentId = Card.stackParentOf(row);
    const newStackDirection = Card.stackDirectionOf(row);
    const zoneChanged = newZoneId !== this.currentZoneId;
    const parentChanged = newParentId !== this.currentParentId;
    const directionChanged = newStackDirection !== this.currentStackDirection;

    if (zoneChanged || parentChanged || directionChanged) {
      // Resolve the new attach target before mutating state, so we can early-
      // out cleanly on orphan without leaving currentZoneId / currentParentId
      // in a half-updated state. Direction-only changes (same parent, top↔
      // bottom) don't move us between surfaces — only the layout target
      // shifts, which applyData handles.
      let nextParent: LayoutNode | null = null;
      const reparentNeeded = zoneChanged || parentChanged;
      if (reparentNeeded) {
        if (newParentId !== 0) {
          const parent = this.cardManager.get(newParentId);
          if (!parent) {
            // Orphan — write a corrected row. setClient fires this same
            // subscriber synchronously, and that recursive pass (with
            // newParentId === 0) does the actual re-parent.
            this.fallbackToInventory(row);
            return;
          }
          nextParent = (newStackDirection === "hex" && parent.layoutCard.hexMount)
            ? parent.layoutCard.hexMount
            : newStackDirection === "bottom"
              ? parent.layoutCard.stackBottomHost
              : parent.layoutCard.stackTopHost;
        } else {
          nextParent = this.layoutCard.ctx.layout?.surfaceFor(newZoneId) ?? null;
        }
      }

      if (zoneChanged) {
        const oldZoneId = this.currentZoneId;
        this.currentZoneId = newZoneId;
        this.cardManager.move(this.cardId, oldZoneId, newZoneId);
      }

      // Capture old parent before we mutate it, so we can fire a stack-
      // change event for the chain we're leaving. The new chain's root we
      // resolve from newParentId (or this card itself when becoming loose).
      const oldParentId = this.currentParentId;
      const oldDirection = this.currentStackDirection;

      // Back-pointer maintenance: clear our slot on the old parent (if we had
      // one) and claim our slot on the new parent (if stacked).
      if (parentChanged || directionChanged) {
        if (oldParentId !== 0 && oldDirection) {
          this.clearBackPointerOn(oldParentId, oldDirection);
        }
        this.currentParentId = newParentId;
        this.currentStackDirection = newStackDirection;
        if (newParentId !== 0 && newStackDirection) {
          this.setBackPointerOn(newParentId, newStackDirection);
        }
      }

      if (reparentNeeded) this.reparentSmoothly(nextParent);

      // Fire stack-change events for both affected chains. A chain is
      // "affected" if this card joined or left it; when both old and new
      // resolve to the same root (e.g. direction-only change on the same
      // parent) we only fire once. Loose-to-loose moves don't enter this
      // block so they don't fire — that matches the spec ("any case that
      // wasn't a rejected drop or a loose -> loose drop").
      if (parentChanged || directionChanged) {
        const oldRoot =
          oldParentId !== 0 && oldDirection !== "hex"
            ? this.cardManager.rootOf(oldParentId)
            : this.cardId;
        const newRoot =
          newParentId !== 0 && newStackDirection !== "hex"
            ? this.cardManager.rootOf(newParentId)
            : this.cardId;
        this.cardManager.fireStackChange(oldRoot);
        if (newRoot !== oldRoot) this.cardManager.fireStackChange(newRoot);
      }
    }

    this.gameCard.applyData(row);
    this.layoutCard.applyData(row);
  }
}
