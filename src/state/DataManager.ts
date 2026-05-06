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
import type { SpacetimeManager } from "../server/SpacetimeManager";
import { getStackedState, STACKED_LOOSE } from "../cards/cardData";
import { packZoneId, unpackZoneId, type ZoneId } from "../zones/zoneId";
import type { ZoneManager } from "../zones/ZoneManager";
import { ShadowedStore, type ShadowedListener } from "./ShadowedStore";
import { WORLD_LAYER } from "../world/worldCoords";

/** Card row extended with a client-only death counter. `dead === 0` is live;
 *  `dead === 1` means the server flagged it dead via `FLAG_CARD_DEAD` (bit 7
 *  of `flags`) and it is still playing out its death (subscribers see
 *  `kind === "dying"`); `dead === 2` is the final removal (subscribers see
 *  `kind === "dead"`). */
export type ClientCard = Card & { readonly dead: 0 | 1 | 2 };

/** Bit 7 of `Card.flags`. Mirrors `FLAG_CARD_DEAD` in the Rust module: the
 *  server sets this via UPDATE (carrying `delta_t`) instead of deleting the
 *  row outright, so the client can back-date its death animation by
 *  `16 * delta_t` ms. The actual row delete arrives later via the server-side
 *  reaper. */
const FLAG_CARD_DEAD = 1 << 7;

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

/** Server stamps `end` (seconds) for the original timeline; the client receives
 *  the row `delayMs` later, so its `end` slides forward by the same amount to
 *  keep progress animations aligned with what the user is actually seeing.
 *  The server map keeps the unshifted value. */
const shiftEndByDelay = <R extends { end: number }>(row: R, delayMs: number): R => ({
  ...row,
  end: row.end + delayMs / 1000,
});

/** Every spacetime table carries `delta_t` (u8, 16-ms increments) — the
 *  scheduled-reducer lag at the time the row was written. Subtracted from the
 *  client display buffer so server lateness consumes the buffer rather than
 *  stacking on top of it. */
const deltaTMsFromRow = <R extends { deltaT: number }>(row: R): number => row.deltaT * 16;

/** Pending applyServer* / markDying promises reject when the store is cleared
 *  or disposed. Listeners are torn down separately, so we just need to keep
 *  the unhandled-rejection noise out of the console. */
const swallowCancelled = (): void => {};

export class DataManager {
  readonly cards = new ShadowedStore<ClientCard>(
    (c) => c.cardId,
    { zone: (c) => packZoneId(c.macroZone, c.layer) },
    { deltaTMs: deltaTMsFromRow, delayMs: 2000 },
  );
  readonly players = new ShadowedStore<Player>(
    (p) => p.playerId,
    { zone: (p) => packZoneId(p.macroZone, p.layer) },
    { deltaTMs: deltaTMsFromRow },
  );
  readonly actions = new ShadowedStore<Action>(
    (a) => a.actionId,
    { zone: (a) => packZoneId(a.macroZone, a.layer) },
    { clientTransform: shiftEndByDelay, deltaTMs: deltaTMsFromRow, delayMs: 2000 },
  );
  readonly zones = new ShadowedStore<Zone>(
    (z) => z.zoneId,
    { zone: (z) => packZoneId(z.macroZone, z.layer) },
    { deltaTMs: deltaTMsFromRow, delayMs: 2000 },
  );
  readonly magneticActions = new ShadowedStore<MagneticActionRow>(
    (m) => m.magneticActionId,
    {
      zone: (m) => packZoneId(m.macroZone, m.layer),
      card: (m) => m.cardId,
    },
    { clientTransform: shiftEndByDelay, deltaTMs: deltaTMsFromRow, delayMs: 2000 },
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

  /** Server-side read: bypasses every client-side shadow (drag state,
   *  optimistic `setClient`, dying rows still in the client map for their
   *  death animation, and rows pending a delayed client commit). Returns
   *  undefined if the server has no row for `key`. */
  getServer<K extends TableName>(
    table: K,
    key: number | string,
  ): TableMap[K] | undefined {
    return this.storeOf(table).server.get(key);
  }

  /** True if the server map has an entry for `key`. May differ from a
   *  client-side check during a delayed write, while a card is dying, or
   *  when an optimistic local row exists with no server confirmation yet. */
  hasServer<K extends TableName>(table: K, key: number | string): boolean {
    return this.storeOf(table).server.has(key);
  }

  serverKeys<K extends TableName>(table: K): IterableIterator<number | string> {
    return this.storeOf(table).server.keys();
  }

  serverValues<K extends TableName>(table: K): IterableIterator<TableMap[K]> {
    return this.storeOf(table).server.values();
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
      const merged = this.preserveInventoryPosition(row as Card);
      const clientCard: ClientCard = { ...merged, dead: 0 };
      this.dispatchInsert("cards", clientCard);
      return;
    }
    this.dispatchInsert(table, row as TableMap[typeof table]);
  }

