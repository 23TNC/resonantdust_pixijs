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
 * Owns one typed `ConnectionManager` per directly-connected SpacetimeDB module
 * (`chat`, `players`). DB names follow `resonantdust-{env}-{module}-{shard}`
 * (single-instance modules use shard `0`).
 *
 * `players` is the canonical auth DB (player record + profile); `chat` is the
 * world chat. Everything else — cards, souls, zones, regions, and all gameplay
 * reducers — goes through the gate, not a direct module connection here.
 */
export class ConnectionRegistry {
  readonly chat: ConnectionManager<ChatDbConnection>;
  readonly players: ConnectionManager<PlayersDbConnection>;

  constructor(options: ConnectionRegistryOptions) {
    const { uri, env } = options;

    const chatOpts: ConnectionManagerOptions = {
      uri,
      databaseName: `resonantdust-${env}-chat-0`,
      tokenStore: options.tokenStore,
    };
    const playersOpts: ConnectionManagerOptions = {
      uri,
      databaseName: `resonantdust-${env}-players-0`,
      tokenStore: options.tokenStore,
    };

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
    void this.chat.connect();
    void this.players.connect();
  }

  disconnectAll(): void {
    this.chat.disconnect();
    this.players.disconnect();
  }
}
