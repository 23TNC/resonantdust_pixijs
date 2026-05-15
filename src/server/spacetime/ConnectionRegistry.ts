import { DbConnection as ShardDbConnection } from "./bindings/shard";
import { DbConnection as ChatDbConnection } from "./bindings/chat";
import {
  ConnectionManager,
  type ConnectFn,
  type ConnectionManagerOptions,
  type TokenStore,
} from "./ConnectionManager";

export interface ConnectionRegistryOptions {
  uri: string;
  /** Environment segment of the DB name, e.g. `"dev"`, `"prod"`. */
  env: string;
  tokenStore?: TokenStore;
}

function makeShardConnectFn(): ConnectFn<ShardDbConnection> {
  return (opts) => {
    ShardDbConnection.builder()
      .withUri(opts.uri)
      .withDatabaseName(opts.databaseName)
      .withToken(opts.token ?? undefined)
      .onConnect(opts.onConnect)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .onConnectError(opts.onConnectError as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .onDisconnect(opts.onDisconnect as any)
      .build();
  };
}

function makeChatConnectFn(): ConnectFn<ChatDbConnection> {
  return (opts) => {
    ChatDbConnection.builder()
      .withUri(opts.uri)
      .withDatabaseName(opts.databaseName)
      .withToken(opts.token ?? undefined)
      .onConnect(opts.onConnect)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .onConnectError(opts.onConnectError as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .onDisconnect(opts.onDisconnect as any)
      .build();
  };
}

/**
 * Owns two typed `ConnectionManager` instances — one for each SpacetimeDB
 * module (`shard` and `chat`). DB names follow the pattern
 * `resonantdust-{env}-{module}`.
 *
 * Callers that need to route a reducer or subscription to the right database
 * read from `registry.shard` or `registry.chat` directly.
 */
export class ConnectionRegistry {
  readonly shard: ConnectionManager<ShardDbConnection>;
  readonly chat: ConnectionManager<ChatDbConnection>;

  constructor(options: ConnectionRegistryOptions) {
    const { uri, env } = options;

    const shardOpts: ConnectionManagerOptions = {
      uri,
      databaseName: `resonantdust-${env}-shard`,
      tokenStore: options.tokenStore,
    };
    const chatOpts: ConnectionManagerOptions = {
      uri,
      databaseName: `resonantdust-${env}-chat`,
      tokenStore: options.tokenStore,
    };

    this.shard = new ConnectionManager<ShardDbConnection>(
      shardOpts,
      makeShardConnectFn(),
    );
    this.chat = new ConnectionManager<ChatDbConnection>(
      chatOpts,
      makeChatConnectFn(),
    );
  }

  connectAll(): void {
    void this.shard.connect();
    void this.chat.connect();
  }

  disconnectAll(): void {
    this.shard.disconnect();
    this.chat.disconnect();
  }
}
