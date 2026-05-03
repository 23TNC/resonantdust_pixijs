import { DefinitionManager } from "../definitions/DefinitionManager";
import type { GameContext } from "../GameContext";
import type { LayoutNode } from "../layout/LayoutNode";
import type { Card as CardRow } from "../server/bindings/types";
import type { ShadowedChange } from "../state/ShadowedStore";
import { packZoneId, type ZoneId } from "../zones/zoneId";
import {
  clearStackedState,
  getStackedState,
  STACKED_ON_RECT_X,
} from "./cardData";
import type { CardManager } from "./CardManager";
import type { GameCard } from "./GameCard";
import { GameHexCard, LayoutHexCard } from "./HexagonCard";
import type { LayoutCard } from "./LayoutCard";
import { GameRectCard, LayoutRectCard } from "./RectangleCard";

const INVENTORY_LAYER = 1;

export class Card {
  readonly cardId: number;
  readonly gameCard: GameCard;
  readonly layoutCard: LayoutCard;
  private readonly cardManager: CardManager;
  private unsubscribe: (() => void) | null = null;
  private currentZoneId: ZoneId;
  /** card_id we're stacked on, or 0 when loose. Drives layout-side parenting:
   *  loose → zone surface, stacked → parent card's stackHost. */
  private currentParentId = 0;

  private static stackParentOf(row: CardRow): number {
    return getStackedState(row.flags) === STACKED_ON_RECT_X
      ? row.microLocation
      : 0;
  }

  static create(
    cardId: number,
    ctx: GameContext,
    cardManager: CardManager,
  ): Card | null {
    const row = ctx.data.get("cards", cardId);
    if (!row) {
      console.warn(`[Card] no row for card ${cardId}, skipping spawn`);
      return null;
    }
    const { typeId } = DefinitionManager.unpack(row.packedDefinition);
    const shape = ctx.definitions.shape(typeId);
    if (shape === undefined) {
      console.warn(
        `[Card] unknown shape for typeId=${typeId} (card ${cardId}); defaulting to rect`,
      );
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
      let row = initialRow;
      if (this.currentParentId !== 0 && !cardManager.get(this.currentParentId)) {
        row = this.fallbackToInventory(initialRow);
        this.currentZoneId = packZoneId(row.macroZone, row.layer);
        this.currentParentId = 0;
      }
      this.gameCard.applyData(row);
      this.layoutCard.applyData(row);
      this.attachToCurrent();
    }

    this.unsubscribe = ctx.data.subscribeKey("cards", cardId, (change) => {
      this.onDataChange(change as ShadowedChange<CardRow>);
    });
  }

  /** Attach layoutCard to whichever surface matches our current state. */
  private attachToCurrent(): void {
    if (this.currentParentId !== 0) {
      const parent = this.cardManager.get(this.currentParentId);
      if (parent) {
        this.layoutCard.attachToStack(parent.layoutCard);
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
   * Stacked card whose parent doesn't exist — orphan. Rewrite the row to
   * loose in the owner's inventory and return the corrected row so the
   * caller can apply it. The setClient also fires subscribers, so the
   * post-init data path will see the fixed row through onDataChange too.
   */
  private fallbackToInventory(row: CardRow): CardRow {
    const fixed: CardRow = {
      ...row,
      macroZone: row.ownerId,
      layer: INVENTORY_LAYER,
      microZone: 0,
      flags: clearStackedState(row.flags),
      microLocation: 0,
    };
    this.layoutCard.ctx.data.cards.setClient(fixed);
    return fixed;
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
      this.layoutCard.attach(this.currentZoneId);
      const surface = this.layoutCard.parent;
      if (surface) {
        const sg = surface.container.getGlobalPosition();
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
    this.gameCard.destroy();
    this.layoutCard.destroy();
  }

  private onDataChange(change: ShadowedChange<CardRow>): void {
    if (change.kind === "delete") return;
    const row = change.newValue;
    if (!row) return;

    const newZoneId = packZoneId(row.macroZone, row.layer);
    const newParentId = Card.stackParentOf(row);
    const zoneChanged = newZoneId !== this.currentZoneId;
    const parentChanged = newParentId !== this.currentParentId;

    if (zoneChanged || parentChanged) {
      // Resolve the new attach target before mutating state, so we can early-
      // out cleanly on orphan without leaving currentZoneId / currentParentId
      // in a half-updated state.
      let nextParent: LayoutNode | null;
      if (newParentId !== 0) {
        const parent = this.cardManager.get(newParentId);
        if (!parent) {
          // Orphan — write a corrected row. setClient fires this same
          // subscriber synchronously, and that recursive pass (with
          // newParentId === 0) does the actual re-parent.
          this.fallbackToInventory(row);
          return;
        }
        nextParent = parent.layoutCard.stackHost;
      } else {
        nextParent = this.layoutCard.ctx.layout?.surfaceFor(newZoneId) ?? null;
      }

      if (zoneChanged) {
        const oldZoneId = this.currentZoneId;
        this.currentZoneId = newZoneId;
        this.cardManager.move(this.cardId, oldZoneId, newZoneId);
      }
      this.currentParentId = newParentId;

      this.reparentSmoothly(nextParent);
    }

    this.gameCard.applyData(row);
    this.layoutCard.applyData(row);
  }
}
