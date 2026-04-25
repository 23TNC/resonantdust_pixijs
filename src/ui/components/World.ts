import { Point, Rectangle } from "pixi.js";
import { LayoutViewport, LayoutViewportOptions } from "@/ui/layout";
import { Zone } from "./Zone";

export type LayoutPadding =
  | number
  | {
      top?: number;
      right?: number;
      bottom?: number;
      left?: number;
    };

export interface WorldOptions extends LayoutViewportOptions {
  hexSize?: number;
  zoneSize?: number;
}

export interface ZoneWorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class World extends LayoutViewport {
  private readonly zonesByKey = new Map<string, Zone>();
  private hexSize: number;
  private zoneSize: number;

  public constructor(
    x: number,
    y: number,
    width: number,
    height: number,
    padding: LayoutPadding = 0,
    options: WorldOptions = {},
  ) {
    super(x, y, width, height, padding, options);

    this.hexSize = Math.max(1, options.hexSize ?? 32);
    this.zoneSize = Math.max(1, Math.floor(options.zoneSize ?? 8));
  }

  public createZone(zoneQ: number, zoneR: number, z: number): Zone {
    const bounds = this.getZoneLocalBounds();

    return new Zone(
      zoneQ,
      zoneR,
      z,
      0,
      0,
      bounds.width,
      bounds.height,
      {
        top: -bounds.y,
        left: -bounds.x,
        right: 0,
        bottom: 0,
      },
      {
        hexSize: this.hexSize,
        zoneSize: this.zoneSize,
      },
    );
  }

  public addZone(zone: Zone): Zone {
    const key = zone.getZoneKey();
    const existing = this.zonesByKey.get(key);

    if (existing && existing !== zone) {
      this.removeZone(existing.zoneQ, existing.zoneR, existing.z);
    }

    this.zonesByKey.set(key, zone);

    const rect = this.getZoneWorldRect(zone.zoneQ, zone.zoneR);
    const added = this.addViewportChild(zone, rect.x, rect.y, rect.width, rect.height);

    this.invalidateLayout();
    return added;
  }

  public ensureZone(zoneQ: number, zoneR: number, z: number): Zone {
    const existing = this.getZone(zoneQ, zoneR, z);

    if (existing) {
      return existing;
    }

    return this.addZone(this.createZone(zoneQ, zoneR, z));
  }

  public removeZone(zoneQ: number, zoneR: number, z: number): Zone | null {
    const key = Zone.zoneKey(zoneQ, zoneR, z);
    const zone = this.zonesByKey.get(key);

    if (!zone) {
      return null;
    }

    this.zonesByKey.delete(key);
    this.removeViewportChild(zone);
    this.invalidateLayout();

    return zone;
  }

  public getZone(zoneQ: number, zoneR: number, z: number): Zone | null {
    return this.zonesByKey.get(Zone.zoneKey(zoneQ, zoneR, z)) ?? null;
  }

  public hasZone(zoneQ: number, zoneR: number, z: number): boolean {
    return this.zonesByKey.has(Zone.zoneKey(zoneQ, zoneR, z));
  }

  public forEachZone(callback: (zone: Zone) => void): void {
    for (const zone of this.zonesByKey.values()) {
      callback(zone);
    }
  }

  public setHexSize(hexSize: number): void {
    const nextHexSize = Math.max(1, hexSize);

    if (this.hexSize === nextHexSize) {
      return;
    }

    this.hexSize = nextHexSize;

    for (const zone of this.zonesByKey.values()) {
      zone.setHexSize(this.hexSize);
      this.updateZoneWorldRect(zone);
      zone.markZoneLayoutDirty();
    }

    this.invalidateLayout();
  }

  public getHexSize(): number {
    return this.hexSize;
  }

  public setZoneSize(zoneSize: number): void {
    const nextZoneSize = Math.max(1, Math.floor(zoneSize));

    if (this.zoneSize === nextZoneSize) {
      return;
    }

    this.zoneSize = nextZoneSize;

    for (const zone of this.zonesByKey.values()) {
      this.updateZoneWorldRect(zone);
      zone.markZoneLayoutDirty();
    }

    this.invalidateLayout();
  }

  public getZoneSize(): number {
    return this.zoneSize;
  }

  public worldHexToPixel(q: number, r: number): Point {
    return new Point(
      this.hexSize * (3 / 2) * q,
      this.hexSize * Math.sqrt(3) * (r + q / 2),
    );
  }

  public pixelToWorldHex(x: number, y: number): { q: number; r: number } {
    const q = ((2 / 3) * x) / this.hexSize;
    const r = ((-1 / 3) * x + (Math.sqrt(3) / 3) * y) / this.hexSize;

    return this.roundHex(q, r);
  }

  public viewportToWorldHex(x: number, y: number): { q: number; r: number } {
    const world = this.viewportToWorld(x, y);
    return this.pixelToWorldHex(world.x, world.y);
  }

  public getZoneWorldRect(zoneQ: number, zoneR: number): ZoneWorldRect {
    const base = this.worldHexToPixel(zoneQ * this.zoneSize, zoneR * this.zoneSize);
    const bounds = this.getZoneLocalBounds();

    return {
      x: base.x + bounds.x,
      y: base.y + bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
  }

  public getVisibleZones(z: number): Zone[] {
    const visibleRect = this.getVisibleWorldRect();
    const zones: Zone[] = [];

    for (const zone of this.zonesByKey.values()) {
      if (zone.z !== z) {
        continue;
      }

      const rect = this.getZoneWorldRect(zone.zoneQ, zone.zoneR);

      if (this.rectsIntersect(rect, visibleRect)) {
        zones.push(zone);
      }
    }

    return zones;
  }

  public markZoneDirty(zone: Zone): void {
    if (!this.zonesByKey.has(zone.getZoneKey())) {
      return;
    }

    this.invalidateRender();
  }

  public markZoneLayoutDirty(zone: Zone): void {
    if (!this.zonesByKey.has(zone.getZoneKey())) {
      return;
    }

    this.invalidateLayout();
  }

  public centerOnWorldHex(q: number, r: number): void {
    const center = this.worldHexToPixel(q, r);

    this.setViewOffset(
      center.x - this.innerRect.width / 2,
      center.y - this.innerRect.height / 2,
    );
  }

  protected override layoutChildren(): void {
    for (const zone of this.zonesByKey.values()) {
      this.updateZoneWorldRect(zone);
    }

    super.layoutChildren();
  }

  private updateZoneWorldRect(zone: Zone): void {
    const rect = this.getZoneWorldRect(zone.zoneQ, zone.zoneR);
    this.setChildWorldRect(zone, rect.x, rect.y, rect.width, rect.height);
  }

  private getZoneLocalBounds(): Rectangle {
    const hexWidth = this.hexSize * 2;
    const hexHeight = Math.sqrt(3) * this.hexSize;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (let q = 0; q < this.zoneSize; q++) {
      for (let r = 0; r < this.zoneSize; r++) {
        const center = this.worldHexToPixel(q, r);
        minX = Math.min(minX, center.x - hexWidth / 2);
        minY = Math.min(minY, center.y - hexHeight / 2);
        maxX = Math.max(maxX, center.x + hexWidth / 2);
        maxY = Math.max(maxY, center.y + hexHeight / 2);
      }
    }

    return new Rectangle(minX, minY, maxX - minX, maxY - minY);
  }

  private roundHex(q: number, r: number): { q: number; r: number } {
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

  private rectsIntersect(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
  ): boolean {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  }
}
