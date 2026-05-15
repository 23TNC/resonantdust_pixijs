import { Container, Graphics, Text } from "pixi.js";
import type { GameContext } from "../../GameContext";
import type { LocalCard } from "../../server/data/DataManager";
import { LayoutNode } from "../../game/layout/LayoutNode";
import { LayoutHexCard } from "../../game/cards/layout/hexagon/HexCard";
import { RECT_CARD_HEIGHT, RECT_CARD_WIDTH } from "../../game/cards/layout/rectangle/RectCard";
import { RectCardVisual } from "../../game/cards/layout/rectangle/RectVisual";
import { HexCardVisual } from "../../game/cards/layout/hexagon/HexVisual";
import { GRID_H, GRID_W } from "../../game/inventory/InventoryGame";

const PANEL_BG = 0x0e1218;
const PADDING = 16;

/**
 * Left-panel display for select-mode. Shows every card with
 * `owner_id == soulCardId` for the currently-selected soul,
 * arranged on the same `GRID_W × GRID_H` cells the inventory uses
 * in-game.
 *
 * Selection state lives on the layout (the right-side chooser
 * owns "which soul is picked"); this panel just renders whatever
 * `setSoulId(id)` says. `null` (no soul selected yet) renders an
 * empty placeholder so the player sees something instructive
 * instead of a blank rectangle.
 *
 * Subscription scope is the *caller's* responsibility — the scene
 * fires `subscribeOwnedCards(soulId)` when the selection shifts so
 * the soul's inventory rows actually arrive in `cardsLocal`.
 * Without that, the filter below finds nothing.
 */
export class SoulInventoryPanel extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly placeholder: Text;
  private readonly cardsContainer = new Container();
  private readonly visuals = new Map<number, Container>();
  private readonly unsubLocalCard: () => void;
  private readonly gameContext: GameContext;
  private soulId: number | null = null;

  constructor(ctx: GameContext) {
    super();
    this.gameContext = ctx;

    this.placeholder = new Text({
      text: "Select a character to view their cards.",
      style: { fill: 0xa0a0b0, fontFamily: "sans-serif", fontSize: 14 },
    });
    this.placeholder.anchor.set(0.5);

    this.container.addChild(this.bg);
    this.container.addChild(this.placeholder);
    this.container.addChild(this.cardsContainer);

    this.unsubLocalCard = this.gameContext.data.subscribeLocalCard((change) => {
      if (this.soulId === null) return;
      if (change.kind === "removed") {
        this.removeVisual(change.key);
        return;
      }
      const row = change.kind === "added" ? change.row : change.newRow;
      const wasOurs = this.visuals.has(change.key);
      const isOurs = row.ownerId === this.soulId;
      if (isOurs) {
        this.upsertVisual(row);
      } else if (wasOurs) {
        this.removeVisual(change.key);
      }
    });
  }

  override destroy(): void {
    this.unsubLocalCard();
    this.clearVisuals();
    super.destroy();
  }

  /** Swap which soul's inventory to display. Tears down the prior
   *  soul's visuals and rebuilds from `cardsLocal` filtered by the
   *  new id. Pass `null` to clear back to the placeholder. */
  setSoulId(soulId: number | null): void {
    if (this.soulId === soulId) return;
    this.soulId = soulId;
    this.clearVisuals();
    if (soulId !== null) {
      for (const row of this.gameContext.data.cardsLocal.values()) {
        if (row.ownerId === soulId) this.upsertVisual(row);
      }
    }
    this.invalidate();
  }

  private clearVisuals(): void {
    for (const visual of this.visuals.values()) {
      this.cardsContainer.removeChild(visual);
      visual.destroy({ children: true });
    }
    this.visuals.clear();
  }

  private upsertVisual(row: LocalCard): void {
    const def = row.def ?? this.gameContext.definitions.decode(row.packedDefinition);
    const typeId = (row.packedDefinition >> 12) & 0xf;
    const isHex = this.gameContext.definitions.shape(typeId) === "hex";

    let visual = this.visuals.get(row.cardId);
    if (visual === undefined) {
      visual = isHex ? new HexCardVisual(LayoutHexCard.RADIUS) : new RectCardVisual();
      this.cardsContainer.addChild(visual);
      this.visuals.set(row.cardId, visual);
    }
    if (visual instanceof RectCardVisual) visual.draw(def);
    else if (visual instanceof HexCardVisual) visual.draw(def);
    this.invalidate();
  }

  private removeVisual(cardId: number): void {
    const visual = this.visuals.get(cardId);
    if (visual === undefined) return;
    this.cardsContainer.removeChild(visual);
    visual.destroy({ children: true });
    this.visuals.delete(cardId);
    this.invalidate();
  }

  protected override layout(): void {
    this.bg.clear().rect(0, 0, this.width, this.height).fill({ color: PANEL_BG });

    if (this.soulId === null || this.visuals.size === 0) {
      this.placeholder.visible = true;
      this.placeholder.text = this.soulId === null
        ? "Select a character to view their cards."
        : "This character has no cards yet.";
      this.placeholder.position.set(this.width / 2, this.height / 2);
    } else {
      this.placeholder.visible = false;
    }

    // Inventory-style grid: GRID_W × GRID_H cells, centered.
    // Cards anchor at the cell's interior.
    const innerWidth = Math.max(0, this.width - PADDING * 2);
    const cellsPerRow = Math.max(1, Math.floor(innerWidth / GRID_W));
    const usedWidth = cellsPerRow * GRID_W;
    const ox = PADDING + (innerWidth - usedWidth) / 2;
    const oy = PADDING;

    let i = 0;
    for (const visual of this.visuals.values()) {
      const col = i % cellsPerRow;
      const row = Math.floor(i / cellsPerRow);
      const cellX = ox + col * GRID_W;
      const cellY = oy + row * GRID_H;
      const w = visualWidth(visual);
      const h = visualHeight(visual);
      visual.position.set(cellX + (GRID_W - w) / 2, cellY + (GRID_H - h) / 2);
      i++;
    }
  }
}

function visualWidth(child: Container): number {
  if (child instanceof RectCardVisual) return RECT_CARD_WIDTH;
  if (child instanceof HexCardVisual) return LayoutHexCard.WIDTH;
  return child.width;
}

function visualHeight(child: Container): number {
  if (child instanceof RectCardVisual) return RECT_CARD_HEIGHT;
  if (child instanceof HexCardVisual) return LayoutHexCard.HEIGHT;
  return child.height;
}
