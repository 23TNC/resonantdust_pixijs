import type { Card, StackDirection } from "../cards/Card";
import { LayoutCard } from "../cards/LayoutCard";
import { GameRectCard } from "../cards/RectangleCard";
import type { GameContext } from "../GameContext";
import type { LayoutNode } from "../layout/LayoutNode";
import type { PointerEventData } from "./InputManager";

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
    if (!(card.gameCard instanceof GameRectCard)) return;

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

    // If we dropped on another card, stack onto it. The dragged card was
    // parented to the hit-transparent overlay during the drag, so the up
    // event's hit-test fell through to whatever was beneath. Drop on a
    // peeking title from a chain returns the child link; CardManager.stack
    // walks down to the actual leaf so we always land at the chain's end.
    const target = this.targetCardFromHit(up.hit, card.cardId);
    if (target) {
      const direction = this.directionFromCursor(up, target);
      this.ctx.cards?.stack(card.cardId, target.cardId, direction);
      return;
    }

    // No card under the cursor — write a loose position. Look the zone
    // surface up fresh (rather than using whatever the card was parented to
    // at drag start) because for a stacked-source drag that was a stackHost,
    // not the inventory's coord space we need for loose xy.
    if (card.gameCard instanceof GameRectCard) {
      const surface = this.ctx.layout?.surfaceFor(card.zoneId());
      if (surface) {
        const sg = surface.container.getGlobalPosition();
        const newX = up.x - sg.x - offsetX;
        const newY = up.y - sg.y - offsetY;
        card.setPosition({ kind: "loose", x: newX, y: newY });
      }
    }

    // TODO: cross-zone drops (propagate target's macroZone/layer to the
    // dragged card on stack), drop-target reducer calls, recipe placements.
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
