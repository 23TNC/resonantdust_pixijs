import type { Card, Player } from "../server/bindings/types";
import type { SpacetimeManager } from "../server/SpacetimeManager";
import { packZoneId, type ZoneId } from "../zones/zoneId";
import type { ZoneManager } from "../zones/ZoneManager";
import { ShadowedStore, type ShadowedListener } from "./ShadowedStore";

export type TableMap = {
  cards: Card;
  players: Player;
};

export type TableName = keyof TableMap;

export type KeySetChangeKind = "added" | "removed";

export interface KeySetChange {
  kind: KeySetChangeKind;
  key: number | string;
}

export type KeySetListener = (change: KeySetChange) => void;

export class DataManager {
  readonly cards = new ShadowedStore<Card>(
    (c) => c.cardId,
    { zone: (c) => packZoneId(c.macroZone, c.layer) },
  );
  readonly players = new ShadowedStore<Player>((p) => p.playerId);

  private spacetime: SpacetimeManager | null = null;
  private zonesUnsub: (() => void) | null = null;

  private readonly keySetListeners: {
    [K in TableName]?: Set<KeySetListener>;
  } = {};

  private playersRefs = 0;

  attachSpacetime(spacetime: SpacetimeManager): void {
    if (this.spacetime) {
      throw new Error("[DataManager] spacetime already attached");
    }
    this.spacetime = spacetime;
  }

  /**
   * Subscribe to ZoneManager so that any zone reaching `active` or `hot`
   * becomes a spacetime cards subscription, and demotion drops it. Replaces
   * the old direct `trackCards` API — callers now go through `zones.ensure`.
   */
  attachZones(zones: ZoneManager): void {
    if (this.zonesUnsub) {
      throw new Error("[DataManager] zones already attached");
    }
    const onAdded = (zoneId: ZoneId) => {
      this.requireSpacetime()
        .subscribeCards(zoneId)
        .catch((err) => {
          console.error(`[DataManager] subscribeCards(${zoneId}) failed`, err);
        });
    };
    const onRemoved = (zoneId: ZoneId) => {
      this.requireSpacetime().unsubscribeCards(zoneId);
    };
    const unsubActiveAdd = zones.onAdded("active", onAdded);
    const unsubActiveRemove = zones.onRemoved("active", onRemoved);
    const unsubHotAdd = zones.onAdded("hot", onAdded);
    const unsubHotRemove = zones.onRemoved("hot", onRemoved);
    this.zonesUnsub = () => {
      unsubActiveAdd();
      unsubActiveRemove();
      unsubHotAdd();
      unsubHotRemove();
    };
  }

  trackPlayers(): () => void {
    this.playersRefs++;
    if (this.playersRefs === 1) {
      this.requireSpacetime()
        .subscribePlayers()
        .catch((err) => {
          console.error("[DataManager] subscribePlayers failed", err);
        });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.playersRefs--;
      if (this.playersRefs === 0) {
        this.requireSpacetime().unsubscribePlayers();
      }
    };
  }

  private requireSpacetime(): SpacetimeManager {
    if (!this.spacetime) {
      throw new Error(
        "[DataManager] spacetime not attached; call attachSpacetime first",
      );
    }
    return this.spacetime;
  }

  subscribe<K extends TableName>(
    table: K,
    listener: ShadowedListener<TableMap[K]>,
  ): () => void {
    return this.storeOf(table).subscribe(listener);
  }

  subscribeKey<K extends TableName>(
    table: K,
    key: number | string,
    listener: ShadowedListener<TableMap[K]>,
  ): () => void {
    return this.storeOf(table).subscribeKey(key, listener);
  }

  subscribeKeys<K extends TableName>(
    table: K,
    listener: KeySetListener,
  ): () => void {
    let set = this.keySetListeners[table];
    if (!set) {
      set = new Set();
      this.keySetListeners[table] = set;
    }
    set.add(listener);
    return () => {
      const s = this.keySetListeners[table];
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) delete this.keySetListeners[table];
    };
  }

  get<K extends TableName>(
    table: K,
    key: number | string,
  ): TableMap[K] | undefined {
    return this.storeOf(table).get(key);
  }

  keys<K extends TableName>(table: K): IterableIterator<number | string> {
    return this.storeOf(table).client.keys();
  }

  values<K extends TableName>(table: K): IterableIterator<TableMap[K]> {
    return this.storeOf(table).client.values();
  }

  keysByIndex<K extends TableName>(
    table: K,
    indexName: string,
    indexKey: number | string,
  ): ReadonlySet<number | string> {
    return this.storeOf(table).byIndex(indexName, indexKey);
  }

  *valuesByIndex<K extends TableName>(
    table: K,
    indexName: string,
    indexKey: number | string,
  ): Generator<TableMap[K]> {
    const store = this.storeOf(table);
    for (const key of store.byIndex(indexName, indexKey)) {
      const row = store.client.get(key);
      if (row !== undefined) yield row;
    }
  }

  applyServerInsert<K extends TableName>(table: K, row: TableMap[K]): void {
    const { key, wasPresent } = this.storeOf(table).applyServerInsert(row);
    if (!wasPresent) this.notifyKeySet(table, "added", key);
  }

  applyServerUpdate<K extends TableName>(
    table: K,
    oldRow: TableMap[K],
    newRow: TableMap[K],
  ): void {
    this.storeOf(table).applyServerUpdate(oldRow, newRow);
  }

  applyServerDelete<K extends TableName>(table: K, row: TableMap[K]): void {
    const { key, wasPresent } = this.storeOf(table).applyServerDelete(row);
    if (wasPresent) this.notifyKeySet(table, "removed", key);
  }

  /** Fire a `removed` keyset event and a delete change for every row, then drop the rows. Used when a subscription's scope changes or the connection drops — listeners get a clean teardown signal before fresh data lands. Listener registrations are preserved. */
  clearTable<K extends TableName>(table: K): void {
    const store = this.storeOf(table);
    if (store.client.size === 0) return;
    const snapshot: TableMap[K][] = [];
    for (const row of store.client.values()) snapshot.push(row);
    for (const row of snapshot) {
      this.applyServerDelete(table, row);
    }
  }

  dispose(): void {
    this.zonesUnsub?.();
    this.zonesUnsub = null;
    this.cards.clear();
    this.players.clear();
    for (const key of Object.keys(this.keySetListeners) as TableName[]) {
      delete this.keySetListeners[key];
    }
    this.playersRefs = 0;
  }

  private storeOf<K extends TableName>(table: K): ShadowedStore<TableMap[K]> {
    return this[table] as unknown as ShadowedStore<TableMap[K]>;
  }

  private notifyKeySet<K extends TableName>(
    table: K,
    kind: KeySetChangeKind,
    key: number | string,
  ): void {
    const listeners = this.keySetListeners[table];
    if (!listeners) return;
    const change: KeySetChange = { kind, key };
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (err) {
        console.error("[DataManager] keyset listener threw", err);
      }
    }
  }
}
