import type { Identity } from "spacetimedb";
import { debug } from "../../debug";
import { DbConnection } from "./bindings";

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

export interface ConnectionListener {
  onConnected?: (connection: DbConnection, identity: Identity) => void;
  onConnectError?: (error: Error) => void;
  onDisconnected?: (error?: Error) => void;
}

export interface ConnectionManagerOptions {
  uri: string;
  databaseName: string;
  tokenStorageKey?: string;
  tokenStore?: TokenStore;
}

/**
 * Owns the SpacetimeDB websocket lifecycle, the auth token, and the
 * identity. Other managers (subscriptions, reducers) sit on top via
 * `addListener`, which fans out connect / connectError / disconnect events
 * so each manager can react (re-issue subscriptions, drop stale handles,
 * etc.) without coupling to one another.
 */
export class ConnectionManager {
  private connection: DbConnection | null = null;
  private identity: Identity | null = null;
  private token: string | null = null;
  private connectPromise: Promise<DbConnection> | null = null;
  private readonly tokenKey: string;
  private readonly tokenStore: TokenStore;
  private readonly listeners = new Set<ConnectionListener>();

  constructor(private readonly options: ConnectionManagerOptions) {
    this.tokenKey =
      options.tokenStorageKey ?? `spacetime.token.${options.databaseName}`;
    this.tokenStore = options.tokenStore ?? localStorageTokenStore;
    this.token = this.tokenStore.get(this.tokenKey);
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

  /** Register a connect/disconnect listener. Returns an unsubscribe fn. */
  addListener(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(): Promise<DbConnection> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.connectPromise) return this.connectPromise;

    debug.log(
      ["spacetime"],
      `[spacetime] connecting to ${this.options.uri} / ${this.options.databaseName}`,
      3,
    );

    this.connectPromise = new Promise<DbConnection>((resolve, reject) => {
      const builder = DbConnection.builder()
        .withUri(this.options.uri)
        .withDatabaseName(this.options.databaseName)
        .onConnect((conn, identity, token) => {
          this.connection = conn;
          this.identity = identity;
          this.token = token;
          this.tokenStore.set(this.tokenKey, token);
          debug.log(
            ["spacetime"],
            `[spacetime] connected identity=${identity.toHexString()}`,
            3,
          );
          resolve(conn);
          this.notifyConnected(conn, identity);
        })
        .onConnectError((_ctx, error) => {
          debug.log(
            ["spacetime"],
            `[spacetime] connect error: ${error.message}`,
            3,
          );
          this.connectPromise = null;
          this.notifyConnectError(error);
          reject(error);
        })
        .onDisconnect((_ctx, error) => {
          debug.log(
            ["spacetime"],
            `[spacetime] disconnected${error ? `: ${error.message}` : ""}`,
            3,
          );
          this.connection = null;
          this.connectPromise = null;
          this.notifyDisconnected(error);
        });

      if (this.token) builder.withToken(this.token);

      builder.build();
    });

    return this.connectPromise;
  }

  disconnect(): void {
    this.connection?.disconnect();
    this.connection = null;
    this.connectPromise = null;
  }

  clearToken(): void {
    this.tokenStore.remove(this.tokenKey);
    this.token = null;
  }

  private notifyConnected(conn: DbConnection, identity: Identity): void {
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
