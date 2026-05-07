import type { Card, StackDirection } from "../cards/Card";
import { GameHexCard } from "../cards/HexagonCard";
import { LayoutCard } from "../cards/LayoutCard";
import { GameRectCard } from "../cards/RectangleCard";
import type { GameContext } from "../GameContext";
import type { LayoutNode } from "../layout/LayoutNode";
import { WORLD_LAYER } from "../world/worldCoords";
import { packZoneId } from "../zones/zoneId";
import type { PointerEventData } from "./InputManager";
import { FLAG_CARD_POSITION_HOLD, FLAG_CARD_POSITION_LOCKED } from "../state/DataManager";

interface DragState {
  card: Card;
  /** Cursor → card top-left in canvas coords, captured at drag start. */
  offsetX: number;
  offsetY: number;
}

/**
 * Scene-scoped drag orchestrator. Subscribes to `left_drag_start` /
 * `left_drag_stop` from `InputManager` and manages drag-gesture state
 * (which card, with what offset). The visual cursor-follow is owned by
 * `LayoutCard.layout()`, which reads `InputManager.lastPointer` while
 * `state.dragging` is true — DragManager does NOT update card position
 * during the drag.
 *
 * On drop, DragManager writes the new `microLocation` once via `setClient`
 * — that's just a data update like `GameInventory.tryPush` does, not a
 * visual driver. Card data flows through the same path the rest of the
 * game uses; the card's visual catches up via tween from its current
 * (cursor-follow) display position to the new data-driven target.
 */
export class DragManager {
  private state: DragState | null = null;
  private readonly unsubStart: () => void;
  private readonly unsubStop: () => void;

  constructor(private readonly ctx: GameContext) {
    if (!ctx.input) {
      throw new Error("[DragManager] ctx.input is null — InputManager must exist");
    }

    this.unsubStart = ctx.input.on("left_drag_start", (data) => {
      this.handleDragStart(data);
    });
    this.unsubStop = ctx.input.on("left_drag_stop", ({ down, up }) => {
      this.handleDragStop(down, up);
    });
  }

  dispose(): void {
    if (this.state) {
      this.state.card.setDragging(false);
      this.state = null;
    }
    this.unsubStart();
    this.unsubStop();
  }

  private handleDragStart(data: PointerEventData): void {
    if (this.state) return;
    if (!(data.hit instanceof LayoutCard)) return;

    const card = this.ctx.cards?.get(data.hit.cardId);
    if (!card) return;
    if (!(card.gameCard instanceof GameRectCard) && !(card.gameCard instanceof GameHexCard)) return;

    const cardRow = this.ctx.data.get("cards", data.hit.cardId);
    const DRAG_BLOCK = FLAG_CARD_POSITION_HOLD | FLAG_CARD_POSITION_LOCKED;
    if (cardRow && (cardRow.flags & DRAG_BLOCK) !== 0) return;

    // Stacked cards are draggable too — dropping them on another card
    // re-stacks, dropping on empty space converts to loose (unstack). Both
    // paths flow through Card.setPosition so the linked-list back-pointers
    // stay consistent.

    const cardGlobal = data.hit.container.getGlobalPosition();
    const offsetX = data.x - cardGlobal.x;
    const offsetY = data.y - cardGlobal.y;

    this.state = { card, offsetX, offsetY };
    card.setDragging(true, offsetX, offsetY);
  }

  private handleDragStop(_down: PointerEventData, up: PointerEventData): void {
    if (!this.state) return;
    const { card, offsetX, offsetY } = this.state;
    this.state = null;

    // Clear drag state first so the card re-parents back to whichever
    // surface its current data implies (zone surface for loose, parent's
    // stackHost for stacked). Display position is preserved across the
    // re-parent, so the visual stays put while we resolve the drop.
    card.setDragging(false);

    if (card.gameCard instanceof GameRectCard) {
      this.handleRectDrop(card, up, offsetX, offsetY);
    } else if (card.gameCard instanceof GameHexCard) {
      this.handleHexDrop(card, up, offsetX, offsetY);
    }
  }

