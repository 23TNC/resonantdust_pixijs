import type { SubscriptionHandleImpl } from "spacetimedb";
import { debug } from "../../debug";
import { unpackZoneId, WORLD_LAYER, type ZoneId } from "../data/packing";
import type { DbConnection } from "./bindings";
import type { Card, Player, Zone } from "./bindings/types";
import type { ConnectionManager } from "./ConnectionManager";

type AnySubscriptionHandle = SubscriptionHandleImpl<any>;

interface SubscriptionDef {
  queries: string[];
  scopeKey: string;
}

interface ActiveSubscription {
  name: string;
  def: SubscriptionDef;
  handle: AnySubscriptionHandle | null;
  inFlight: Promise<void> | null;
}

/** Maps server table names to their row types. Add to this map when a new
 *  table gets bindings, and add a matching block in `bindHandlers`. */
interface TableRowMap {
  cards: Card;
  players: Player;
  zones: Zone;
}

type TableName = keyof TableRowMap;

export interface TableHandlers<T> {
  onInsert?: (row: T) => void;
  onUpdate?: (oldRow: T, newRow: T) => void;
  onDelete?: (row: T) => void;
}

/**
 * Owns the subscription registry AND the SDK row-event fan-out. Other
 * managers (DataManager) call `registerTableHandlers` to plug into
 * insert/update/delete events; SubscriptionManager binds the SDK callback
 * once per `onConnected` and routes each event to every registered handler.
 *
 * Subscriptions themselves are tracked by name (`"cards:zone:42"`,
 * `"players"`, …); re-issuing the same name with a new `scopeKey` tears
 * down the old one and subscribes anew. On reconnect, every active
 * subscription is re-issued and SDK row handlers are re-bound.
 */
export class SubscriptionManager {
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private readonly handlers = new Map<TableName, Set<TableHandlers<any>>>();
  private readonly removeConnectionListener: () => void;

  constructor(private readonly connection: ConnectionManager) {
    this.removeConnectionListener = this.connection.addListener({
      onConnected: (conn) => {
        this.bindHandlers(conn);
        void this.reissueAllSubscriptions();
      },
      onDisconnected: () => {
        for (const sub of this.subscriptions.values()) {
          sub.handle = null;
        }
      },
    });
  }

  /** Tear down: drops the connection listener, unsubscribes every active
   *  subscription, and clears the registry + handler map. After dispose
   *  this manager will no longer react to connect / disconnect events,
   *  and the SDK row handlers it bound die with the next disconnect (or
   *  immediately, since the conn references this set via closure and the
   *  set is now empty). Use on HMR / runtime teardown. */
  dispose(): void {
    this.removeConnectionListener();
    for (const sub of this.subscriptions.values()) {
      if (sub.handle?.isActive()) sub.handle.unsubscribe();
    }
    this.subscriptions.clear();
    this.handlers.clear();
  }

  /** Register insert/update/delete handlers for a table. Handlers fire for
   *  every row event the SDK delivers, regardless of which subscription
   *  brought the row in. Multiple registrations for the same table all
   *  fire in registration order. Returns an unregister fn. */
  registerTableHandlers<K extends TableName>(
    table: K,
    handlers: TableHandlers<TableRowMap[K]>,
  ): () => void {
    let set = this.handlers.get(table);
    if (!set) {
      set = new Set();
      this.handlers.set(table, set);
    }
    set.add(handlers as TableHandlers<any>);
    return () => {
      set!.delete(handlers as TableHandlers<any>);
    };
  }

  /** Generic SQL subscription. Prefer the typed `subscribe<Table>` helpers. */
  async subscribe(query: string | string[]): Promise<AnySubscriptionHandle> {
    const queries = Array.isArray(query) ? query : [query];
    return this.subscribeRaw(queries);
  }

  async subscribeCards(zoneId: ZoneId): Promise<void> {
    const { macroZone, layer: surface } = unpackZoneId(zoneId);
    return this.installSubscription(`cards:${zoneId}`, {
      queries: [
        `SELECT * FROM cards WHERE macro_zone = ${macroZone} AND surface = ${surface}`,
      ],
      scopeKey: `zone:${zoneId}`,
    });
  }

  unsubscribeCards(zoneId: ZoneId): void {
    this.removeSubscription(`cards:${zoneId}`);
  }

