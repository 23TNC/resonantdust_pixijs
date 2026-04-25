import { Rectangle, RenderTexture, Sprite } from "pixi.js";
import { getApp } from "@/app";
import { HexCoord, LayoutHex, LayoutHexOptions } from "@/ui/layout";
import { LayoutRect } from "@/ui/layout";

type LayoutPadding =
  | number
  | {
      top?: number;
      right?: number;
      bottom?: number;
      left?: number;
    };

export interface ZoneCoord {
  zoneQ: number;
  zoneR: number;
  z: number;
}

export interface ZoneOptions extends LayoutHexOptions {
  zoneSize?: number;
}

export class Zone extends LayoutHex {
  public readonly zoneQ: number;
  public readonly zoneR: number;
  public readonly z: number;
  public readonly zoneSize: number;

  private readonly tilesByLocalHex = new Map<string, LayoutRect>();
  private readonly localHexByTile = new WeakMap<LayoutRect, string>();

  private cacheTexture: RenderTexture | null = null;
  private readonly cacheSprite = new Sprite();

  public constructor(
    zoneQ: number,
    zoneR: number,
    z: number,
    x: number,
    y: number,
    width: number,
    height: number,
    padding: LayoutPadding = 0,
    options: ZoneOptions = {},
  ) {
    super(x, y, width, height, padding, options);

    this.zoneQ = zoneQ;
    this.zoneR = zoneR;
    this.z = z;
    this.zoneSize = Math.max(1, Math.floor(options.zoneSize ?? 8));

    this.cacheSprite.eventMode = "none";
    this.addChild(this.cacheSprite);
  }

  public addTile<T extends LayoutRect>(tile: T, q: number, r: number): T {
    this.assertLocalHex(q, r);

    const key = this.localHexKey(q, r);
    const existing = this.tilesByLocalHex.get(key);

    if (existing && existing !== tile) {
      this.localHexByTile.delete(existing);
      this.removeHexChild(existing);
    }

    this.tilesByLocalHex.set(key, tile);
    this.localHexByTile.set(tile, key);
    this.invalidateLayout();

    return this.addHexChild(tile, q, r);
  }

  public removeTile(q: number, r: number): LayoutRect | null {
    this.assertLocalHex(q, r);

    const key = this.localHexKey(q, r);
    const tile = this.tilesByLocalHex.get(key);

    if (!tile) {
      return null;
    }

    this.tilesByLocalHex.delete(key);
    this.localHexByTile.delete(tile);
    this.removeHexChild(tile);
    this.invalidateLayout();

    return tile;
  }

  public getTile(q: number, r: number): LayoutRect | null {
    this.assertLocalHex(q, r);
    return this.tilesByLocalHex.get(this.localHexKey(q, r)) ?? null;
  }

  public hasTile(q: number, r: number): boolean {
    this.assertLocalHex(q, r);
    return this.tilesByLocalHex.has(this.localHexKey(q, r));
  }

  public forEachTile(callback: (tile: LayoutRect, q: number, r: number) => void): void {
    for (const [key, tile] of this.tilesByLocalHex) {
      const { q, r } = this.parseLocalHexKey(key);
      callback(tile, q, r);
    }
  }

  public markTileDirty(q: number, r: number): void {
    this.assertLocalHex(q, r);
    this.tilesByLocalHex.get(this.localHexKey(q, r))?.invalidateRender();
    this.invalidateRender();
  }

  public markTileLayoutDirty(q: number, r: number): void {
    this.assertLocalHex(q, r);
    this.tilesByLocalHex.get(this.localHexKey(q, r))?.invalidateLayout();
    this.invalidateLayout();
  }

  public markChildDirty(tile: LayoutRect): void {
    if (!this.localHexByTile.has(tile)) {
      return;
    }

    this.invalidateRender();
  }

  public markChildLayoutDirty(tile: LayoutRect): void {
    if (!this.localHexByTile.has(tile)) {
      return;
    }

    this.invalidateLayout();
  }

  public markZoneDirty(): void {
    this.invalidateRender();
  }

  public markZoneLayoutDirty(): void {
    this.invalidateLayout();
  }

  public override updateRects(): void {
    super.updateRects();
    this.resizeCacheTexture();
    this.invalidateRender();
  }

  public override destroy(options?: Parameters<LayoutHex["destroy"]>[0]): void {
    this.cacheTexture?.destroy(true);
    this.cacheTexture = null;
    super.destroy(options);
  }

  public localToWorldHex(q: number, r: number): HexCoord {
    this.assertLocalHex(q, r);

    return {
      q: this.zoneQ * this.zoneSize + q,
      r: this.zoneR * this.zoneSize + r,
    };
  }

  public worldToLocalHex(q: number, r: number): HexCoord | null {
    const localQ = q - this.zoneQ * this.zoneSize;
    const localR = r - this.zoneR * this.zoneSize;

    if (!this.isLocalHex(localQ, localR)) {
      return null;
    }

    return { q: localQ, r: localR };
  }

  public isLocalHex(q: number, r: number): boolean {
    return (
      Number.isInteger(q) &&
      Number.isInteger(r) &&
      q >= 0 &&
      r >= 0 &&
      q < this.zoneSize &&
      r < this.zoneSize
    );
  }

  public getZoneWorldHexBounds(): Rectangle {
    return new Rectangle(
      this.zoneQ * this.zoneSize,
      this.zoneR * this.zoneSize,
      this.zoneSize,
      this.zoneSize,
    );
  }

  public getZoneCoord(): ZoneCoord {
    return {
      zoneQ: this.zoneQ,
      zoneR: this.zoneR,
      z: this.z,
    };
  }

  public getZoneKey(): string {
    return Zone.zoneKey(this.zoneQ, this.zoneR, this.z);
  }

  public static zoneKey(zoneQ: number, zoneR: number, z: number): string {
    return `${zoneQ},${zoneR},${z}`;
  }

  protected override redraw(): void {
    this.resizeCacheTexture();

    if (!this.cacheTexture) {
      return;
    }

    const app = getApp();
    const previousVisible = this.cacheSprite.visible;

    this.cacheSprite.visible = false;

    app.renderer.render({
      container: this,
      target: this.cacheTexture,
      clear: true,
    });

    this.cacheSprite.visible = previousVisible;
    this.cacheSprite.texture = this.cacheTexture;
    this.cacheSprite.x = 0;
    this.cacheSprite.y = 0;
  }

  private resizeCacheTexture(): void {
    const width = Math.max(1, Math.ceil(this.outerRect.width));
    const height = Math.max(1, Math.ceil(this.outerRect.height));

    if (
      this.cacheTexture &&
      this.cacheTexture.width === width &&
      this.cacheTexture.height === height
    ) {
      return;
    }

    this.cacheTexture?.destroy(true);
    this.cacheTexture = RenderTexture.create({ width, height });
    this.cacheSprite.texture = this.cacheTexture;
  }

  private assertLocalHex(q: number, r: number): void {
    if (!this.isLocalHex(q, r)) {
      throw new RangeError(
        `Local hex ${q},${r} is outside zone ${this.getZoneKey()} with size ${this.zoneSize}.`,
      );
    }
  }

  private localHexKey(q: number, r: number): string {
    return `${q},${r}`;
  }

  private parseLocalHexKey(key: string): HexCoord {
    const [q, r] = key.split(",").map(Number);
    return { q, r };
  }
}
