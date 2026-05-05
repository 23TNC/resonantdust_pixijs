import type { Action, Card, Player, Zone } from "../server/bindings/types";

/** Row type for the magnetic_actions table. Mirrors magnetic_actions_table.ts. */
export interface MagneticActionRow {
  magneticActionId: number;
  cardId: number;
  recipe: number;
  end: number;
  layer: number;
  macroZone: number;
  loopCount: number;
  deltaT: number;
}
import { debug } from "../debug";
import type { SpacetimeManager } from "../server/SpacetimeManager";
import { getStackedState, STACKED_LOOSE } from "../cards/cardData";
import { packZoneId, unpackZoneId, type ZoneId } from "../zones/zoneId";
import type { ZoneManager } from "../zones/ZoneManager";
import { ShadowedStore, type ShadowedListener } from "./ShadowedStore";
import { WORLD_LAYER } from "../world/worldCoords";
import { hasFlag, CARD_FLAG_DYING, ACTION_FLAG_DYING } from "./flags";

/** Card row extended with a client-only death counter. `dead === 0` is live;
 *  `dead === 1` means the server deleted it but it is still playing out its
 *  death (subscribers see `kind === "dying"`); `dead === 2` is the final
 *  removal (subscribers see `kind === "dead"`). */
export type ClientCard = Card & { readonly dead: 0 | 1 | 2 };

export type TableMap = {
  cards: ClientCard;
  players: Player;
  actions: Action;
  zones: Zone;
  magnetic_actions: MagneticActionRow;
};

export type TableName = keyof TableMap;

export type KeySetChangeKind = "added" | "removed";

export interface KeySetChange {
  kind: KeySetChangeKind;
  key: number | string;
}

export type KeySetListener = (change: KeySetChange) => void;

export class DataManager {
  /** Server completes actions this many ms before the client expects them,
   *  so the progress bar fills naturally before the row disappears. */
  static readonly ACTION_DISPLAY_DELAY_MS = 2000;
  /** Size of one deltaT unit in milliseconds (matches server-side 16 ms tick). */
  static readonly DELTA_T_STEP_MS = 16;

  /** Remaining display delay after accounting for how early the server finished.
   *  deltaT encodes (serverEarlyMs / DELTA_T_STEP_MS) as a u8. */
  private static rowDelay(row: { deltaT?: number }, maxDelayMs = DataManager.ACTION_DISPLAY_DELAY_MS): number {
    const elapsed = (row.deltaT ?? 0) * DataManager.DELTA_T_STEP_MS;
    if (elapsed > maxDelayMs) {
      debug.log(["actions"], `[DataManager] deltaT overrun: server took ${elapsed}ms, buffer is ${maxDelayMs}ms — client received update late`, 1);
    }
    return Math.max(0, maxDelayMs - elapsed);
  }

