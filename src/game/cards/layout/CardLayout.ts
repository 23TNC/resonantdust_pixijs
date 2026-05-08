import type { GameContext } from "../../../GameContext";
import { debug } from "../../../debug";
import { LayoutNode } from "../../layout/LayoutNode";
import type { Card as CardRow } from "../../../server/spacetime/bindings/types";
import type { ZoneId } from "../../../server/data/packing";

/**
 * Hit-passthrough host for stacked-child cards. Always recurses into children
 * regardless of its own bounds, and never returns itself as a hit — so a click
 * inside the parent's body area falls through to a stacked child if one
 * catches it, or out of stackHost entirely if not (letting the parent's title
 * region or other siblings catch the click instead).
 */
class StackHost extends LayoutNode {
  override hitTestLayout(parentX: number, parentY: number): LayoutNode | null {
    const localX = parentX - this.x;
    const localY = parentY - this.y;
    for (let i = this.children.length - 1; i >= 0; i--) {
      const hit = this.children[i].hitTestLayout(localX, localY);
      if (hit) return hit;
    }
    return null;
  }
}

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

  /**
   * Host for top-stacked children (STACKED_ON_RECT_X). Drawn above
   * stackBottomHost so top-stack titlebars render over bottom-stack ones
   * if they ever overlap. Both hosts sit behind the card's own visual
   * layers so stacked children peek out from behind the parent.
   */
  readonly stackTopHost: LayoutNode = new StackHost();
  /**
   * Host for bottom-stacked children (STACKED_ON_RECT_Y). Drawn below
   * stackTopHost — bottom stacks are always under top stacks in z-order.
   */
  readonly stackBottomHost: LayoutNode = new StackHost();

  /**
   * Front-mount host for a rect card mounted on top of this hex card
   * (STACKED_ON_HEX). Added to the container *after* the visual so mounted
   * rects render in front. Only populated by LayoutHexCard; null on all
   * other card types.
   */
  hexMount: LayoutNode | null = null;

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
    // Both stack hosts draw *behind* whatever the subclass paints
    // (bg/title/overlay). Bottom host first so top-stack always wins z-order.
    this.addChild(this.stackBottomHost);
    this.addChild(this.stackTopHost);
  }

  /**
   * Hit-test override: always recurse into children, *even* when the click is
   * outside our own bounds. Stacked children's titlebars peek beyond our
   * drawn rect (above for top-stack, below for bottom-stack), so the
   * standard intersects-gate would miss them. Self-hit still requires the
   * click to land inside our bounds — the parent body isn't a hit target
   * outside its drawn rect.
   *
   * Children are checked in reverse z-order (last addChild = topmost), and
   * the inventory's hit-test recurses into LayoutCards in the same order, so
   * a loose card visually on top of a stacked-child's exposed title also
   * wins the hit (its container is later in the parent's child list).
   */
  override hitTestLayout(parentX: number, parentY: number): LayoutNode | null {
    const localX = parentX - this.x;
    const localY = parentY - this.y;
    for (let i = this.children.length - 1; i >= 0; i--) {
      const hit = this.children[i].hitTestLayout(localX, localY);
      if (hit) return hit;
    }
    if (this.intersects(localX, localY)) return this;
    return null;
  }

  /**
   * True when we're currently a stack child of another card — parented into
   * a StackHost rather than a zone surface. Subclasses use this in their
   * `intersects` override to restrict self-hits to the visible region (the
   * peeking titlebar) since the rest of the card is hidden behind the
   * parent and shouldn't catch clicks.
   */
  protected get isStacked(): boolean {
    return this.parent instanceof StackHost;
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
      debug.warn(["cards"], `[LayoutCard] no surface for zone ${zoneId}; card ${this.cardId} not attached`);
      return;
    }
    surface.addChild(this);
  }

  /**
   * Self-attach to a parent card's top or bottom stack host. The parent's
   * transform carries this card for drag/tween automatically.
   */
  attachToStack(parent: LayoutCard, direction: "top" | "bottom"): void {
    if (direction === "bottom") parent.stackBottomHost.addChild(this);
    else parent.stackTopHost.addChild(this);
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

  override setBounds(x: number, y: number, width: number, height: number): void {
    super.setBounds(x, y, width, height);
    this.zIndex = Math.round(y + height);
  }

  /** Resize without disturbing the tween target / display. */
  protected setSize(w: number, h: number): void {
    if (this.width === w && this.height === h) return;
    this.setBounds(this.x, this.y, w, h);
  }
}
