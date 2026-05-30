import { DbConnection as PlayersDbConnection } from "./bindings/players";
import type { Player, PlayerProfile } from "./bindings/players/types";
import type { ConnectionManager } from "./ConnectionManager";
import { SubscriptionBase } from "./SubscriptionBase";

/** Maps players (auth DB) module table names to their row types. */
type PlayersTableRowMap = {
  players: Player;
  player_profiles: PlayerProfile;
} & Record<string, unknown>;

/**
 * Subscription manager for the `players` module — the canonical auth DB
 * (player identity record + per-player profile). The world (cards / souls /
 * zones / regions) still lives in `shard` and is handled by
 * `SubscriptionManager`; chat by `ChatSubscriptionManager`.
 *
 * The login row write delivered here is the session's clock-sync primitive:
 * `bindHandlers` calls `captureReducerTimestamp` on every player-row event so
 * the `Reducer`-tagged login write seeds `noteServerTime` (see
 * `PlayerManager.claimOrLogin` for the subscribe-before-reducer ordering).
 */
export class PlayersSubscriptionManager extends SubscriptionBase<
  PlayersDbConnection,
  PlayersTableRowMap
> {
  constructor(
    connection: ConnectionManager<PlayersDbConnection>,
    options?: { onReducerEvent?: (microsSinceUnixEpoch: bigint) => void },
  ) {
    super(connection, options);
  }

  protected override bindHandlers(conn: PlayersDbConnection): void {
    conn.db.players.onInsert((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("players", "onInsert", (h) => h.onInsert?.(row));
    });
    conn.db.players.onUpdate((ctx, oldRow, newRow) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("players", "onUpdate", (h) => h.onUpdate?.(oldRow, newRow));
    });
    conn.db.players.onDelete((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("players", "onDelete", (h) => h.onDelete?.(row));
    });

    conn.db.player_profiles.onInsert((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("player_profiles", "onInsert", (h) => h.onInsert?.(row));
    });
    conn.db.player_profiles.onUpdate((ctx, oldRow, newRow) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("player_profiles", "onUpdate", (h) => h.onUpdate?.(oldRow, newRow));
    });
    conn.db.player_profiles.onDelete((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("player_profiles", "onDelete", (h) => h.onDelete?.(row));
    });
  }

  async subscribePlayerByName(name: string): Promise<void> {
    const escaped = name.replace(/'/g, "''");
    return this.installSubscription(`player:name:${name}`, {
      queries: [`SELECT * FROM players WHERE name = '${escaped}'`],
      scopeKey: `name:${name}`,
    });
  }

  unsubscribePlayerByName(name: string): void {
    this.removeSubscription(`player:name:${name}`);
  }

  /** Subscribe to the per-player profile row for `playerId`. The table is
   *  `public` but each client only queries its own row, so per-player
   *  progression doesn't fan out to other players' clients. */
  async subscribePlayerProfile(playerId: number): Promise<void> {
    return this.installSubscription(`player_profile:${playerId}`, {
      queries: [`SELECT * FROM player_profiles WHERE player_id = ${playerId}`],
      scopeKey: `player_profile:${playerId}`,
    });
  }

  unsubscribePlayerProfile(playerId: number): void {
    this.removeSubscription(`player_profile:${playerId}`);
  }
}