  readonly cards = new ShadowedStore<ClientCard>(
    (c) => c.cardId,
    { zone: (c) => packZoneId(c.macroZone, c.layer) },
    DataManager.ACTION_DISPLAY_DELAY_MS,
    (c) => DataManager.rowDelay(c as { deltaT?: number }),
  );
  readonly players = new ShadowedStore<Player>(
    (p) => p.playerId,
    { zone: (p) => packZoneId(p.macroZone, p.layer) },
    1000,
    (p) => DataManager.rowDelay(p as { deltaT?: number }, 1000),
  );
  readonly actions = new ShadowedStore<Action>(
    (a) => a.actionId,
    { zone: (a) => packZoneId(a.macroZone, a.layer) },
    DataManager.ACTION_DISPLAY_DELAY_MS,
    (a) => DataManager.rowDelay(a as { deltaT?: number }),
  );
  readonly zones = new ShadowedStore<Zone>(
    (z) => z.zoneId,
    { zone: (z) => packZoneId(z.macroZone, z.layer) },
    DataManager.ACTION_DISPLAY_DELAY_MS,
    (z) => DataManager.rowDelay(z as { deltaT?: number }),
  );
  readonly magneticActions = new ShadowedStore<MagneticActionRow>(
    (m) => m.magneticActionId,
    {
      zone: (m) => packZoneId(m.macroZone, m.layer),
      card: (m) => m.cardId,
    },
    DataManager.ACTION_DISPLAY_DELAY_MS,
    (m) => DataManager.rowDelay(m),
  );

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
   * becomes a spacetime subscription for the per-zone tables (cards +
   * actions), and demotion drops them. Replaces the old direct `trackCards`
   * API — callers now go through `zones.ensure`.
   */
  attachZones(zones: ZoneManager): void {
    if (this.zonesUnsub) {
      throw new Error("[DataManager] zones already attached");
    }
    const onAdded = (zoneId: ZoneId) => {
      const spacetime = this.requireSpacetime();
      const { macroZone, layer } = unpackZoneId(zoneId);
      if (layer >= WORLD_LAYER) {
        spacetime.subscribeWorldZone(macroZone).catch((err: unknown) => {
          console.error(`[DataManager] subscribeWorldZone(${macroZone}) failed`, err);
        });
        spacetime.subscribeActions(zoneId).catch((err: unknown) => {
          console.error(`[DataManager] subscribeActions(world:${zoneId}) failed`, err);
        });
        spacetime.subscribeMagneticActions(zoneId).catch((err: unknown) => {
          console.error(`[DataManager] subscribeMagneticActions(world:${zoneId}) failed`, err);
        });
        spacetime.subscribeWorldPlayers(macroZone).catch((err: unknown) => {
          console.error(`[DataManager] subscribeWorldPlayers(${macroZone}) failed`, err);
        });
      } else {
        spacetime.subscribeCards(zoneId).catch((err) => {
          console.error(`[DataManager] subscribeCards(${zoneId}) failed`, err);
        });
        spacetime.subscribeActions(zoneId).catch((err) => {
          console.error(`[DataManager] subscribeActions(${zoneId}) failed`, err);
        });
        spacetime.subscribeMagneticActions(zoneId).catch((err) => {
          console.error(`[DataManager] subscribeMagneticActions(${zoneId}) failed`, err);
        });
      }
    };
    const onRemoved = (zoneId: ZoneId) => {
      const spacetime = this.requireSpacetime();
      const { macroZone, layer } = unpackZoneId(zoneId);
      if (layer >= WORLD_LAYER) {
        spacetime.unsubscribeWorldZone(macroZone);
        spacetime.unsubscribeActions(zoneId);
        spacetime.unsubscribeMagneticActions(zoneId);
        spacetime.unsubscribeWorldPlayers(macroZone);
      } else {
        spacetime.unsubscribeCards(zoneId);
        spacetime.unsubscribeActions(zoneId);
        spacetime.unsubscribeMagneticActions(zoneId);
      }
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
    for (const zoneId of zones.zonesIn("active")) onAdded(zoneId);
    for (const zoneId of zones.zonesIn("hot")) onAdded(zoneId);
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

  /** Returns the card row as last received from the server, bypassing any
   *  client-side shadow (drag state, optimistic updates, etc.).
   *  Returns undefined if the server has no record of the card (not yet
   *  received, already deleted, or currently in the dying phase). */
  getServerCard(cardId: number): ClientCard | undefined {
    return this.cards.server.get(cardId);
  }

  /** Client-side card position update (drag, orphan fallback, etc.).
   *  Preserves the existing `dead` value so dying cards stay dying. */
  setClientCard(row: Card): void {
    const existing = this.cards.get(row.cardId);
    this.cards.setClient({ ...row, dead: existing?.dead ?? 0 });
  }

  applyServerInsert(table: "cards", row: Card): void;
  applyServerInsert<K extends Exclude<TableName, "cards">>(table: K, row: TableMap[K]): void;
  applyServerInsert(table: TableName, row: Card | TableMap[TableName]): void {
    if (table === "cards") {
      const clientCard: ClientCard = { ...(row as Card), dead: 0 };
      const { key, wasPresent, deferred } = this.cards.applyServerInsert(clientCard);
      if (!wasPresent && !deferred) this.notifyKeySet("cards", "added", key);
      return;
    }
    const { key, wasPresent, deferred } = this.storeOf(table).applyServerInsert(row as TableMap[typeof table]);
    if (!wasPresent && !deferred) this.notifyKeySet(table, "added", key);
  }

  applyServerUpdate(table: "cards", oldRow: Card, newRow: Card): void;
  applyServerUpdate<K extends Exclude<TableName, "cards">>(table: K, oldRow: TableMap[K], newRow: TableMap[K]): void;
  applyServerUpdate(table: TableName, oldRow: Card | TableMap[TableName], newRow: Card | TableMap[TableName]): void {
    if (table === "cards") {
      const newCard = newRow as Card;
      const existing = this.cards.get(newCard.cardId);
      if (hasFlag(newCard.flags, CARD_FLAG_DYING)) {
        // Server marked card dying via flag UPDATE (carries precise deltaT).
        // Preserve client position so the card dies where it visually sits.
        let merged: Card = newCard;
        if (existing) {
          merged = { ...newCard, macroZone: existing.macroZone, microZone: existing.microZone, microLocation: existing.microLocation };
        }
        this.cards.queueDying({ ...merged, dead: 1 } as ClientCard, DataManager.rowDelay(newCard));
        return;
      }
      let merged = newCard;
      if (existing && existing.layer && merged.layer === 1 && (merged.microZone & 0xE0) === 0) {
        // Server doesn't track inventory positions — preserve the client's
        // macroZone/microZone/microLocation so local drag state is not overwritten.
        // Only applies when BOTH client and server have localQ=0; if the server is
        // setting localQ≠0 (hex-placed), that placement is authoritative.
        merged = {
          ...merged,
          macroZone: existing.macroZone,
          microZone: existing.microZone,
          microLocation: existing.microLocation,
        };
      }
      this.cards.applyServerUpdate(oldRow as ClientCard, merged as ClientCard);
      return;
    }
    if (table === "actions") {
      const actionRow = newRow as Action;
      if (hasFlag(actionRow.flags, ACTION_FLAG_DYING)) {
        // Server marked action dying via flag UPDATE (carries precise deltaT).
        // Route through the delete path so the action disappears after the delay.
        const { key, wasPresent, deferred } = this.actions.applyServerDelete(actionRow);
        if (wasPresent && !deferred) this.notifyKeySet("actions", "removed", key);
        return;
      }
      this.actions.applyServerUpdate(oldRow as Action, actionRow);
      return;
    }
    this.storeOf(table).applyServerUpdate(
      oldRow as TableMap[typeof table],
      newRow as TableMap[typeof table],
    );
  }

  applyServerDelete(table: "cards", row: Card): void;
  applyServerDelete<K extends Exclude<TableName, "cards">>(table: K, row: TableMap[K]): void;
  applyServerDelete(table: TableName, row: Card | TableMap[TableName]): void {
    if (table === "cards") {
      const clientCard = { ...(row as Card), dead: 0 } as ClientCard;
      const { key, wasPresent } = this.cards.applyServerDelete(clientCard);
      if (wasPresent) this.notifyKeySet("cards", "removed", key);
      return;
    }
    const { key, wasPresent } = this.storeOf(table).applyServerDelete(row as TableMap[typeof table]);
    if (wasPresent) this.notifyKeySet(table, "removed", key);
  }

  /** Advance a dying card (`dead === 1`) to fully dead: removes it from the
   *  store and emits `"dead"` with the last-known row as `oldValue`. */
  advanceCardDeath(cardId: number): void {
    const { key, wasPresent } = this.cards.markDead(cardId);
    if (wasPresent) this.notifyKeySet("cards", "removed", key);
  }

  /** Fire a `removed` keyset event and remove every row. For cards this
   *  bypasses the dying phase (subscription teardown, not a game event) and
   *  emits `"dead"` directly. Listener registrations are preserved. */
  clearTable<K extends TableName>(table: K): void {
    if (table === "cards") {
      if (this.cards.client.size === 0) return;
      for (const key of [...this.cards.client.keys()]) {
        const { wasPresent } = this.cards.markDead(key);
        if (wasPresent) this.notifyKeySet("cards", "removed", key);
      }
      return;
    }
    const store = this.storeOf(table);
    if (store.client.size === 0) return;
    const rows = [...store.client.values()];
    for (const row of rows) {
      const { key, wasPresent } = store.applyServerDelete(row);
      if (wasPresent) this.notifyKeySet(table, "removed", key);
    }
  }

  /** Returns true if the given row has a queued server change not yet visible
   *  to the client. Use this to reject player interactions on stale-visible
   *  data (e.g. an action whose server delete is still in the delay window). */
  hasPendingData<K extends TableName>(table: K, key: number | string): boolean {
    return this.storeOf(table).hasPending(key);
  }

  /** Call once per frame. Promotes delayed server changes into the client maps
   *  and fires the corresponding change events and keyset notifications. */
  tick(now: number): void {
    for (const table of ["cards", "players", "actions", "zones", "magnetic_actions"] as const) {
      const { inserted, removed } = this.storeOf(table).flush(now);
      for (const key of inserted) this.notifyKeySet(table, "added", key);
      for (const key of removed) this.notifyKeySet(table, "removed", key);
    }
  }

  dispose(): void {
    this.zonesUnsub?.();
    this.zonesUnsub = null;
    this.cards.clear();
    this.players.clear();
    this.actions.clear();
    this.zones.clear();
    this.magneticActions.clear();
    for (const key of Object.keys(this.keySetListeners) as TableName[]) {
      delete this.keySetListeners[key];
    }
    this.playersRefs = 0;
  }

  private storeOf<K extends TableName>(table: K): ShadowedStore<TableMap[K]> {
    const lookup: { [T in TableName]: ShadowedStore<TableMap[T]> } = {
      cards: this.cards,
      players: this.players,
      actions: this.actions,
      zones: this.zones,
      magnetic_actions: this.magneticActions,
    };
    return lookup[table];
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
