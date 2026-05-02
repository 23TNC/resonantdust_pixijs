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

/**
 * Per-frame fraction of the remaining (target - display) distance to close.
 * Frame-rate dependent; good enough for now (faster at higher refresh).
 */
const TWEEN_LERP = 0.3;
/** When |target - display| < this, snap and stop tweening. */
const TWEEN_SNAP_PX = 0.25;

export abstract class LayoutCard extends LayoutNode {
  readonly cardId: number;
  protected readonly state: CardVisualState = { ...DEFAULT_STATE };

  // Tween bookkeeping. `display` is what's drawn; `target` is what we're
  // animating toward. First setTarget snaps display=target so newly-spawned
  // cards don't fly in from (0,0).
  private displayX = 0;
  private displayY = 0;
  protected targetX = 0;
  protected targetY = 0;
  private hasTarget = false;

  /**
   * Drag offset (cursor → card top-left) in the card's parent surface coords.
   * Set by `setDragging(true, ox, oy)`; subclass `layout()` uses these to
   * compute a cursor-following target while `state.dragging` is true.
   */
  protected dragOffsetX = 0;
  protected dragOffsetY = 0;

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

  /**
   * Toggle the dragging visual state. When entering drag, `offsetX`/`offsetY`
   * record where the cursor grabbed the card (relative to its top-left in the
   * parent surface) so subclass `layout()` can keep the card under the cursor.
   * Re-parenting (zone surface ↔ overlay) is the Card composite's job, not
   * ours — we only track the flag and offsets.
   */
  setDragging(value: boolean, offsetX = 0, offsetY = 0): void {
    if (this.state.dragging === value) return;
    this.state.dragging = value;
    if (value) {
      this.dragOffsetX = offsetX;
      this.dragOffsetY = offsetY;
    }
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

  /**
   * Update the tween target. First call also snaps `display` to `target`,
   * so freshly-spawned cards render in place rather than flying from (0,0).
   * Subsequent calls leave display alone — `layout()` tweens it forward.
   */
  setTarget(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
    if (!this.hasTarget) {
      this.hasTarget = true;
      this.displayX = x;
      this.displayY = y;
      this.setBounds(x, y, this.width, this.height);
    } else {
      this.invalidate();
    }
  }

  /**
   * Direct write of display position — bypasses tween. Used by Card to
   * preserve the on-screen position of a card when re-parenting (e.g. zone
   * surface ↔ overlay), so the visual transition is seamless. Doesn't touch
   * the target.
   */
  setDisplayPosition(x: number, y: number): void {
    this.displayX = x;
    this.displayY = y;
    this.hasTarget = true;
    this.setBounds(x, y, this.width, this.height);
  }

  /**
   * Advance display one frame toward `(tx, ty)`. Returns true if still moving
   * (subclass should propagate this from its `layout()` so the node re-runs
   * next frame). Subclasses call this once per `layout()` after they pick the
   * effective target (data-driven vs cursor-following).
   */
  protected tweenTo(tx: number, ty: number): boolean {
    const dx = tx - this.displayX;
    const dy = ty - this.displayY;
    if (dx * dx + dy * dy < TWEEN_SNAP_PX * TWEEN_SNAP_PX) {
      if (this.displayX !== tx || this.displayY !== ty) {
        this.displayX = tx;
        this.displayY = ty;
        this.setBounds(tx, ty, this.width, this.height);
      }
      return false;
    }
    this.displayX += dx * TWEEN_LERP;
    this.displayY += dy * TWEEN_LERP;
    this.setBounds(this.displayX, this.displayY, this.width, this.height);
    return true;
  }

  /** Resize without disturbing the tween target / display. */
  protected setSize(w: number, h: number): void {
    if (this.width === w && this.height === h) return;
    this.setBounds(this.x, this.y, w, h);
  }
}
