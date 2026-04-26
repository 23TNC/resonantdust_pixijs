import { Rectangle } from "pixi.js";
import { HexCoord, LayoutHex, LayoutHexOptions } from "@/ui/layout";
import { LayoutRect } from "@/ui/layout";
import { Tile } from "@/ui/components/Tile";
import {
  client_cards,
  client_cards_by_zone,
  client_zones,
  decodeZoneCardType,
  packDefinition,
  packPosition,
  type CardId,
  type PackedPosition,
  type ZoneId,
} from "@/spacetime/Data";

export interface ZoneCoord {
  zoneQ: number;
  zoneR: number;
  z: number;
}

export interface ZoneOptions extends LayoutHexOptions {
  zoneSize?: number;
  autoBuildTiles?: boolean;
}

export class Zone extends LayoutHex {
  public readonly zone_id: ZoneId;
  public readonly zoneQ: number;
  public readonly zoneR: number;
  public readonly z: number;
  public readonly zoneSize: number;

  private readonly tilesByLocalHex = new Map<string, LayoutRect>();
  private readonly localHexByTile = new WeakMap<LayoutRect, string>();

  public constructor(zone_id: ZoneId, options: ZoneOptions = {}) {
    super(options);

    const zone = client_zones[zone_id];

    this.zone_id = zone_id;
    this.zoneQ = zone?.zone_q ?? 0;
    this.zoneR = zone?.zone_r ?? 0;
    this.z = zone?.z ?? 0;
    this.zoneSize = Math.max(1, Math.floor(options.zoneSize ?? 8));

    if (options.autoBuildTiles ?? true) {
      this.syncTilesFromClientZone();
    }
  }

  public syncTilesFromClientZone(): void {
    const zone = client_zones[this.zone_id];
    if (!zone) {
      return;
    }

    const cardType = decodeZoneCardType(zone.definition);
    const dynamicTilesByPosition = this.collectDynamicTileCards(cardType);

    for (let r = 0; r < this.zoneSize; r += 1) {
      for (let q = 0; q < this.zoneSize; q += 1) {
        const position = packPosition(q, r);
        const cardId = dynamicTilesByPosition.get(position);
        const definition = cardId != null
          ? client_cards[cardId]?.definition
          : this.getStaticTileDefinition(q, r);

        if (definition == null) {
          continue;
        }

        this.upsertTile(q, r, cardId, definition);
      }
    }

    this.invalidateLayout();
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
    return String(this.zone_id);
  }

  public static zoneKey(zone_id: ZoneId): string {
    return String(zone_id);
  }

  private collectDynamicTileCards(cardType: number): Map<PackedPosition, CardId> {
    const result = new Map<PackedPosition, CardId>();
    const cardIds = client_cards_by_zone[this.zone_id];

    if (!cardIds) {
      return result;
    }

    for (const cardId of cardIds) {
      const card = client_cards[cardId];
      if (!card || card.card_type !== cardType) {
        continue;
      }

      result.set(card.position, cardId);
    }

    return result;
  }

  private getStaticTileDefinition(q: number, r: number): number | null {
    const zone = client_zones[this.zone_id];
    if (!zone) {
      return null;
    }

    const tileDefinitions = zone.tile_definitions as number[][] | undefined;
    if (tileDefinitions?.[r]?.[q] != null) {
      return tileDefinitions[r][q];
    }

    const tileDefinitionIds = zone.tile_definition_ids as number[][] | undefined;
    if (tileDefinitionIds?.[r]?.[q] != null) {
      const cardType = decodeZoneCardType(zone.definition);
      const category = zone.definition & 0x0f;
      return packDefinition(cardType, ((category & 0x0f) << 8) | tileDefinitionIds[r][q]);
    }

    const row = this.getStaticTileRow(r);
    if (row == null) {
      return null;
    }

    const tileDefinitionId = Number((row >> BigInt(q * 8)) & 0xffn);
    const cardType = decodeZoneCardType(zone.definition);
    const category = zone.definition & 0x0f;

    return packDefinition(cardType, ((category & 0x0f) << 8) | tileDefinitionId);
  }

  private getStaticTileRow(r: number): bigint | null {
    const zone = client_zones[this.zone_id];
    if (!zone) {
      return null;
    }

    switch (r) {
      case 0: return zone.t0;
      case 1: return zone.t1;
      case 2: return zone.t2;
      case 3: return zone.t3;
      case 4: return zone.t4;
      case 5: return zone.t5;
      case 6: return zone.t6;
      case 7: return zone.t7;
      default: return null;
    }
  }

  private upsertTile(q: number, r: number, cardId: CardId | undefined, definition: number): void {
    const existing = this.getTile(q, r);

    if (existing instanceof Tile) {
      if (cardId != null) {
        existing.setCardId(cardId);
      } else {
        existing.setDefinitionId(definition);
      }

      existing.setTileCoord(q, r);
      return;
    }

    const tile = new Tile({
      q,
      r,
      ...(cardId != null
        ? { card_id: cardId }
        : { definition_id: definition }),
      showLabel: true,
    });

    this.addTile(tile, q, r);
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
