import type {
  DbConnectionBuilder,
  Identity,
  SubscriptionHandleImpl,
} from "spacetimedb";
import { debug } from "../debug";
import type { DataManager } from "../state/DataManager";
import { WORLD_LAYER } from "../world/worldCoords";
import { packZoneId, unpackZoneId, type ZoneId } from "../zones/zoneId";
import type { DbConnection } from "./bindings";
import type { InventoryStack } from "./bindings/types";

type AnySubscriptionHandle = SubscriptionHandleImpl<any>;

export interface TokenStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const localStorageTokenStore: TokenStore = {
  get: (key) => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
  remove: (key) => localStorage.removeItem(key),
};

export interface SpacetimeManagerOptions {
  uri: string;
  databaseName: string;
  builderFactory: () => DbConnectionBuilder<DbConnection>;
  data: DataManager;
  tokenStorageKey?: string;
  tokenStore?: TokenStore;
  onConnected?: (connection: DbConnection, identity: Identity) => void;
  onConnectError?: (error: Error) => void;
  onDisconnected?: (error?: Error) => void;
}

interface SubscriptionDef {
  queries: string[];
  scopeKey: string;
  clearStore?: () => void;
  /** Called after onApplied fires. Use to sync SDK cache → DataManager when the
   *  SDK may not re-fire onInsert for rows already in its local table. */
  onApplied?: () => void;
}

interface ActiveSubscription {
  name: string;
  def: SubscriptionDef;
  handle: AnySubscriptionHandle | null;
  inFlight: Promise<void> | null;
}

/**
 * Owns the SpacetimeDB websocket lifecycle, the auth token, ALL table event
 * handler bindings (one function per event type per table — they live here so
 * the SDK constraint is enforced in one place), and ALL active subscriptions.
 *
 * Subscriptions are tracked in a registry keyed by name (`"cards"`,
 * `"players"`, …). Re-issuing a name with a new `scopeKey` (e.g. different
 * `playerId`) tears down the old subscription, clears the matching store, and
 * subscribes anew. On reconnect, every active subscription is re-issued.
 *
 * `DataManager.track<Table>(...)` is the only caller of `subscribe<Table>` /
 * `unsubscribe<Table>` — DataManager refcounts intent and drives these at the
 * 0↔1 boundary. Scenes / feature modules call `data.track…`, not these
 * directly.
 */
export class SpacetimeManager {
  private connection: DbConnection | null = null;
  private identity: Identity | null = null;
  private token: string | null = null;
  private connectPromise: Promise<DbConnection> | null = null;
  private readonly tokenKey: string;
  private readonly tokenStore: TokenStore;
  private readonly data: DataManager;
  private readonly subscriptions = new Map<string, ActiveSubscription>();

  constructor(private readonly options: SpacetimeManagerOptions) {
    this.tokenKey =
      options.tokenStorageKey ?? `spacetime.token.${options.databaseName}`;
    this.tokenStore = options.tokenStore ?? localStorageTokenStore;
    this.token = this.tokenStore.get(this.tokenKey);
    this.data = options.data;
  }

  get isConnected(): boolean {
    return this.connection !== null;
  }

  getConnection(): DbConnection | null {
    return this.connection;
  }

  getIdentity(): Identity | null {
    return this.identity;
  }

