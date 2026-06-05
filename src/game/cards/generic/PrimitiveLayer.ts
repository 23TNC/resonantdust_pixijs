import { Container } from "pixi.js";
import type { CardBox } from "./cardBox";
import { makePrimitive, type PrimDeps, type Primitive } from "./primitives";
import type { PrimList } from "./visualSpec";

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
  /** True while at least one primitive is still easing — cached result of the
   *  last `settle()` / `draw()`, for diagnostics. The host drives ticking via
   *  `layout()`, so nothing external polls this. */
  animating = false;

  constructor(box: CardBox, private readonly deps: PrimDeps) {
    super();
    this.box = box;
  }

  /** Reconcile to a new target spec. Newly-created primitives seed `current`
   *  (from `enter` or target); existing ones get the new target and ease. */
  draw(list: PrimList): void {
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      let prim = this.prims[i];
      if (!prim || prim.kind !== node.kind) {
        prim?.destroy();
        prim = makePrimitive(node.kind, this.deps);
        this.prims[i] = prim;
        this.addChild(prim.node);
      }
      prim.update(node, this.box);
    }
    for (let i = list.length; i < this.prims.length; i++) {
      this.prims[i].destroy();
    }
    this.prims.length = list.length;
    // Keep child z-order aligned with spec order (creation order can drift
    // after a kind-swap mid-list).
    for (let i = 0; i < this.prims.length; i++) {
      this.setChildIndex(this.prims[i].node, i);
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
    for (const p of this.prims) p.destroy();
    this.prims.length = 0;
    super.destroy();
  }
}
