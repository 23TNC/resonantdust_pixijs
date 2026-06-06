import { Container } from "pixi.js";
import type { CardBox } from "./cardBox";
import { makePrimitive, type PrimDeps, type Primitive } from "./primitives";
import type { PrimList } from "./visualSpec";

/** `zIndex` resolution: world-pixel Y is multiplied by this before rounding so
 *  sub-pixel depth differences survive the integer cast, leaving the low bits
 *  free for a per-prim tiebreak (spec index) that keeps a tile's own prims in
 *  authored order when they share a Y. */
const Z_SCALE = 16;
/** Floor band offset. Fills (`rect` / `hex` — the ground body) drop by this so
 *  every fill sorts under every object, regardless of Y — a tile's ground never
 *  occludes its own (or a northern neighbour's) objects. Magnitude must exceed
 *  the active set's world-Y spread × `Z_SCALE`; the viewport bounds that spread
 *  to ~screen height, so `1e7` (≈ 625k px of headroom) is ample. */
const FLOOR_BAND = -1e7;

/**
 * The reconciler + tween host — the visual core of a generic card. Owns a
 * retained set of primitives keyed by array index, diffs an incoming
 * `PrimList` against them, and eases each toward its target on `tick`.
 *
 * Reconciliation is by-index (a node's slot is its identity): same kind →
 * update in place; different kind → recreate; list shorter → trailing
 * primitives destroyed. Stable card types never change length, so this stays a
 * cheap linear pass. Conditional elements toggle via `alpha`, not add/remove.
 *
 * Easing is driven by the host's `layout()` (the LayoutNode dirty loop), NOT a
 * separate ticker: `settle()` advances one step and returns whether it's still
 * animating, so the host returns that from `layout()` to stay dirty until it
 * settles. `draw` (the reconcile + texture resolve) runs only on data/bounds
 * change; panning just translates the container.
 */
export class PrimitiveLayer extends Container {
  private prims: Primitive[] = [];
  private box: CardBox;
  /** Where reconciled prim nodes are parented.
   *  - `null` (default): self-mounted — nodes are children of this container and
   *    z-order follows spec order via `setChildIndex`. The card case: a card is
   *    one movable unit and its own transform carries the offset.
   *  - a `Container`: externally mounted into a shared `sortableChildren`
   *    container (the world viewport's depth layer). Nodes carry absolute
   *    world-pixel positions (via the box origin) and a `zIndex` derived from
   *    their world-Y, so they depth-sort against every other tile's prims. This
   *    container stays empty / out of the scene graph; it remains only the
   *    logical owner (reconcile + ease + lifecycle). */
  private readonly mountTarget: Container | null;
  /** True while at least one primitive is still easing — cached result of the
   *  last `settle()` / `draw()`, for diagnostics. The host drives ticking via
   *  `layout()`, so nothing external polls this. */
  animating = false;

  constructor(
    box: CardBox,
    private readonly deps: PrimDeps,
    opts: { target?: Container } = {},
  ) {
    super();
    this.box = box;
    this.mountTarget = opts.target ?? null;
  }

  /** Reconcile to a new target spec. Newly-created primitives seed `current`
   *  (from `enter` or target); existing ones get the new target and ease. */
  draw(list: PrimList): void {
    const parent = this.mountTarget ?? this;
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      let prim = this.prims[i];
      if (!prim || prim.kind !== node.kind) {
        prim?.destroy();
        prim = makePrimitive(node.kind, this.deps);
        this.prims[i] = prim;
        parent.addChild(prim.node);
      }
      prim.update(node, this.box);
    }
    for (let i = list.length; i < this.prims.length; i++) {
      this.prims[i].destroy();
    }
    this.prims.length = list.length;
    if (this.mountTarget) {
      // Externally mounted: prim nodes are interleaved with every other tile's
      // in one sorted container, so spec order can't govern z — derive a
      // `zIndex` from each prim's resting world-Y instead. Use the *target* Y
      // (not the eased current) so an enter/move animation never churns the
      // sort: depth is the resting place. Fills drop to the floor band; the
      // `+ i` keeps same-Y prims in authored order.
      for (let i = 0; i < this.prims.length; i++) {
        const node = list[i];
        const worldY = this.box.originY + node.pos.y;
        const fill = node.kind === "rect" || node.kind === "hex";
        // Intra-tile order uses the prim's `z` (DSL `&h.z`), falling back to the
        // spec index so unset prims keep push order.
        this.prims[i].node.zIndex = Math.round(worldY * Z_SCALE) + (node.z ?? i) + (fill ? FLOOR_BAND : 0);
        // A `mask` prim is meaningless here (there's no container to clip — prims
        // live loose in the shared sort layer). Keep its rect from drawing as a
        // stray white block. Masks are a card (self-mount) feature; tiles never
        // author one, so this is just a guard against misuse.
        if (this.prims[i].kind === "mask") this.prims[i].node.renderable = false;
      }
    } else {
      // Self-mounted: paint order is the prim's `z` (DSL `&h.z`), falling back to
      // the spec index so unset prims keep push order (title last = on top).
      // `sortableChildren` reorders the container by `zIndex`, so a kind-swap
      // mid-list can't drift the order.
      this.sortableChildren = true;
      for (let i = 0; i < this.prims.length; i++) {
        this.prims[i].node.zIndex = list[i].z ?? i;
      }
    }
    // Mask wiring (self-mount only): a `mask` prim CLIPS the rest of the layer
    // rather than drawing — set it as this container's `.mask` so easing its
    // height rolls the card up. The mask node stays a child of the layer (added
    // in the reconcile loop above) so it shares the prims' coordinate space;
    // Pixi excludes a `.mask` object from normal rendering. Cleared when no mask
    // prim is present. Externally-mounted (tile) layers don't mask — their prims
    // live in the shared sort container, not here; tiles never author `^mask`.
    if (!this.mountTarget) {
      const maskPrim = this.prims.find((p) => p.kind === "mask");
      this.mask = maskPrim ? maskPrim.node : null;
    }
    this.animating = true;
  }

  /** Advance every primitive one layout step. Returns true while any is still
   *  easing — the host returns this from `layout()` so the dirty loop re-runs
   *  until everything settles. No-op cost when already settled. */
  settle(): boolean {
    let active = false;
    for (const p of this.prims) {
      if (p.settle()) active = true;
    }
    this.animating = active;
    return active;
  }

  /** Re-resolve against a new pixel box (resize / dpr change). Forces a
   *  re-tick so footprints and positions update. Callers re-`draw` with the
   *  latest spec; this just refreshes the box used by that draw. */
  setBox(box: CardBox): void {
    this.box = box;
  }

  destroy(): void {
    // Drop the mask reference before destroying its node, so Pixi isn't left
    // pointing at a destroyed mask mid-teardown.
    this.mask = null;
    for (const p of this.prims) p.destroy();
    this.prims.length = 0;
    super.destroy();
  }
}
