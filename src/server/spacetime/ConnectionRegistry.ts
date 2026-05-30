import { DbConnection as ShardDbConnection } from "./bindings/shard";
import { DbConnection as ChatDbConnection } from "./bindings/chat";
import { DbConnection as PlayersDbConnection } from "./bindings/players";
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

function makePlayersConnectFn(): ConnectFn<PlayersDbConnection> {
  return (opts) => {
    PlayersDbConnection.builder()
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
 * Owns one typed `ConnectionManager` per SpacetimeDB module (`shard`,
 * `chat`, `players`). DB names follow the pattern
 * `resonantdust-{env}-{module}`.
 *
 * Callers that need to route a reducer or subscription to the right database
 * read from `registry.shard` / `registry.chat` / `registry.players` directly.
 * The `players` module is the canonical auth DB (player record + profile);
 * the world still lives on `shard` (see the migration plan).
 */
export class ConnectionRegistry {
  readonly shard: ConnectionManager<ShardDbConnection>;
  readonly chat: ConnectionManager<ChatDbConnection>;
  readonly players: ConnectionManager<PlayersDbConnection>;

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
    const playersOpts: ConnectionManagerOptions = {
      uri,
      databaseName: `resonantdust-${env}-players`,
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
    this.players = new ConnectionManager<PlayersDbConnection>(
      playersOpts,
      makePlayersConnectFn(),
    );
  }

  connectAll(): void {
    void this.shard.connect();
    void this.chat.connect();
    void this.players.connect();
  }

  disconnectAll(): void {
    this.shard.disconnect();
    this.chat.disconnect();
    this.players.disconnect();
  }
}
