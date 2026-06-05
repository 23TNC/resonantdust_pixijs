import type { GameContext } from "../../../GameContext";
import { LayoutNode } from "../../layout/LayoutNode";
import type { Card as CardRow } from "../../../server/spacetime/bindings/types";
import type { ZoneId } from "../../../server/data/packing";
import { findWorldView, type WorldViewServices } from "../../viewport/WorldViewServices";

/**
 * Hit-passthrough host for stacked-child cards. Always recurses into children
 * regardless of its own bounds, and never returns itself as a hit — so a click
 * inside the parent's body area falls through to a stacked child if one
 * catches it, or out of stackHost entirely if not (letting the parent's title
 * region or other siblings catch the click instead).
 */
class StackHost extends LayoutNode {
  constructor() {
    super();
    // Stacked children sort by an explicit per-card zIndex (set in
    // `LayoutCard.setBounds` from the card's stack step + direction — see
    // `LayoutRectCard.applyData`) rather than insertion/attach order, which the
    // flat-root re-rooting churns. A "bottom" stack needs the inner (lower-step)
    // card in front so its bottom-edge title isn't hidden by the card stacked
    // below it; a "top" stack needs the outer (higher-step) card in front. The
    // signed zIndex encodes both.
    this.container.sortableChildren = true;
  }

