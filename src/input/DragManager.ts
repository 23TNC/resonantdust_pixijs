import type { Card } from "../cards/Card";
import { LayoutCard } from "../cards/LayoutCard";
import { GameRectCard } from "../cards/RectangleCard";
import type { GameContext } from "../GameContext";
import type { LayoutNode } from "../layout/LayoutNode";
import type { PointerEventData } from "./InputManager";

interface DragState {
  card: Card;
  offsetX: number;
  offsetY: number;
  surface: LayoutNode;
}

/**
 * Scene-scoped drag orchestrator. Subscribes to `left_drag_start` /
 * `left_drag_stop` from `InputManager`. While a drag is active, owns its own
 * `pointermove` listener on the canvas — so we pay the per-move cost only
 * when something is actually moving (no always-on hit-test, no event
 * allocation otherwise).
 *
 * Currently handles loose `GameRectCard` only: writes new `microLocation`
 * via `setClient` on each pointermove. Stacked cards aren't directly
 * draggable yet (drag the stack root instead — future).
 */
export class DragManager {
  private state: DragState | null = null;
  private readonly unsubStart: () => void;
  private readonly unsubStop: () => void;
  private readonly onPointerMove: (e: PointerEvent) => void;

  constructor(
    private readonly ctx: GameContext,
    private readonly canvas: HTMLCanvasElement,
  ) {
    if (!ctx.input) {
      throw new Error("[DragManager] ctx.input is null — InputManager must exist");
    }

    this.onPointerMove = this.handlePointerMove.bind(this);

    this.unsubStart = ctx.input.on("left_drag_start", (data) => {
      this.handleDragStart(data);
    });
    this.unsubStop = ctx.input.on("left_drag_stop", ({ down, up }) => {
      this.handleDragStop(down, up);
    });
  }

  dispose(): void {
    if (this.state) {
      this.canvas.removeEventListener("pointermove", this.onPointerMove);
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
    card.setDragging(true);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.state) return;
    if (!(this.state.card.gameCard instanceof GameRectCard)) return;

    const rect = this.canvas.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;

    const surfaceGlobal = this.state.surface.container.getGlobalPosition();
    const newX = cursorX - surfaceGlobal.x - this.state.offsetX;
    const newY = cursorY - surfaceGlobal.y - this.state.offsetY;

    this.state.card.gameCard.setLoosePosition(newX, newY);
  }

  private handleDragStop(_down: PointerEventData, _up: PointerEventData): void {
    if (!this.state) return;

    this.state.card.setDragging(false);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);

    // TODO: inspect _up.hit for cross-zone drops, drop-target reducer calls,
    // recipe placements, etc. For inventory-internal drags, the card is
    // already at the new position from setLoosePosition during the drag.

    this.state = null;
  }
}