  private handleRectDrop(
    card: Card,
    up: PointerEventData,
    offsetX: number,
    offsetY: number,
  ): void {
    // Stack onto another rect card if one is under the cursor. The dragged
    // card was parented to the hit-transparent overlay, so the up event's
    // hit-test fell through to whatever was beneath. Drop on a peeking title
    // returns the child; CardManager.stack walks to the actual leaf.
    const target = this.targetCardFromHit(up.hit, card.cardId);
    if (target) {
      if (target.gameCard instanceof GameRectCard) {
        const direction = this.directionFromCursor(up, target);
        this.ctx.cards?.stack(card.cardId, target.cardId, direction);
        return;
      }
      if (target.gameCard instanceof GameHexCard) {
        if (target.stackedHex === 0) {
          this.ctx.cards?.setCardPosition(card.cardId, {
            kind: "stacked",
            parentId: target.cardId,
            direction: "hex",
          });
          return;
        }
      }
    }
    // Drop onto the world surface if the cursor is over it.
    const worldSurface = this.ctx.world;
    if (worldSurface) {
      const wg = worldSurface.container.getGlobalPosition();
      const localX = up.x - wg.x;
      const localY = up.y - wg.y;
      if (localX >= 0 && localX <= worldSurface.width && localY >= 0 && localY <= worldSurface.height) {
        const { q, r } = worldSurface.localToWorld(localX, localY);
        card.setPosition({ kind: "world", q, r });
        return;
      }
    }
    // No valid target — drop loose in the same zone.
    this.dropLoose(card, up, offsetX, offsetY);
    // TODO: cross-zone drops
  }

  private handleHexDrop(
    card: Card,
    up: PointerEventData,
    offsetX: number,
    offsetY: number,
  ): void {
    const worldSurface = this.ctx.world;
    if (worldSurface) {
      const wg = worldSurface.container.getGlobalPosition();
      const localX = up.x - wg.x;
      const localY = up.y - wg.y;
      if (localX >= 0 && localX <= worldSurface.width && localY >= 0 && localY <= worldSurface.height) {
        const { q, r } = worldSurface.localToWorld(localX, localY);
        card.setPosition({ kind: "world", q, r });
        return;
      }
    }
    // Not over the world — drop loose in same zone.
    this.dropLoose(card, up, offsetX, offsetY);
  }

  private dropLoose(
    card: Card,
    up: PointerEventData,
    offsetX: number,
    offsetY: number,
  ): void {
    const row = this.ctx.data.get("cards", card.cardId);
    if (row && row.layer >= WORLD_LAYER) {
      // World card dropped outside world surface — return to owner's inventory.
      const inventoryZoneId = packZoneId(row.ownerId, 1);
      const surface = this.ctx.layout?.surfaceFor(inventoryZoneId);
      if (surface) {
        const sg = surface.container.getGlobalPosition();
        card.setPosition({ kind: "inventory", x: up.x - sg.x - offsetX, y: up.y - sg.y - offsetY });
        return;
      }
    }
    // Look the zone surface up fresh (rather than using whatever the card was
    // parented to at drag start) — for a stacked-source drag that was a
    // stackHost, not the inventory coord space we need for loose xy.
    const surface = this.ctx.layout?.surfaceFor(card.zoneId());
    if (!surface) return;
    const sg = surface.container.getGlobalPosition();
    card.setPosition({ kind: "loose", x: up.x - sg.x - offsetX, y: up.y - sg.y - offsetY });
  }

  private targetCardFromHit(
    hit: LayoutNode | null,
    draggedId: number,
  ): Card | null {
    if (!(hit instanceof LayoutCard)) return null;
    if (hit.cardId === draggedId) return null;
    return this.ctx.cards?.get(hit.cardId) ?? null;
  }

  /**
   * Upper half of the target → top stack; lower half → bottom stack. Maps
   * intuitively to the visual: drop near where you want the new card's
   * peeking titlebar to appear. Works the same for peeking-title hits since
   * those titles are at the top/bottom edge of their own card.
   */
  private directionFromCursor(
    up: PointerEventData,
    target: Card,
  ): StackDirection {
    const g = target.layoutCard.container.getGlobalPosition();
    const localY = up.y - g.y;
    return localY < target.layoutCard.height / 2 ? "top" : "bottom";
  }
}
