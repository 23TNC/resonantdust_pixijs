import { DefinitionManager } from "../definitions/DefinitionManager";
import type { GameContext } from "../GameContext";
import type { Card as CardRow } from "../server/bindings/types";
import type { ShadowedChange } from "../state/ShadowedStore";
import { packZoneId, type ZoneId } from "../zones/zoneId";
import type { CardManager } from "./CardManager";
import type { GameCard } from "./GameCard";
import { GameHexCard, LayoutHexCard } from "./HexagonCard";
import type { LayoutCard } from "./LayoutCard";
import { GameRectCard, LayoutRectCard } from "./RectangleCard";

export class Card {
  readonly cardId: number;
  readonly gameCard: GameCard;
  readonly layoutCard: LayoutCard;
  private readonly cardManager: CardManager;
  private unsubscribe: (() => void) | null = null;
  private currentZoneId: ZoneId;

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

    const row = ctx.data.get("cards", cardId);
    this.currentZoneId = row
      ? packZoneId(row.macroZone, row.layer)
      : Number.NaN;

    if (row) {
      this.gameCard.applyData(row);
      this.layoutCard.applyData(row);
      this.layoutCard.attach(this.currentZoneId);
    }

    this.unsubscribe = ctx.data.subscribeKey("cards", cardId, (change) => {
      this.onDataChange(change as ShadowedChange<CardRow>);
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
    if (newZoneId !== this.currentZoneId) {
      const oldZoneId = this.currentZoneId;
      this.currentZoneId = newZoneId;
      this.layoutCard.detach();
      this.cardManager.move(this.cardId, oldZoneId, newZoneId);
      this.layoutCard.attach(newZoneId);
    }

    this.gameCard.applyData(row);
    this.layoutCard.applyData(row);
  }
}
