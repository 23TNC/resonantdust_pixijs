import { Point, Rectangle } from "pixi.js";
import { LayoutRect } from "./LayoutRect";

export interface HexCoord {
  q: number;
  r: number;
}

export interface LayoutHexOptions {
  hexSize?: number;
  originX?: number;
  originY?: number;
}

type LayoutPadding =
  | number
  | {
      top?: number;
      right?: number;
      bottom?: number;
      left?: number;
    };

export class LayoutHex extends LayoutRect {
  private hexSize: number;
  private childHexes = new Map<LayoutRect, HexCoord>();
  private childrenByHex = new Map<string, LayoutRect[]>();

  public constructor(
    x: number,
    y: number,
    width: number,
    height: number,
    padding: LayoutPadding = 0,
    options: LayoutHexOptions = {},
  ) {
    super(x, y, width, height, padding, {
      originX: options.originX,
      originY: options.originY,
    });

    this.hexSize = Math.max(1, options.hexSize ?? 32);
  }

  public addLayoutItem<T extends LayoutRect>(child: T, q: number, r: number): T {
    return this.addHexChild(child, q, r);
  }

  public addHexChild<T extends LayoutRect>(child: T, q: number, r: number): T {
    this.childHexes.set(child, { q, r });
    this.invalidateLayout();
    return this.addLayoutChild(child);
  }

  public removeLayoutItem<T extends LayoutRect>(child: T): T {
    return this.removeHexChild(child);
  }

  public removeHexChild<T extends LayoutRect>(child: T): T {
    this.childHexes.delete(child);
    this.removeFromHexCache(child);
    this.invalidateLayout();
    return this.removeLayoutChild(child);
  }

  public setChildHex(child: LayoutRect, q: number, r: number): void {
    if (!this.childHexes.has(child)) {
      return;
    }

    this.childHexes.set(child, { q, r });
    this.invalidateLayout();
  }

  public getChildHex(child: LayoutRect): HexCoord | null {
    const hex = this.childHexes.get(child);
    return hex ? { ...hex } : null;
  }

  public setHexSize(hexSize: number): void {
    this.hexSize = Math.max(1, hexSize);
    this.invalidateLayout();
  }

  public getHexSize(): number {
    return this.hexSize;
  }

  public hexToLocal(q: number, r: number): Point {
    return new Point(
      this.innerRect.x + this.hexSize * (3 / 2) * q,
      this.innerRect.y + this.hexSize * Math.sqrt(3) * (r + q / 2),
    );
  }

  public localToHex(x: number, y: number): HexCoord {
    const localX = x - this.innerRect.x;
    const localY = y - this.innerRect.y;

    const q = ((2 / 3) * localX) / this.hexSize;
    const r = ((-1 / 3) * localX + (Math.sqrt(3) / 3) * localY) / this.hexSize;

    return this.roundHex(q, r);
  }

  public getHexBounds(q: number, r: number): Rectangle {
    const center = this.hexToLocal(q, r);
    const width = this.getHexWidth();
    const height = this.getHexHeight();

    return new Rectangle(
      center.x - width / 2,
      center.y - height / 2,
      width,
      height,
    );
  }

  public getHexWidth(): number {
    return this.hexSize * 2;
  }

  public getHexHeight(): number {
    return Math.sqrt(3) * this.hexSize;
  }

  public override hitTestLayout(globalX: number, globalY: number): LayoutRect | null {
    const local = this.toLocal(new Point(globalX, globalY));

    if (!this.innerRect.contains(local.x, local.y)) {
      return null;
    }

    const hex = this.localToHex(local.x, local.y);
    const candidates = this.childrenByHex.get(this.hexKey(hex.q, hex.r)) ?? [];

    for (let i = candidates.length - 1; i >= 0; i--) {
      const hit = candidates[i].hitTestLayout(globalX, globalY);

      if (hit) {
        return hit;
      }
    }

    return this;
  }

  protected override layoutChildren(): void {
    this.childrenByHex.clear();

    for (const child of this.getLayoutChildren()) {
      const hex = this.childHexes.get(child);

      if (!hex || !child.visible) {
        continue;
      }

      const bounds = this.getHexBounds(hex.q, hex.r);

      child.setLayout(bounds.x, bounds.y, bounds.width, bounds.height);
      this.cacheChildByHex(child, hex.q, hex.r);
    }

    this.layoutDirty = false;
  }

  protected roundHex(q: number, r: number): HexCoord {
    const x = q;
    const z = r;
    const y = -x - z;

    let rx = Math.round(x);
    let ry = Math.round(y);
    let rz = Math.round(z);

    const xDiff = Math.abs(rx - x);
    const yDiff = Math.abs(ry - y);
    const zDiff = Math.abs(rz - z);

    if (xDiff > yDiff && xDiff > zDiff) {
      rx = -ry - rz;
    } else if (yDiff > zDiff) {
      ry = -rx - rz;
    } else {
      rz = -rx - ry;
    }

    return { q: rx, r: rz };
  }

  protected hexKey(q: number, r: number): string {
    return `${q},${r}`;
  }

  private cacheChildByHex(child: LayoutRect, q: number, r: number): void {
    const key = this.hexKey(Math.round(q), Math.round(r));
    const children = this.childrenByHex.get(key) ?? [];

    if (!children.includes(child)) {
      children.push(child);
    }

    this.childrenByHex.set(key, children);
  }

  private removeFromHexCache(child: LayoutRect): void {
    for (const [key, children] of this.childrenByHex) {
      const nextChildren = children.filter((candidate) => candidate !== child);

      if (nextChildren.length === 0) {
        this.childrenByHex.delete(key);
      } else {
        this.childrenByHex.set(key, nextChildren);
      }
    }
  }
}
