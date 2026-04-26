import { Point, Rectangle } from "pixi.js";
import { LayoutViewport, type LayoutViewportOptions } from "@/ui/layout";
import {
  client_cards,
  packZone,
  unpackZone,
  viewed_id,
  type ZoneId,
} from "@/spacetime/Data";
import { Zone } from "./Zone";

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
  private readonly zonesById = new Map<ZoneId, Zone>();
  private hexSize: number;
  private zoneSize: number;

  public constructor(options: WorldOptions = {}) {
    super({ scissorClipping: true, ...options });

    this.hexSize = Math.max(1, options.hexSize ?? 32);
    this.zoneSize = Math.max(1, Math.floor(options.zoneSize ?? 8));
  }

  public createZone(zone_id: ZoneId): Zone {
    const bounds = this.getZoneLocalBounds();

    return new Zone(zone_id, {
      width: bounds.width,
      height: bounds.height,
      padding: {
        top: -bounds.y,
        left: -bounds.x,
        right: 0,
        bottom: 0,
      },
      hexSize: this.hexSize,
      zoneSize: this.zoneSize,
    });
  }

  public addZone(zone: Zone): Zone {
    const zone_id = zone.zone_id;
    const existing = this.zonesById.get(zone_id);

    if (existing && existing !== zone) {
      this.removeZone(zone_id);
    }

    this.zonesById.set(zone_id, zone);

    const { zone_q, zone_r } = unpackZone(zone_id);
    const rect = this.getZoneWorldRect(zone_q, zone_r);
    const added = this.addViewportChild(zone, rect.x, rect.y, rect.width, rect.height);

    this.invalidateLayout();
    return added;
  }

  public ensureZone(zone_id: ZoneId): Zone {
    const existing = this.getZone(zone_id);

    if (existing) {
      return existing;
    }

    return this.addZone(this.createZone(zone_id));
  }

  public ensureViewportZone(): Zone | null {
    const zone_id = this.getViewportZoneId();

    if (zone_id == null) {
      return null;
    }

    return this.ensureZone(zone_id);
  }

  public getViewportZoneId(): ZoneId | null {
    const viewedCard = client_cards[viewed_id];
    if (!viewedCard) {
      return null;
    }

    const visibleRect = this.getVisibleWorldRect();
    const centerX = visibleRect.x + visibleRect.width / 2;
    const centerY = visibleRect.y + visibleRect.height / 2;
    const { q: world_q, r: world_r } = this.pixelToWorldHex(centerX, centerY);

    const zone_q = Math.floor(world_q / this.zoneSize);
    const zone_r = Math.floor(world_r / this.zoneSize);

    return packZone(zone_q, zone_r, viewedCard.z);
  }

  public removeZone(zone_id: ZoneId): Zone | null {
    const zone = this.zonesById.get(zone_id);

    if (!zone) {
      return null;
    }

    this.zonesById.delete(zone_id);
    this.removeViewportChild(zone);
    this.invalidateLayout();

    return zone;
  }

  public getZone(zone_id: ZoneId): Zone | null {
    return this.zonesById.get(zone_id) ?? null;
  }

  public hasZone(zone_id: ZoneId): boolean {
    return this.zonesById.has(zone_id);
  }

  public forEachZone(callback: (zone: Zone) => void): void {
    for (const zone of this.zonesById.values()) {
      callback(zone);
    }
  }

  public setHexSize(hexSize: number): void {
    const nextHexSize = Math.max(1, hexSize);

    if (this.hexSize === nextHexSize) {
      return;
    }

    this.hexSize = nextHexSize;

    for (const zone of this.zonesById.values()) {
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

    for (const zone of this.zonesById.values()) {
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

    for (const zone of this.zonesById.values()) {
      const { zone_q, zone_r, z: zone_z } = unpackZone(zone.zone_id);

      if (zone_z !== z) {
        continue;
      }

      const rect = this.getZoneWorldRect(zone_q, zone_r);

      if (this.rectsIntersect(rect, visibleRect)) {
        zones.push(zone);
      }
    }

    return zones;
  }

  public markZoneDirty(zone: Zone): void {
    if (!this.zonesById.has(zone.zone_id)) {
      return;
    }

    this.invalidateRender();
  }

  public markZoneLayoutDirty(zone: Zone): void {
    if (!this.zonesById.has(zone.zone_id)) {
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

    this.ensureViewportZone();
  }

  protected override layoutChildren(): void {
    this.ensureViewportZone();

    for (const zone of this.zonesById.values()) {
      this.updateZoneWorldRect(zone);
    }

    super.layoutChildren();
  }

  private updateZoneWorldRect(zone: Zone): void {
    const { zone_q, zone_r } = unpackZone(zone.zone_id);
    const rect = this.getZoneWorldRect(zone_q, zone_r);
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
