import type { GameContext } from "../GameContext";
import { LayoutNode } from "../layout/LayoutNode";
import type { Card as CardRow } from "../server/bindings/types";
import type { ZoneId } from "../zones/zoneId";

/**
 * Visual state flags that consumers (input handling, optimistic UI) toggle on
 * a card. Independent of `packed_definition` — flag changes invalidate layout
 * and let subclasses redraw a cheap overlay without re-running expensive
 * definition decoding or base painting.
 */
export interface CardVisualState {
  hovered: boolean;
  dragging: boolean;
  selected: boolean;
  /** Server-ack pending — typically rendered as a tinted strip or fade. */
  pending: boolean;
}

const DEFAULT_STATE: CardVisualState = {
  hovered: false,
  dragging: false,
  selected: false,
  pending: false,
};

export abstract class LayoutCard extends LayoutNode {
  readonly cardId: number;
  protected readonly state: CardVisualState = { ...DEFAULT_STATE };

  constructor(cardId: number, ctx: GameContext) {
    super();
    this.cardId = cardId;
    this.setContext(ctx);
  }

  abstract applyData(row: CardRow): void;

  setHovered(value: boolean): void {
    if (this.state.hovered === value) return;
    this.state.hovered = value;
    this.invalidate();
  }

  setDragging(value: boolean): void {
    if (this.state.dragging === value) return;
    this.state.dragging = value;
    this.invalidate();
  }

  setSelected(value: boolean): void {
    if (this.state.selected === value) return;
    this.state.selected = value;
    this.invalidate();
  }

  setPending(value: boolean): void {
    if (this.state.pending === value) return;
    this.state.pending = value;
    this.invalidate();
  }

  /** Self-attach to the layout surface registered for `zoneId`. */
  attach(zoneId: ZoneId): void {
    const surface = this.ctx.layout?.surfaceFor(zoneId);
    if (!surface) {
      console.warn(
        `[LayoutCard] no surface for zone ${zoneId}; card ${this.cardId} not attached`,
      );
      return;
    }
    surface.addChild(this);
  }

  detach(): void {
    this.parent?.removeChild(this);
  }
}
