import type { Card } from "../cards/Card";
import { LayoutCard } from "../cards/LayoutCard";
import { GameRectCard } from "../cards/RectangleCard";
import type { GameContext } from "../GameContext";
import type { LayoutNode } from "../layout/LayoutNode";
import type { PointerEventData } from "./InputManager";

interface DragState {
  card: Card;
  /** Cursor → card top-left, captured at drag start in surface-local coords. */
  offsetX: number;
  offsetY: number;
  /** The zone surface the card was on when the drag started (used to convert
   *  the up-event's canvas coords into surface-local coords for the data
   *  write at drop time). */
  surface: LayoutNode;
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
    if (!card.gameCard.isLoose()) return;

    const surface = data.hit.parent;
    if (!surface) return;

    const cardGlobal = data.hit.container.getGlobalPosition();
    const offsetX = data.x - cardGlobal.x;
    const offsetY = data.y - cardGlobal.y;

    this.state = { card, offsetX, offsetY, surface };
    card.setDragging(true, offsetX, offsetY);
  }

  private handleDragStop(_down: PointerEventData, up: PointerEventData): void {
    if (!this.state) return;
    const { card, offsetX, offsetY, surface } = this.state;
    this.state = null;

    // Clear drag state first so the card re-parents back to its zone surface
    // (display position preserved). After this, applyData targets are
    // interpreted in the correct (zone-surface) coord space.
    card.setDragging(false);

    // Write the drop location once, converted from canvas to surface-local.
    // This is the same data path GameInventory uses for overlap-push — the
    // card's tween catches up visually on the next frame.
    if (card.gameCard instanceof GameRectCard && card.gameCard.isLoose()) {
      const sg = surface.container.getGlobalPosition();
      const newX = up.x - sg.x - offsetX;
      const newY = up.y - sg.y - offsetY;
      card.gameCard.setLoosePosition(newX, newY);
    }

    // TODO: cross-zone drops (compute new macroZone/layer/microZone from
    // up.hit's zone), drop-target reducer calls, recipe placements.
  }
}
