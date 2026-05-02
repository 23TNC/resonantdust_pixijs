import type {
  DbConnectionBuilder,
  Identity,
  SubscriptionHandleImpl,
} from "spacetimedb";
import type { DataManager } from "../state/DataManager";
import { unpackZoneId, type ZoneId } from "../zones/zoneId";
import type { DbConnection } from "./bindings";

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
          this.bindTableHandlers(conn);
          this.options.onConnected?.(conn, identity);
          resolve(conn);
          void this.reissueAllSubscriptions();
        })
        .onConnectError((_ctx, error) => {
          this.connectPromise = null;
          this.options.onConnectError?.(error);
          reject(error);
        })
        .onDisconnect((_ctx, error) => {
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
      if (existing.inFlight) return existing.inFlight;
      if (existing.handle?.isActive()) return;
    }

    if (existing) {
      if (existing.handle?.isActive()) existing.handle.unsubscribe();
      if (existing.def.scopeKey !== def.scopeKey) {
        existing.def.clearStore?.();
      }
    }

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
    if (sub.handle?.isActive()) sub.handle.unsubscribe();
    sub.def.clearStore?.();
    this.subscriptions.delete(name);
  }

  private clearCardsInZone(zoneId: ZoneId): void {
    const keys = Array.from(this.data.cards.byIndex("zone", zoneId));
    for (const key of keys) {
      const row = this.data.cards.client.get(key);
      if (row) this.data.applyServerDelete("cards", row);
    }
  }

  private async openSubscription(sub: ActiveSubscription): Promise<void> {
    sub.handle = await this.subscribeRaw(sub.def.queries);
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
    await Promise.all(
      subs.map(async (sub) => {
        sub.handle = null;
        const inFlight = this.openSubscription(sub);
        sub.inFlight = inFlight;
        try {
          await inFlight;
        } catch (err) {
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
      safe("cards", "onInsert", () => this.data.applyServerInsert("cards", row)),
    );
    conn.db.cards.onUpdate((_ctx, oldRow, newRow) =>
      safe("cards", "onUpdate", () =>
        this.data.applyServerUpdate("cards", oldRow, newRow),
      ),
    );
    conn.db.cards.onDelete((_ctx, row) =>
      safe("cards", "onDelete", () => this.data.applyServerDelete("cards", row)),
    );

    conn.db.players.onInsert((_ctx, row) =>
      safe("players", "onInsert", () =>
        this.data.applyServerInsert("players", row),
      ),
    );
    conn.db.players.onUpdate((_ctx, oldRow, newRow) =>
      safe("players", "onUpdate", () =>
        this.data.applyServerUpdate("players", oldRow, newRow),
      ),
    );
    conn.db.players.onDelete((_ctx, row) =>
      safe("players", "onDelete", () =>
        this.data.applyServerDelete("players", row),
      ),
    );
  }
}