  async subscribePlayers(): Promise<void> {
    return this.installSubscription("players", {
      queries: ["SELECT * FROM players"],
      scopeKey: "all",
    });
  }

  unsubscribePlayers(): void {
    this.removeSubscription("players");
  }

  async subscribeActions(zoneId: ZoneId): Promise<void> {
    const { macroZone, layer: surface } = unpackZoneId(zoneId);
    return this.installSubscription(`actions:${zoneId}`, {
      queries: [
        `SELECT * FROM actions WHERE macro_zone = ${macroZone} AND surface = ${surface}`,
      ],
      scopeKey: `zone:${zoneId}`,
    });
  }

  unsubscribeActions(zoneId: ZoneId): void {
    this.removeSubscription(`actions:${zoneId}`);
  }

  async subscribeMagneticActions(zoneId: ZoneId): Promise<void> {
    const { macroZone, layer: surface } = unpackZoneId(zoneId);
    return this.installSubscription(`magnetic_actions:${zoneId}`, {
      queries: [
        `SELECT * FROM magnetic_actions WHERE macro_zone = ${macroZone} AND surface = ${surface}`,
      ],
      scopeKey: `zone:${zoneId}`,
    });
  }

  unsubscribeMagneticActions(zoneId: ZoneId): void {
    this.removeSubscription(`magnetic_actions:${zoneId}`);
  }

  async subscribeWorldZone(macroZone: number): Promise<void> {
    return this.installSubscription(`zones:${macroZone}`, {
      queries: [
        `SELECT * FROM zones WHERE macro_zone = ${macroZone}`,
        `SELECT * FROM cards WHERE macro_zone = ${macroZone} AND surface = ${WORLD_LAYER}`,
      ],
      scopeKey: `macroZone:${macroZone}`,
    });
  }

  unsubscribeWorldZone(macroZone: number): void {
    this.removeSubscription(`zones:${macroZone}`);
  }

  async subscribeWorldPlayers(macroZone: number): Promise<void> {
    return this.installSubscription(`players:${macroZone}`, {
      queries: [`SELECT * FROM players WHERE macro_zone = ${macroZone} AND surface = ${WORLD_LAYER}`],
      scopeKey: `macroZone:${macroZone}`,
    });
  }

  unsubscribeWorldPlayers(macroZone: number): void {
    this.removeSubscription(`players:${macroZone}`);
  }

  private async installSubscription(
    name: string,
    def: SubscriptionDef,
  ): Promise<void> {
    const existing = this.subscriptions.get(name);

    if (existing && existing.def.scopeKey === def.scopeKey) {
      if (existing.inFlight) {
        debug.log(["spacetime"], `[spacetime] sub "${name}" already in flight, waiting`, 1);
        return existing.inFlight;
      }
      if (existing.handle?.isActive()) {
        debug.log(["spacetime"], `[spacetime] sub "${name}" already active, skipping`, 1);
        return;
      }
    }

    if (existing?.handle?.isActive()) existing.handle.unsubscribe();

    debug.log(["spacetime"], `[spacetime] installing sub "${name}" scope=${def.scopeKey}`, 2);

    const sub: ActiveSubscription = {
      name,
      def,
      handle: null,
      inFlight: null,
    };
    this.subscriptions.set(name, sub);

    const inFlight = this.openSubscription(sub);
    sub.inFlight = inFlight;
    try {
      await inFlight;
    } finally {
      sub.inFlight = null;
    }
  }

  private removeSubscription(name: string): void {
    const sub = this.subscriptions.get(name);
    if (!sub) return;
    debug.log(["spacetime"], `[spacetime] removing sub "${name}"`, 2);
    if (sub.handle?.isActive()) sub.handle.unsubscribe();
    this.subscriptions.delete(name);
  }

  private async openSubscription(sub: ActiveSubscription): Promise<void> {
    debug.log(["spacetime"], `[spacetime] opening sub "${sub.name}" queries=${sub.def.queries.join(" | ")}`, 1);
    sub.handle = await this.subscribeRaw(sub.def.queries);
    debug.log(["spacetime"], `[spacetime] sub "${sub.name}" applied`, 2);
  }

