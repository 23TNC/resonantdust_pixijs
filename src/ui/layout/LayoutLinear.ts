import { Point } from "pixi.js";
import { LayoutObject, type LayoutObjectOptions } from "./LayoutObject";

export interface LinearChildOptions {
  /** Proportional share of remaining space after fixed children and gaps. Defaults to 1. */
  weight?: number;
  /** Exact size in the primary axis. Takes priority over weight when set. */
  fixedSize?: number;
}

export interface LinearOptions extends LayoutObjectOptions {
  gap?: number;
}

type Axis = "horizontal" | "vertical";

interface ChildRange {
  start: number;
  end: number;
  child: LayoutObject;
}

/**
 * Shared implementation for linear (row/column) layouts.
 * Children are placed sequentially along the primary axis in depth order.
 * Each child either takes a fixed pixel size or a weighted share of remaining space.
 * Gaps are inserted between children.
 *
 * The hit test is O(log n) via binary search on the primary axis.
 */
export abstract class LayoutLinear extends LayoutObject {
  protected abstract readonly axis: Axis;

  private _gap: number;
  private readonly _childOptions = new Map<LayoutObject, LinearChildOptions>();
  private _childRanges: ChildRange[] = [];

  constructor(options: LinearOptions = {}) {
    super(options);
    this._gap = Math.max(0, options.gap ?? 0);
  }

  // ─── Configuration ───────────────────────────────────────────────────────

  setGap(gap: number): void {
    const next = Math.max(0, gap);
    if (this._gap === next) return;
    this._gap = next;
    this.invalidateLayout();
  }

  getGap(): number {
    return this._gap;
  }

  // ─── Children ────────────────────────────────────────────────────────────

  /**
   * Add a layout child with linear layout options.
   * Children with no explicit depth default to 0 and maintain insertion order.
   */
  addItem<T extends LayoutObject>(
    child: T,
    options: LinearChildOptions & { depth?: number } = {},
  ): T {
    const { depth, ...layoutOpts } = options;
    this._childOptions.set(child, layoutOpts);
    return this.addLayoutChild(child, depth);
  }

  override removeLayoutChild<T extends LayoutObject>(child: T): T | null {
    const result = super.removeLayoutChild(child);
    if (result) this._childOptions.delete(child);
    return result;
  }

  setChildOptions(child: LayoutObject, options: Partial<LinearChildOptions>): void {
    const current = this._childOptions.get(child) ?? {};
    this._childOptions.set(child, { ...current, ...options });
    this.invalidateLayout();
  }

  getChildOptions(child: LayoutObject): LinearChildOptions {
    return { ...(this._childOptions.get(child) ?? {}) };
  }

  // ─── Layout ──────────────────────────────────────────────────────────────

  protected override updateLayoutChildren(): void {
    const children = this.getLayoutChildren();

    if (children.length === 0) {
      this._childRanges = [];
      return;
    }

    const h = this.axis === "horizontal";

    const primaryStart   = h ? this.innerRect.x      : this.innerRect.y;
    const primaryTotal   = h ? this.innerRect.width   : this.innerRect.height;
    const secondaryStart = h ? this.innerRect.y       : this.innerRect.x;
    const secondarySize  = h ? this.innerRect.height  : this.innerRect.width;

    const totalGap = this._gap * (children.length - 1);

    let totalFixed  = 0;
    let totalWeight = 0;

    for (const child of children) {
      const opts = this._childOptions.get(child);
      if (opts?.fixedSize != null) {
        totalFixed += Math.max(0, opts.fixedSize);
      } else {
        totalWeight += opts?.weight ?? 1;
      }
    }

    const remaining  = Math.max(0, primaryTotal - totalFixed - totalGap);
    const weightUnit = totalWeight > 0 ? remaining / totalWeight : 0;

    const ranges: ChildRange[] = [];
    let cursor = primaryStart;

    for (const child of children) {
      const opts = this._childOptions.get(child);
      const childPrimary = opts?.fixedSize != null
        ? Math.max(0, opts.fixedSize)
        : (opts?.weight ?? 1) * weightUnit;

      child.setLayout(
        h ? cursor        : secondaryStart,
        h ? secondaryStart : cursor,
        h ? childPrimary  : secondarySize,
        h ? secondarySize  : childPrimary,
      );

      ranges.push({ start: cursor, end: cursor + childPrimary, child });
      cursor += childPrimary + this._gap;
    }

    this._childRanges = ranges;
  }

  // ─── Hit test ────────────────────────────────────────────────────────────

  override hitTestLayout(globalX: number, globalY: number): LayoutObject | null {
    const local = this.toLocal(new Point(globalX, globalY));
    if (!this.innerRect.contains(local.x, local.y)) return null;

    const primary = this.axis === "horizontal" ? local.x : local.y;
    const candidate = this._bsearch(primary);

    if (candidate) {
      const hit = candidate.hitTestLayout(globalX, globalY);
      if (hit) return hit;
    }

    return this._hitSelf ? this : null;
  }

  // Binary search: find the child whose [start, end) range contains value.
  private _bsearch(value: number): LayoutObject | null {
    const r = this._childRanges;
    let lo = 0;
    let hi = r.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (value < r[mid].start) hi = mid - 1;
      else if (value >= r[mid].end) lo = mid + 1;
      else return r[mid].child;
    }
    return null;
  }
}

// ─── Concrete layouts ─────────────────────────────────────────────────────

export class LayoutHorizontal extends LayoutLinear {
  protected readonly axis = "horizontal" as const;
}

export class LayoutVertical extends LayoutLinear {
  protected readonly axis = "vertical" as const;
}
