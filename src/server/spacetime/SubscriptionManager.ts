import {
  MINI_ZONE_LAYER,
  makeMacroZone,
  type ZoneId,
} from "../data/packing";
import { DbConnection as ShardDbConnection } from "./bindings/shard";
// The SDK→handler fan-out below operates on the *generated* row shapes
// (`macroZone: bigint`), so this map uses those directly. `DataManager`
// coerces `macroZone` to `number` at ingestion before storing the row; the
// narrowed `number` row types live in `./bindings/types` for game code.
import type {
  Card,
  Player,
  PlayerProfile,
  Soul,
  SoulPrivate,
  Zone,
} from "./bindings/shard/types";
import type { ConnectionManager } from "./ConnectionManager";
import { SubscriptionBase, type TableHandlers } from "./SubscriptionBase";

export type { TableHandlers };

/** Maps server table names (shard module only) to their row types. */
type ShardTableRowMap = {
  cards: Card;
  players: Player;
  souls: Soul;
  soul_privates: SoulPrivate;
  player_profiles: PlayerProfile;
  zones: Zone;
} & Record<string, unknown>;

/**
 * Subscription manager for the shard module. Extends the generic
 * `SubscriptionBase` with shard-specific table bindings and typed
 * subscription helpers.
 *
 * Chat subscriptions live in `ChatSubscriptionManager` (a separate
 * `ConnectionManager<ChatDbConnection>` backed by the chat module).
 */
export class SubscriptionManager extends SubscriptionBase<
  ShardDbConnection,
  ShardTableRowMap