  connect(): Promise<DbConnection> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.connectPromise) return this.connectPromise;

    debug.log(["spacetime"], `[spacetime] connecting to ${this.options.uri} / ${this.options.databaseName}`, 3);

    this.connectPromise = new Promise<DbConnection>((resolve, reject) => {
      const builder = this.options
        .builderFactory()
        .withUri(this.options.uri)
        .withDatabaseName(this.options.databaseName)
        .onConnect((conn, identity, token) => {
          this.connection = conn;
          this.identity = identity;
          this.token = token;
          this.tokenStore.set(this.tokenKey, token);
          debug.log(["spacetime"], `[spacetime] connected identity=${identity.toHexString()}`, 3);
          this.bindTableHandlers(conn);
          this.options.onConnected?.(conn, identity);
          resolve(conn);
          void this.reissueAllSubscriptions();
        })
        .onConnectError((_ctx, error) => {
          debug.log(["spacetime"], `[spacetime] connect error: ${error.message}`, 3);
          this.connectPromise = null;
          this.options.onConnectError?.(error);
          reject(error);
        })
        .onDisconnect((_ctx, error) => {
          debug.log(["spacetime"], `[spacetime] disconnected${error ? `: ${error.message}` : ""}`, 3);
          this.connection = null;
          this.connectPromise = null;
          for (const sub of this.subscriptions.values()) {
            sub.handle = null;
            sub.def.clearStore?.();
          }
          this.options.onDisconnected?.(error);
        });

      if (this.token) builder.withToken(this.token);

      builder.build();
    });

    return this.connectPromise;
  }

  /** Generic SQL subscription. Prefer the typed `subscribe<Table>` helpers. */
  async subscribe(query: string | string[]): Promise<AnySubscriptionHandle> {
    const queries = Array.isArray(query) ? query : [query];
    return this.subscribeRaw(queries);
  }

  async subscribeCards(zoneId: ZoneId): Promise<void> {
    const { macroZone, layer } = unpackZoneId(zoneId);
    return this.installSubscription(`cards:${zoneId}`, {
      queries: [
        `SELECT * FROM cards WHERE macro_zone = ${macroZone} AND layer = ${layer}`,
      ],
      scopeKey: `zone:${zoneId}`,
      clearStore: () => this.clearCardsInZone(zoneId),
    });
  }

  unsubscribeCards(zoneId: ZoneId): void {
    this.removeSubscription(`cards:${zoneId}`);
  }

  async subscribePlayers(): Promise<void> {
    return this.installSubscription("players", {
      queries: ["SELECT * FROM players"],
      scopeKey: "all",
      clearStore: () => this.data.clearTable("players"),
    });
  }

  unsubscribePlayers(): void {
    this.removeSubscription("players");
  }

  async subscribeActions(zoneId: ZoneId): Promise<void> {
    const { macroZone, layer } = unpackZoneId(zoneId);
    return this.installSubscription(`actions:${zoneId}`, {
      queries: [
        `SELECT * FROM actions WHERE macro_zone = ${macroZone} AND layer = ${layer}`,
      ],
      scopeKey: `zone:${zoneId}`,
      clearStore: () => this.clearActionsInZone(zoneId),
    });
  }

  unsubscribeActions(zoneId: ZoneId): void {
    this.removeSubscription(`actions:${zoneId}`);
  }

  async subscribeMagneticActions(zoneId: ZoneId): Promise<void> {
    const { macroZone, layer } = unpackZoneId(zoneId);
    return this.installSubscription(`magnetic_actions:${zoneId}`, {
      queries: [
        `SELECT * FROM magnetic_actions WHERE macro_zone = ${macroZone} AND layer = ${layer}`,
      ],
      scopeKey: `zone:${zoneId}`,
      clearStore: () => this.clearMagneticActionsInZone(zoneId),
    });
  }

  unsubscribeMagneticActions(zoneId: ZoneId): void {
    this.removeSubscription(`magnetic_actions:${zoneId}`);
  }

  async subscribeWorldZone(macroZone: number): Promise<void> {
    return this.installSubscription(`zones:${macroZone}`, {
      queries: [
        `SELECT * FROM zones WHERE macro_zone = ${macroZone}`,
        `SELECT * FROM cards WHERE macro_zone = ${macroZone} AND layer = ${WORLD_LAYER}`,
      ],
      scopeKey: `macroZone:${macroZone}`,
      clearStore: () => {
        this.clearWorldZone(macroZone);
        this.clearWorldCards(macroZone);
      },
      // After onApplied, the SDK may not have re-fired onInsert for rows already
      // in its local cache. Sync zones and world cards independently. Check the
      // server map, not client — within the display-buffer window after a recent
      // teardown the client map can still hold rows whose deletion is pending,
      // which would falsely suppress hydration. Bypass the buffer (`delayMs: 0`)
      // since we're re-hydrating from a local cache, not animating in fresh
      // server state.
      onApplied: () => {
        const conn = this.connection;
        if (!conn) return;
        const hasZone = [...this.data.zones.server.values()].some(z => z.macroZone === macroZone);
        if (!hasZone) {
          for (const zone of conn.db.zones.iter()) {
            if (zone.macroZone === macroZone) {
              this.data.applyServerInsert("zones", zone, 0);
            }
          }
        }
        const hasCard = [...this.data.cards.server.values()].some(c => c.macroZone === macroZone && c.layer === WORLD_LAYER);
        if (!hasCard) {
          for (const card of conn.db.cards.iter()) {
            if (card.macroZone === macroZone && card.layer === WORLD_LAYER) {
              this.data.applyServerInsert("cards", card, 0);
            }
          }
        }
      },
    });
  }

  unsubscribeWorldZone(macroZone: number): void {
    this.removeSubscription(`zones:${macroZone}`);
  }

  async subscribeWorldPlayers(macroZone: number): Promise<void> {
    const zoneId = packZoneId(macroZone, WORLD_LAYER);
    return this.installSubscription(`players:${macroZone}`, {
      queries: [`SELECT * FROM players WHERE macro_zone = ${macroZone} AND layer = ${WORLD_LAYER}`],
      scopeKey: `macroZone:${macroZone}`,
      clearStore: () => this.clearPlayersInWorldZone(zoneId),
    });
  }

  unsubscribeWorldPlayers(macroZone: number): void {
    this.removeSubscription(`players:${macroZone}`);
  }

  /**
   * Submit inventory stacks to trigger recipe matching on the server.
   * The server runs the upgrade machinery (`process_top_branch` /
   * `process_bottom_branch`) over each submitted stack — start, keep,
   * cancel, or upgrade decisions all flow from this single reducer.
   * There is intentionally no separate cancel reducer: the only way a
   * client influences action state is by submitting validated stacks
   * (or by causing card creation, which fires the on_create matcher).
   */
  async submitStacks(stacks: InventoryStack[]): Promise<void> {
    debug.log(["spacetime"], `[spacetime] submitStacks count=${stacks.length}`, 2);
    const conn = await this.connect();
    await conn.reducers.submitInventoryStacks({ stacks });
  }

  disconnect(): void {
    this.connection?.disconnect();
    this.connection = null;
    this.connectPromise = null;
    for (const sub of this.subscriptions.values()) {
      sub.handle = null;
    }
  }

  clearToken(): void {
    this.tokenStore.remove(this.tokenKey);
    this.token = null;
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

    if (existing) {
      if (existing.handle?.isActive()) existing.handle.unsubscribe();
      if (existing.def.scopeKey !== def.scopeKey) {
        debug.log(["spacetime"], `[spacetime] sub "${name}" scope changed ${existing.def.scopeKey} → ${def.scopeKey}, clearing store`, 2);
        existing.def.clearStore?.();
      }
    }

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
    sub.def.clearStore?.();
    this.subscriptions.delete(name);
  }

  private clearWorldZone(macroZone: number): void {
    // Zone identity is `(macroZone, layer)` — scan all zones with this
    // macroZone (across layers) since the subscribe API only carries
    // macroZone. Once subscriptions become layer-scoped, this can use
    // the `zone` secondary index instead. Sweep both server and client maps
    // so rows visible in only one (e.g. a pending insert whose buffer hasn't
    // fired) still get torn down.
    const keys = new Set<number>();
    for (const z of this.data.zones.server.values()) {
      if (z.macroZone === macroZone) keys.add(z.zoneId);
    }
    for (const z of this.data.zones.client.values()) {
      if (z.macroZone === macroZone) keys.add(z.zoneId);
    }
    for (const key of keys) this.data.dropRow("zones", key);
  }

  private clearPlayersInWorldZone(zoneId: ZoneId): void {
    const keys = new Set<number | string>(this.data.players.byIndex("zone", zoneId));
    for (const p of this.data.players.server.values()) {
      if (packZoneId(p.macroZone, p.layer) === zoneId) keys.add(p.playerId);
    }
    for (const key of keys) this.data.dropRow("players", key);
  }

  private clearWorldCards(macroZone: number): void {
    const keys = new Set<number | string>();
    for (const card of this.data.cards.server.values()) {
      if (card.macroZone === macroZone && card.layer >= WORLD_LAYER) keys.add(card.cardId);
    }
    for (const card of this.data.cards.client.values()) {
      if (card.macroZone === macroZone && card.layer >= WORLD_LAYER) keys.add(card.cardId);
    }
    for (const key of keys) this.data.dropRow("cards", key);
  }

  private clearCardsInZone(zoneId: ZoneId): void {
    const keys = new Set<number | string>(this.data.cards.byIndex("zone", zoneId));
    for (const card of this.data.cards.server.values()) {
      if (packZoneId(card.macroZone, card.layer) === zoneId) keys.add(card.cardId);
    }
    for (const key of keys) this.data.dropRow("cards", key);
  }

  private clearActionsInZone(zoneId: ZoneId): void {
    const keys = new Set<number | string>(this.data.actions.byIndex("zone", zoneId));
    for (const a of this.data.actions.server.values()) {
      if (packZoneId(a.macroZone, a.layer) === zoneId) keys.add(a.actionId);
    }
    for (const key of keys) this.data.dropRow("actions", key);
  }

  private clearMagneticActionsInZone(zoneId: ZoneId): void {
    const keys = new Set<number | string>(this.data.magneticActions.byIndex("zone", zoneId));
    for (const m of this.data.magneticActions.server.values()) {
      if (packZoneId(m.macroZone, m.layer) === zoneId) keys.add(m.magneticActionId);
    }
    for (const key of keys) this.data.dropRow("magnetic_actions", key);
  }

  private async openSubscription(sub: ActiveSubscription): Promise<void> {
    debug.log(["spacetime"], `[spacetime] opening sub "${sub.name}" queries=${sub.def.queries.join(" | ")}`, 1);
    sub.handle = await this.subscribeRaw(sub.def.queries);
    debug.log(["spacetime"], `[spacetime] sub "${sub.name}" applied`, 2);
    sub.def.onApplied?.();
  }

  private async subscribeRaw(queries: string[]): Promise<AnySubscriptionHandle> {
    const conn = await this.connect();
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

  private bindTableHandlers(conn: DbConnection): void {
    const safe = (table: string, op: string, fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        console.error(`[spacetime] ${table}.${op} handler threw`, err);
      }
    };

    conn.db.cards.onInsert((_ctx, row) =>
      safe("cards", "onInsert", () => {
        debug.log(["spacetime"], `[spacetime] cards.onInsert id=${row.cardId}`, 2);
        this.data.applyServerInsert("cards", row);
      }),
    );
    conn.db.cards.onUpdate((_ctx, oldRow, newRow) =>
      safe("cards", "onUpdate", () => {
        debug.log(["spacetime"], `[spacetime] cards.onUpdate id=${newRow.cardId}`, 1);
        this.data.applyServerUpdate("cards", oldRow, newRow);
      }),
    );
    conn.db.cards.onDelete((_ctx, row) =>
      safe("cards", "onDelete", () => {
        debug.log(["spacetime"], `[spacetime] cards.onDelete id=${row.cardId}`, 2);
        this.data.applyServerDelete("cards", row);
      }),
    );

    conn.db.players.onInsert((_ctx, row) =>
      safe("players", "onInsert", () => {
        debug.log(["spacetime"], `[spacetime] players.onInsert id=${row.playerId} name=${row.name}`, 2);
        this.data.applyServerInsert("players", row);
      }),
    );
    conn.db.players.onUpdate((_ctx, oldRow, newRow) =>
      safe("players", "onUpdate", () => {
        debug.log(["spacetime"], `[spacetime] players.onUpdate id=${newRow.playerId} name=${newRow.name}`, 1);
        this.data.applyServerUpdate("players", oldRow, newRow);
      }),
    );
    conn.db.players.onDelete((_ctx, row) =>
      safe("players", "onDelete", () => {
        debug.log(["spacetime"], `[spacetime] players.onDelete id=${row.playerId} name=${row.name}`, 2);
        this.data.applyServerDelete("players", row);
      }),
    );

    conn.db.actions.onInsert((_ctx, row) =>
      safe("actions", "onInsert", () => {
        debug.log(["spacetime"], `[spacetime] actions.onInsert id=${row.actionId}`, 2);
        this.data.applyServerInsert("actions", row);
      }),
    );
    conn.db.actions.onUpdate((_ctx, oldRow, newRow) =>
      safe("actions", "onUpdate", () => {
        debug.log(["spacetime"], `[spacetime] actions.onUpdate id=${newRow.actionId}`, 1);
        this.data.applyServerUpdate("actions", oldRow, newRow);
      }),
    );
    conn.db.actions.onDelete((_ctx, row) =>
      safe("actions", "onDelete", () => {
        debug.log(["spacetime"], `[spacetime] actions.onDelete id=${row.actionId}`, 2);
        this.data.applyServerDelete("actions", row);
      }),
    );

    conn.db.magnetic_actions.onInsert((_ctx, row) =>
      safe("magnetic_actions", "onInsert", () => {
        debug.log(["actions"], `[spacetime] magnetic_actions.onInsert id=${row.magneticActionId} cardId=${row.cardId}`, 2);
        this.data.applyServerInsert("magnetic_actions", row);
      }),
    );
    conn.db.magnetic_actions.onUpdate((_ctx, oldRow, newRow) =>
      safe("magnetic_actions", "onUpdate", () => {
        debug.log(["actions"], `[spacetime] magnetic_actions.onUpdate id=${newRow.magneticActionId} cardId=${newRow.cardId}`, 1);
        this.data.applyServerUpdate("magnetic_actions", oldRow, newRow);
      }),
    );
    conn.db.magnetic_actions.onDelete((_ctx, row) =>
      safe("magnetic_actions", "onDelete", () => {
        debug.log(["actions"], `[spacetime] magnetic_actions.onDelete id=${row.magneticActionId} cardId=${row.cardId}`, 2);
        this.data.applyServerDelete("magnetic_actions", row);
      }),
    );

    conn.db.zones.onInsert((_ctx, row) =>
      safe("zones", "onInsert", () => {
        debug.log(["spacetime"], `[spacetime] zones.onInsert macroZone=${row.macroZone}`, 2);
        this.data.applyServerInsert("zones", row);
      }),
    );
    conn.db.zones.onUpdate((_ctx, oldRow, newRow) =>
      safe("zones", "onUpdate", () => {
        debug.log(["spacetime"], `[spacetime] zones.onUpdate macroZone=${newRow.macroZone}`, 1);
        this.data.applyServerUpdate("zones", oldRow, newRow);
      }),
    );
    conn.db.zones.onDelete((_ctx, row) =>
      safe("zones", "onDelete", () => {
        debug.log(["spacetime"], `[spacetime] zones.onDelete macroZone=${row.macroZone}`, 2);
        this.data.applyServerDelete("zones", row);
      }),
    );
  }
}
