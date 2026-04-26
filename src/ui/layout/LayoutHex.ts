import { Point } from "pixi.js";
import { LayoutObject, type LayoutObjectOptions } from "./LayoutObject";

const SQRT3 = Math.sqrt(3);

// Pack two 16-bit signed integers into a single 32-bit key for Map lookup.
// Valid for q, r in [-32768, 32767] — well beyond any practical grid.
function posKey(q: number, r: number): number {
  return ((q & 0xffff) << 16) | (r & 0xffff);
}

/**
 * Positions layout children at explicit pointy-top hex grid coordinates (q, r).
 *
 * Odd-r offset convention: odd rows shift right by half a hex width.
 *
 * R (circumradius) is computed each layout pass to fit all children within the
 * inner rect. The computed R is available via getTileRadius() after a layout pass.
 *
 * Each child receives a rect of size (√3R × 2R) centered on its hex center,
 * which is exactly the bounding box of the pointy-top hexagon drawn by Tile.
 *
 * Hit testing uses cube-coordinate math to resolve the hex in O(1) rather than
 * iterating all children.
 */
export class LayoutHex extends LayoutObject {
  private readonly _childPositions = new Map<LayoutObject, { q: number; r: number }>();
  private readonly _positionLookup = new Map<number, LayoutObject>();

  private _tileRadius = 0;
  // Normalized origin stored from the last layout pass; needed by localToHex.
  private _nMinX = 0;
  private _nMinY = 0;

  constructor(options: LayoutObjectOptions = {}) {
    super(options);
  }

  // ─── Children ────────────────────────────────────────────────────────────

  addItem<T extends LayoutObject>(child: T, q: number, r: number, depth?: number): T {
    this._childPositions.set(child, { q, r });
    this._positionLookup.set(posKey(q, r), child);
    return this.addLayoutChild(child, depth ?? 0);
  }

  override removeLayoutChild<T extends LayoutObject>(child: T): T | null {
    const pos = this._childPositions.get(child);
    if (pos) this._positionLookup.delete(posKey(pos.q, pos.r));
    const result = super.removeLayoutChild(child);
    if (result) this._childPositions.delete(child);
    return result;
  }

  moveItem(child: LayoutObject, q: number, r: number): void {
    const old = this._childPositions.get(child);
    if (!old) return;
    this._positionLookup.delete(posKey(old.q, old.r));
    this._childPositions.set(child, { q, r });
    this._positionLookup.set(posKey(q, r), child);
    this.invalidateLayout();
  }

  getChildPosition(child: LayoutObject): { q: number; r: number } | null {
    const pos = this._childPositions.get(child);
    return pos ? { ...pos } : null;
  }

  /** Circumradius computed during the last layout pass. */
  getTileRadius(): number {
    return this._tileRadius;
  }

  // ─── Layout ──────────────────────────────────────────────────────────────

  protected override updateLayoutChildren(): void {
    const children = this.getLayoutChildren();

    if (children.length === 0) {
      this._tileRadius = 0;
      return;
    }

    // Normalized (R=1) positions:
    //   center_x = q * √3 + (odd(r) ? √3/2 : 0)
    //   center_y = r * 1.5
    // Hex rect spans ±√3/2 in x and ±1 in y around the center.
    let nMinX = Infinity,  nMaxX = -Infinity;
    let nMinY = Infinity,  nMaxY = -Infinity;

    for (const child of children) {
      const pos = this._childPositions.get(child);
      if (!pos) continue;
      const { q, r } = pos;
      const cx = q * SQRT3 + ((r & 1) !== 0 ? SQRT3 / 2 : 0);
      const cy = r * 1.5;
      nMinX = Math.min(nMinX, cx - SQRT3 / 2);
      nMaxX = Math.max(nMaxX, cx + SQRT3 / 2);
      nMinY = Math.min(nMinY, cy - 1);
      nMaxY = Math.max(nMaxY, cy + 1);
    }

    const { x, y, width, height } = this.innerRect;
    const nW = nMaxX - nMinX;
    const nH = nMaxY - nMinY;
    const R = (nW > 0 && nH > 0 && width > 0 && height > 0)
      ? Math.min(width / nW, height / nH)
      : 0;

    this._tileRadius = R;
    this._nMinX     = nMinX;
    this._nMinY     = nMinY;

    const hexW = SQRT3 * R;

    for (const child of children) {
      const pos = this._childPositions.get(child);
      if (!pos) {
        child.setLayout(x, y, 0, 0);
        continue;
      }
      const { q, r } = pos;
      const cx = q * SQRT3 + ((r & 1) !== 0 ? SQRT3 / 2 : 0);
      const cy = r * 1.5;
      child.setLayout(
        x + (cx - SQRT3 / 2 - nMinX) * R,
        y + (cy - 1         - nMinY) * R,
        hexW,
        2 * R,
      );
    }
  }

  // ─── Hit test ────────────────────────────────────────────────────────────

  /**
   * Convert a point in this object's LOCAL coordinate space to the nearest
   * hex grid cell (offset-q, offset-r).  Returns null when R is zero.
   *
   * Math:
   *   1. De-scale by R and shift by _nMinX/_nMinY to reach normalized space.
   *   2. Apply the pointy-top pixel→axial formula.
   *   3. Round via cube-coordinate rounding (fixes the axis with most error).
   *   4. Convert axial (q, r) → odd-r offset (q, r).
   */
  protected localToHex(lx: number, ly: number): { q: number; r: number } | null {
    const R = this._tileRadius;
    if (R <= 0) return null;

    const nx = (lx - this.innerRect.x) / R + this._nMinX;
    const ny = (ly - this.innerRect.y) / R + this._nMinY;

    const qf = nx / SQRT3 - ny / 3;
    const rf = ny * (2 / 3);
    const sf = -qf - rf;

    let q = Math.round(qf);
    let r = Math.round(rf);
    const s = Math.round(sf);

    const dq = Math.abs(q - qf);
    const dr = Math.abs(r - rf);
    const ds = Math.abs(s - sf);

    if (dq > dr && dq > ds) {
      q = -r - s;
    } else if (dr > ds) {
      r = -q - s;
    }

    // axial → odd-r offset:  offset_q = axial_q + floor(axial_r / 2)
    return { q: q + (r >> 1), r };
  }

  /** Direct lookup of the child registered at grid position (q, r). */
  protected getChildAtHex(q: number, r: number): LayoutObject | null {
    return this._positionLookup.get(posKey(q, r)) ?? null;
  }

  /**
   * O(1) hit test: convert the cursor to hex coords, then look up the
   * registered child.  Subclasses may override to check additional layers
   * (e.g. overlay children) before falling through to the tile.
   *
   * Nodes in `ignore` are skipped (see LayoutObject.hitTestLayout).
   */
  override hitTestLayout(globalX: number, globalY: number, ignore?: ReadonlySet<LayoutObject>): LayoutObject | null {
    if (ignore?.has(this)) return null;

    const local = this.toLocal(new Point(globalX, globalY));
    if (!this.innerRect.contains(local.x, local.y)) return null;

    if (this._positionLookup.size === 0) return this._hitSelf ? this : null;

    const hex = this.localToHex(local.x, local.y);
    if (!hex) return this._hitSelf ? this : null;

    const child = this._positionLookup.get(posKey(hex.q, hex.r));
    if (child?.visible) {
      return child.hitTestLayout(globalX, globalY, ignore) ?? (this._hitSelf ? this : null);
    }

    return this._hitSelf ? this : null;
  }
}
