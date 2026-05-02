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
  private readonly ctx: GameContext;
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
    this.ctx = ctx;
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