> {
  constructor(
    connection: ConnectionManager<ShardDbConnection>,
    options?: { onReducerEvent?: (microsSinceUnixEpoch: bigint) => void },
  ) {
    super(connection, options);
  }

  /** Bind one SDK callback per (table, event); fan-out to registered
   *  handlers happens inside. Called on every `onConnected` so each
   *  fresh connection gets its own bindings. */
  protected override bindHandlers(conn: ShardDbConnection): void {
    conn.db.cards.onInsert((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("cards", "onInsert", (h) => h.onInsert?.(row));
    });
    conn.db.cards.onUpdate((ctx, oldRow, newRow) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("cards", "onUpdate", (h) => h.onUpdate?.(oldRow, newRow));
    });
    conn.db.cards.onDelete((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("cards", "onDelete", (h) => h.onDelete?.(row));
    });

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

    conn.db.souls.onInsert((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("souls", "onInsert", (h) => h.onInsert?.(row));
    });
    conn.db.souls.onUpdate((ctx, oldRow, newRow) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("souls", "onUpdate", (h) => h.onUpdate?.(oldRow, newRow));
    });
    conn.db.souls.onDelete((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("souls", "onDelete", (h) => h.onDelete?.(row));
    });

    conn.db.soul_privates.onInsert((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("soul_privates", "onInsert", (h) => h.onInsert?.(row));
    });
    conn.db.soul_privates.onUpdate((ctx, oldRow, newRow) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("soul_privates", "onUpdate", (h) => h.onUpdate?.(oldRow, newRow));
    });
    conn.db.soul_privates.onDelete((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("soul_privates", "onDelete", (h) => h.onDelete?.(row));
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

    conn.db.zones.onInsert((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("zones", "onInsert", (h) => h.onInsert?.(row));
    });
    conn.db.zones.onUpdate((ctx, oldRow, newRow) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("zones", "onUpdate", (h) => h.onUpdate?.(oldRow, newRow));
    });
    conn.db.zones.onDelete((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("zones", "onDelete", (h) => h.onDelete?.(row));
    });

  }

  async subscribeCards(zoneId: ZoneId): Promise<void> {
    // `zoneId` IS the folded `macro_zone` (surface in bits 24-31), so a single
    // equality is exact — there's no separate `surface` column to filter on.
    return this.installSubscription(`cards:${zoneId}`, {
      queries: [`SELECT * FROM cards WHERE macro_zone = ${zoneId}`],
      scopeKey: `zone:${zoneId}`,
    });
  }

  unsubscribeCards(zoneId: ZoneId): void {
    this.removeSubscription(`cards:${zoneId}`);
  }

  async subscribeOwnedCards(ownerId: number): Promise<void> {
    return this.installSubscription(`cards:owner:${ownerId}`, {
      queries: [`SELECT * FROM cards WHERE owner_id = ${ownerId}`],
      scopeKey: `owner:${ownerId}`,
    });
  }

  unsubscribeOwnedCards(ownerId: number): void {
    this.removeSubscription(`cards:owner:${ownerId}`);
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

  async subscribeWorldZone(key: ZoneId): Promise<void> {
    // `key` is the full packed world `macro_zone` (owner 0, surface WORLD,
    // chunk coords) — a single equality is the exact scope.
    return this.installSubscription(`zones:${key}`, {
      queries: [
        `SELECT * FROM zones WHERE macro_zone = ${key}`,
        `SELECT * FROM cards WHERE macro_zone = ${key}`,
        `SELECT * FROM souls WHERE macro_zone = ${key}`,
      ],
      // Distinct from the skeleton scopeKey so a full↔skeleton swap on the same
      // sub name re-issues the subscription (see `subscribeWorldZoneSkeleton`).
      scopeKey: `macroZone:full:${key}`,
    });
  }

  /** Lighter "cold tier" subscription for a world chunk: the `zones` table
   *  only (tile skeleton) — no cards/souls streaming. Reuses the SAME sub name
   *  as `subscribeWorldZone` with a different scopeKey, so installing one over
   *  the other cleanly swaps the live subscription (`installSubscription`
   *  re-issues on a scopeKey change) — dropping cards/souls on downgrade and
   *  re-adding them on upgrade. */
  async subscribeWorldZoneSkeleton(key: ZoneId): Promise<void> {
    return this.installSubscription(`zones:${key}`, {
      queries: [`SELECT * FROM zones WHERE macro_zone = ${key}`],
      scopeKey: `macroZone:skeleton:${key}`,
    });
  }

  unsubscribeWorldZone(key: ZoneId): void {
    this.removeSubscription(`zones:${key}`);
  }

  async subscribeMiniZone(anchorCardId: number): Promise<void> {
    // The mini_zone Zone and its tile cards share the folded key
    // `(owner = anchor card_id, surface = MINI_ZONE_LAYER)`.
    const key = makeMacroZone(anchorCardId, MINI_ZONE_LAYER, 0, 0).packed;
    return this.installSubscription(`mini_zone:${anchorCardId}`, {
      queries: [
        `SELECT * FROM zones WHERE macro_zone = ${key}`,
        `SELECT * FROM cards WHERE macro_zone = ${key}`,
      ],
      scopeKey: `mini_zone:${anchorCardId}`,
    });
  }

  unsubscribeMiniZone(anchorCardId: number): void {
    this.removeSubscription(`mini_zone:${anchorCardId}`);
  }

  async subscribeCard(cardId: number): Promise<void> {
    return this.installSubscription(`card:${cardId}`, {
      queries: [`SELECT * FROM cards WHERE card_id = ${cardId}`],
      scopeKey: `card:${cardId}`,
    });
  }

  unsubscribeCard(cardId: number): void {
    this.removeSubscription(`card:${cardId}`);
  }

  async subscribeSoul(cardId: number): Promise<void> {
    return this.installSubscription(`soul:${cardId}`, {
      queries: [`SELECT * FROM souls WHERE card_id = ${cardId}`],
      scopeKey: `soul:${cardId}`,
    });
  }

  unsubscribeSoul(cardId: number): void {
    this.removeSubscription(`soul:${cardId}`);
  }

  /** Subscribe to the private per-soul state row for `cardId`. Mirrors
   *  the `PlayerProfile` pattern — the table is `public`, but each
   *  client only queries the row for the soul they actively control,
   *  so progression bits (`blueprints_0`, etc.) don't fan out to
   *  every other client mirroring this soul via the world-zone
   *  subscription. */
  async subscribeSoulPrivate(cardId: number): Promise<void> {
    return this.installSubscription(`soul_private:${cardId}`, {
      queries: [`SELECT * FROM soul_privates WHERE card_id = ${cardId}`],
      scopeKey: `soul_private:${cardId}`,
    });
  }

  unsubscribeSoulPrivate(cardId: number): void {
    this.removeSubscription(`soul_private:${cardId}`);
  }

  /** Subscribe to the per-player profile row for `playerId`. Mirrors
   *  the `subscribeSoulPrivate` pattern — the table is `public` but
   *  each client only queries its own row, so per-player
   *  progression (`blueprints_0`, `blueprint_info`, …) doesn't fan
   *  out to other players' clients via the world subscriptions. */
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