  override hitTestLayout(parentX: number, parentY: number): LayoutNode | null {
    const localX = parentX - this.x;
    const localY = parentY - this.y;
    // Hit-test in render order — highest zIndex draws on top, so it should be
    // hit first. `this.children` stays in insertion order (sortableChildren
    // only reorders the Pixi container), so sort a copy by zIndex here to keep
    // clicks on peeking titles consistent with what's drawn on top.
    const ordered = [...this.children].sort(
      (a, b) => b.container.zIndex - a.container.zIndex,
    );
    for (const child of ordered) {
      const hit = child.hitTestLayout(localX, localY);
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
   * Host for top-stacked children (`STACKED_ON_ROOT` with
   * `direction == STACK_DIRECTION_UP`). Drawn above stackBottomHost so
   * top-stack titlebars render over bottom-stack ones if they ever
   * overlap. Both hosts sit behind the card's own visual layers so
   * stacked children peek out from behind the parent.
   */
  /**
   * Host for the stack-0 member — the hex/tile that sits UNDER this card when
   * it's the root (generalized from the old `hexMount`). Added first in the
   * constructor so it renders behind the card's own visual + the top/bottom
   * stacks. Capacity-1 by convention (one tile/hex per root).
   */
  readonly stackHexHost: LayoutNode = new StackHost();
  readonly stackTopHost: LayoutNode = new StackHost();
  /**
   * Host for bottom-stacked children (`STACKED_ON_ROOT` with
   * `direction == STACK_DIRECTION_DOWN`). Drawn below stackTopHost —
   * bottom stacks are always under top stacks in z-order.
   */
  readonly stackBottomHost: LayoutNode = new StackHost();

  /**
   * Front-mount host for a rect card mounted on top of this hex card
   * (the rect lives as `STACKED_ON_ROOT` with `direction = HEX` under
   * the unified card model; the host hex is `STACKED_LOOSE`). Added
   * to the container *after* the visual so mounted rects render in
   * front. Only populated by LayoutHexCard; null on all other card
   * types.
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

  /** Explicit z-order for stacked members, overriding the default
   *  depth-by-screen-y (`y + height`) sort. Set by the subclass `applyData`
   *  to a signed function of the card's stack step + direction (positive for
   *  "top" chains, negative for "bottom") so a stack host's `sortableChildren`
   *  renders inner/outer cards in the right order regardless of attach order.
   *  `null` for loose / world cards, which keep the screen-y depth sort. */
  protected stackZ: number | null = null;

  /** Unsubscribe for a deferred-attach wait: set when `attach(zoneId)`
   *  found no surface for that zone yet and is waiting for the
   *  matching `LayoutManager.onRegister` event. Cleared the moment we
   *  successfully attach, or when the card is destroyed / re-attached
   *  to a different zone before the surface lands. `null` whenever
   *  we're not waiting. */
  private pendingAttachUnsub: (() => void) | null = null;

  /**
   * Drag offset (cursor → card top-left) in the card's parent surface coords.
   * Set by `setDragging(true, ox, oy)`; subclass `layout()` uses these to
   * compute a cursor-following target while `state.dragging` is true.
   */
  protected dragOffsetX = 0;
  protected dragOffsetY = 0;

  /** Last resolved owning view, kept so the value survives a drag (when the
   *  card is re-parented into the drag overlay and the parent-chain walk finds
   *  no view). Read via the `worldView` getter. */
  private cachedWorldView: WorldViewServices | null = null;

  /** The `LayoutWorld` this card currently lives in, resolved by walking the
   *  parent chain. While dragging (re-parented to the overlay) the walk finds
   *  nothing, so we return the last-resolved value — a world card keeps using
   *  its home view's hex/overlay services through the drag. */
  get worldView(): WorldViewServices | null {
    const found = findWorldView(this);
    if (found) this.cachedWorldView = found;
    return this.cachedWorldView;
  }

  constructor(cardId: number, ctx: GameContext) {
    super();
    this.cardId = cardId;
    this.setContext(ctx);
    // Both stack hosts draw *behind* whatever the subclass paints
    // (bg/title/overlay). Bottom host first so top-stack always wins z-order.
    // Hex host first → renders behind the card's own visual (a tile under the
    // root). Then bottom, then top (top-stack always wins z-order).
    this.addChild(this.stackHexHost);
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

  /** Self-attach to the layout surface registered for `zoneId`.
   *
   *  When no surface is registered for `zoneId` yet — the common
   *  case for world cards whose hex isn't currently in the
   *  viewport's neighbourhood — the card sits in memory and waits
   *  for `LayoutManager.onRegister` to fire for our zone. As soon
   *  as the viewport (or any other consumer) causes that zone's
   *  surface to register, we attach. Surface absence is not an
   *  error; it just means nobody's looking at this card's hex
   *  yet. */
  attach(zoneId: ZoneId): void {
    // Cancel any prior deferred wait — we're either attaching now,
    // or queuing a fresh wait against a new zone.
    this.pendingAttachUnsub?.();
    this.pendingAttachUnsub = null;

    const layoutManager = this.ctx.layout;
    if (!layoutManager) return;

    const surface = layoutManager.surfaceFor(zoneId);
    if (surface) {
      surface.addChild(this);
      return;
    }

    // Defer: wait for the matching surface to register. Filter
    // every register event by zone id; on match, fire the same
    // attach path the synchronous branch took.
    this.pendingAttachUnsub = layoutManager.onRegister((registeredZoneId, registeredSurface) => {
      if (registeredZoneId !== zoneId) return;
      this.pendingAttachUnsub?.();
      this.pendingAttachUnsub = null;
      registeredSurface.addChild(this);
    });
  }

  /**
   * Self-attach to a parent card's top or bottom stack host. The parent's
   * transform carries this card for drag/tween automatically.
   */
  attachToStack(parent: LayoutCard, direction: "top" | "bottom" | "hex"): void {
    if (direction === "hex") parent.stackHexHost.addChild(this);
    else if (direction === "bottom") parent.stackBottomHost.addChild(this);
    else parent.stackTopHost.addChild(this);
  }

  detach(): void {
    // Cancel any pending deferred-attach wait too — a detach is an
    // explicit "I don't belong to this zone any more", so we
    // shouldn't quietly auto-attach the moment the surface lands.
    this.pendingAttachUnsub?.();
    this.pendingAttachUnsub = null;
    this.parent?.removeChild(this);
  }

  override destroy(): void {
    this.pendingAttachUnsub?.();
    this.pendingAttachUnsub = null;
    super.destroy();
  }

  /** Called by a parent card to share its in-front-objects overlay
   *  state with this child. The child uses the parent's `(q, r,
   *  offsetX, offsetY)` plus its own static `chainDelta` (set in
   *  applyData when stacked) to derive its own overlay state and bake
   *  its own RT. Default no-op for cards that don't display an
   *  overlay. */
  inheritObjectOverlay(
    _parentQ: number | null,
    _parentR: number | null,
    _parentOffsetX: number,
    _parentOffsetY: number,
  ): void {
    // Default: ignore.
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
    // Stacked members carry an explicit signed z (see `stackZ`); everyone else
    // depth-sorts by screen y so lower cards on a surface draw in front.
    this.zIndex = this.stackZ ?? Math.round(y + height);
  }

  /** Resize without disturbing the tween target / display. */
  protected setSize(w: number, h: number): void {
    if (this.width === w && this.height === h) return;
    this.setBounds(this.x, this.y, w, h);
  }
}