  applyServerUpdate(table: "cards", oldRow: Card, newRow: Card): void;
  applyServerUpdate<K extends Exclude<TableName, "cards">>(table: K, oldRow: TableMap[K], newRow: TableMap[K]): void;
  applyServerUpdate(table: TableName, oldRow: Card | TableMap[TableName], newRow: Card | TableMap[TableName]): void {
    if (table === "cards") {
      const newCard = newRow as Card;
      const oldCard = oldRow as Card;
      const merged = this.preserveInventoryPosition(newCard);
      const becameDead =
        (newCard.flags & FLAG_CARD_DEAD) !== 0 &&
        (oldCard.flags & FLAG_CARD_DEAD) === 0;
      if (becameDead) {
        void this.cards.markDying({ ...merged, dead: 1 }).catch(swallowCancelled);
        return;
      }
      this.dispatchUpdate("cards", oldRow as ClientCard, merged as ClientCard);
      return;
    }
    this.dispatchUpdate(
      table,
      oldRow as TableMap[typeof table],
      newRow as TableMap[typeof table],
    );
  }

  private dispatchInsert<K extends TableName>(table: K, row: TableMap[K]): void {
    void this.storeOf(table).applyServerInsert(row).then(
      ({ key, wasPresent }) => {
        if (!wasPresent) this.notifyKeySet(table, "added", key);
      },
      swallowCancelled,
    );
  }

  private dispatchUpdate<K extends TableName>(
    table: K,
    oldRow: TableMap[K],
    newRow: TableMap[K],
  ): void {
    void this.storeOf(table).applyServerUpdate(oldRow, newRow).catch(swallowCancelled);
  }

  /** When both the client and the server agree the card is in the inventory
   *  (layer === 1) and the server isn't using localQ to override its position
   *  (top 3 bits of microZone are zero), the client's macroZone / microZone /
   *  microLocation are kept — the server doesn't track inventory layout, so
   *  taking its values would clobber drag state and slot ordering. */
  private preserveInventoryPosition(row: Card): Card {
    const existing = this.cards.get(row.cardId);
    if (
      existing &&
      existing.layer === 1 &&
      row.layer === 1 &&
      (row.microZone & 0xE0) === 0
    ) {
      return {
        ...row,
        macroZone: existing.macroZone,
        microZone: existing.microZone,
        microLocation: existing.microLocation,
      };
    }
    return row;
  }

  /** Final row removal — emits `"delete"` for all tables. The dying phase
   *  for cards is now driven by `applyServerUpdate` detecting `FLAG_CARD_DEAD`,
   *  so by the time the server-side reaper deletes the row the client has
   *  typically already torn it down via `advanceCardDeath`; this is the
   *  cleanup path for any row that's still hanging around. */
  applyServerDelete(table: "cards", row: Card): void;
  applyServerDelete<K extends Exclude<TableName, "cards">>(table: K, row: TableMap[K]): void;
  applyServerDelete(table: TableName, row: Card | TableMap[TableName]): void {
    void this.storeOf(table).applyServerDelete(row as TableMap[typeof table]).then(
      ({ key, wasPresent }) => {
        if (wasPresent) this.notifyKeySet(table, "removed", key);
      },
      swallowCancelled,
    );
  }

  /** Advance a dying card (`dead === 1`) to fully dead: removes it from the
   *  store and emits `"dead"` with the last-known row as `oldValue`. */
  advanceCardDeath(cardId: number): void {
    const { key, wasPresent } = this.cards.markDead(cardId);
    if (wasPresent) this.notifyKeySet("cards", "removed", key);
  }

  /** Fire a `removed` keyset event and remove every row. For cards this
   *  bypasses the dying phase (subscription teardown, not a game event) and
   *  emits `"dead"` directly. Listener registrations are preserved.
   *  Bypasses the per-store display buffer (`delayMs: 0`) — teardowns are
   *  about discarding stale state, not animating it through. */
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
      void store.applyServerDelete(row, 0).then(
        ({ key, wasPresent }) => {
          if (wasPresent) this.notifyKeySet(table, "removed", key);
        },
        swallowCancelled,
      );
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