  private async subscribeRaw(queries: string[]): Promise<AnySubscriptionHandle> {
    const conn = await this.connection.connect();
    return new Promise<AnySubscriptionHandle>((resolve, reject) => {
      let handle: AnySubscriptionHandle | undefined;
      handle = conn
        .subscriptionBuilder()
        .onApplied(() => {
          if (handle) resolve(handle);
          else
            reject(
              new Error(
                "[spacetime] subscription applied before handle was assigned",
              ),
            );
        })
        .onError((ctx) => {
          const event = (ctx as { event?: { error?: unknown } } | undefined)
            ?.event;
          const detail = event?.error;
          const message = `subscription error (${queries.join(" | ")}): ${
            detail instanceof Error
              ? detail.message
              : detail !== undefined
                ? String(detail)
                : "no detail from SDK"
          }`;
          reject(detail instanceof Error ? detail : new Error(message));
        })
        .subscribe(queries);
    });
  }

  private async reissueAllSubscriptions(): Promise<void> {
    const subs = Array.from(this.subscriptions.values());
    debug.log(["spacetime"], `[spacetime] reissuing ${subs.length} subscription(s) after reconnect`, 3);
    await Promise.all(
      subs.map(async (sub) => {
        debug.log(["spacetime"], `[spacetime] reissuing sub "${sub.name}"`, 1);
        sub.handle = null;
        const inFlight = this.openSubscription(sub);
        sub.inFlight = inFlight;
        try {
          await inFlight;
        } catch (err) {
          debug.log(["spacetime"], `[spacetime] re-subscribe "${sub.name}" failed: ${err instanceof Error ? err.message : String(err)}`, 3);
          console.error(
            `[spacetime] re-subscribe ${sub.name} failed`,
            err,
          );
        } finally {
          sub.inFlight = null;
        }
      }),
    );
  }

  /** Bind one SDK callback per (table, event); fan-out to registered
   *  handlers happens inside. Called on every `onConnected` so each fresh
   *  conn gets its own bindings. */
  private bindHandlers(conn: DbConnection): void {
    conn.db.cards.onInsert((_ctx, row) => {
      // [diag] raw SDK event order — investigating teleport-on-stack repro.
      console.log(`[diag] sdk onInsert id=${row.cardId} validAt=${row.validAt} mz=${row.microZone} ml=${row.microLocation} flags=${row.flags}`);
      this.fanOut("cards", "onInsert", (h) => h.onInsert?.(row));
    });
    conn.db.cards.onUpdate((_ctx, oldRow, newRow) => {
      console.log(`[diag] sdk onUpdate id=${newRow.cardId} validAt ${oldRow.validAt}→${newRow.validAt} mz ${oldRow.microZone}→${newRow.microZone}`);
      this.fanOut("cards", "onUpdate", (h) => h.onUpdate?.(oldRow, newRow));
    });
    conn.db.cards.onDelete((_ctx, row) => {
      console.log(`[diag] sdk onDelete id=${row.cardId} validAt=${row.validAt} mz=${row.microZone} ml=${row.microLocation} flags=${row.flags}`);
      this.fanOut("cards", "onDelete", (h) => h.onDelete?.(row));
    });

    conn.db.players.onInsert((_ctx, row) =>
      this.fanOut("players", "onInsert", (h) => h.onInsert?.(row)),
    );
    conn.db.players.onUpdate((_ctx, oldRow, newRow) =>
      this.fanOut("players", "onUpdate", (h) => h.onUpdate?.(oldRow, newRow)),
    );
    conn.db.players.onDelete((_ctx, row) =>
      this.fanOut("players", "onDelete", (h) => h.onDelete?.(row)),
    );

    conn.db.zones.onInsert((_ctx, row) =>
      this.fanOut("zones", "onInsert", (h) => h.onInsert?.(row)),
    );
    conn.db.zones.onUpdate((_ctx, oldRow, newRow) =>
      this.fanOut("zones", "onUpdate", (h) => h.onUpdate?.(oldRow, newRow)),
    );
    conn.db.zones.onDelete((_ctx, row) =>
      this.fanOut("zones", "onDelete", (h) => h.onDelete?.(row)),
    );
  }

  private fanOut<K extends TableName>(
    table: K,
    op: string,
    fn: (h: TableHandlers<TableRowMap[K]>) => void,
  ): void {
    const set = this.handlers.get(table);
    if (!set) return;
    for (const h of set) {
      try {
        fn(h as TableHandlers<TableRowMap[K]>);
      } catch (err) {
        console.error(`[spacetime] ${table}.${op} handler threw`, err);
      }
    }
  }
}
