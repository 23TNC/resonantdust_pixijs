import type { Identity } from "spacetimedb";
import { debug } from "../../debug";

export interface TokenStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Per-origin token store. All tabs on the same origin share this
 *  — appropriate when only one player ever logs in from one origin,
 *  inappropriate for local multi-tab testing where each tab should
 *  represent a distinct player. See `sessionStorageTokenStore` for
 *  the per-tab default. */
export const localStorageTokenStore: TokenStore = {
  get: (key) => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
  remove: (key) => localStorage.removeItem(key),
};

/** Per-tab token store — each browser tab has its own
 *  `sessionStorage`, so two tabs on the same origin get distinct
 *  SpacetimeDB identities and don't share a `PlayerSession` row on
 *  the server. This is the right default for development (multiple
 *  test clients in tabs) and acceptable for production (closing a
 *  tab forces re-login, which is normal for most web apps).
 *
 *  If "remember me across tab close" is needed later, the caller
 *  can supply `localStorageTokenStore` via the
 *  `ConnectionManagerOptions.tokenStore` override — every other
 *  module in this codebase is agnostic to the storage backend. */
export const sessionStorageTokenStore: TokenStore = {
  get: (key) => sessionStorage.getItem(key),
  set: (key, value) => sessionStorage.setItem(key, value),
  remove: (key) => sessionStorage.removeItem(key),
};

/** Callbacks for connect / error / disconnect events. Generic over
 *  the module-specific connection type so typed callers (e.g.
 *  SubscriptionBase subclasses) receive the correct DbConnection. */
export interface ConnectionListener<TConn> {
  onConnected?: (connection: TConn, identity: Identity) => void;
  onConnectError?: (error: Error) => void;
  onDisconnected?: (error?: Error) => void;
}

export interface ConnectionManagerOptions {
  uri: string;
  databaseName: string;
  tokenStorageKey?: string;
  tokenStore?: TokenStore;
}

/** Arguments passed to the factory function on each connect attempt. */
export interface ConnectFnOpts<TConn> {
  uri: string;
  databaseName: string;
  token: string | null;
  onConnect: (conn: TConn, identity: Identity, token: string) => void;
  onConnectError: (ctx: unknown, error: Error) => void;
  onDisconnect: (ctx: unknown, error?: Error) => void;
}

/** Caller-supplied factory that drives the module-specific
 *  `DbConnection.builder()` chain and calls `builder.build()`.
 *  Injected by `ConnectionRegistry` so `ConnectionManager` stays
 *  agnostic of the concrete DbConnection class. */
export type ConnectFn<TConn> = (opts: ConnectFnOpts<TConn>) => void;

/**
 * Generic SpacetimeDB connection owner. Manages the websocket lifecycle,
 * auth token, and identity for one module database (shard or chat).
 *
 * TConn — the module-specific DbConnection type produced by the factory.
 *
 * Other managers (SubscriptionBase subclasses, ReducerManager) sit on top
 * via `addListener`, which fans out connect / connectError / disconnect
 * events so each manager can react (re-issue subscriptions, drop stale
 * handles, etc.) without coupling to one another.
 */
export class ConnectionManager<TConn> {
  private connection: TConn | null = null;
  private identity: Identity | null = null;
  private token: string | null = null;
  private connectPromise: Promise<TConn> | null = null;
  private readonly tokenKey: string;
  private readonly tokenStore: TokenStore;
  private readonly listeners = new Set<ConnectionListener<TConn>>();

  constructor(
    private readonly options: ConnectionManagerOptions,
    private readonly connectFn: ConnectFn<TConn>,
  ) {
    this.tokenKey =
      options.tokenStorageKey ?? `spacetime.token.${options.databaseName}`;
    this.tokenStore = options.tokenStore ?? sessionStorageTokenStore;
    this.token = this.tokenStore.get(this.tokenKey);
  }

  get isConnected(): boolean {
    return this.connection !== null;
  }

  getConnection(): TConn | null {
    return this.connection;
  }

  getIdentity(): Identity | null {
    return this.identity;
  }

  /** Register a connect/disconnect listener. Returns an unsubscribe fn. */
  addListener(listener: ConnectionListener<TConn>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(): Promise<TConn> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.connectPromise) return this.connectPromise;

    debug.log(
      ["spacetime"],
      `[spacetime] connecting to ${this.options.uri} / ${this.options.databaseName}`,
      4,
    );

    this.connectPromise = new Promise<TConn>((resolve, reject) => {
      this.connectFn({
        uri: this.options.uri,
        databaseName: this.options.databaseName,
        token: this.token,
        onConnect: (conn, identity, token) => {
          this.connection = conn;
          this.identity = identity;
          this.token = token;
          this.tokenStore.set(this.tokenKey, token);
          debug.log(
            ["spacetime"],
            `[spacetime] connected identity=${identity.toHexString()}`,
            4,
          );
          resolve(conn);
          this.notifyConnected(conn, identity);
        },
        onConnectError: (_ctx, error) => {
          debug.log(
            ["spacetime"],
            `[spacetime] connect error: ${error.message}`,
            4,
          );
          this.connectPromise = null;
          this.notifyConnectError(error);
          reject(error);
        },
        onDisconnect: (_ctx, error) => {
          debug.log(
            ["spacetime"],
            `[spacetime] disconnected${error ? `: ${error.message}` : ""}`,
            4,
          );
          this.connection = null;
          this.connectPromise = null;
          this.notifyDisconnected(error);
        },
      });
    });

    return this.connectPromise;
  }

  disconnect(): void {
    (this.connection as { disconnect?(): void } | null)?.disconnect?.();
    this.connection = null;
    this.connectPromise = null;
  }

  clearToken(): void {
    this.tokenStore.remove(this.tokenKey);
    this.token = null;
  }

  private notifyConnected(conn: TConn, identity: Identity): void {
    for (const l of this.listeners) {
      try {
        l.onConnected?.(conn, identity);
      } catch (err) {
        console.error("[connection] onConnected listener threw", err);
      }
    }
  }

  private notifyConnectError(error: Error): void {
    for (const l of this.listeners) {
      try {
        l.onConnectError?.(error);
      } catch (err) {
        console.error("[connection] onConnectError listener threw", err);
      }
    }
  }

  private notifyDisconnected(error?: Error): void {
    for (const l of this.listeners) {
      try {
        l.onDisconnected?.(error);
      } catch (err) {
        console.error("[connection] onDisconnected listener threw", err);
      }
    }
  }
}
