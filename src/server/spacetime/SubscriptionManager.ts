import { MINI_ZONE_LAYER, unpackZoneId, WORLD_LAYER, type ZoneId } from "../data/packing";
import { DbConnection as ShardDbConnection } from "./bindings/shard";
import type { Card, MagneticAction, Player, Soul, Zone } from "./bindings/types";
import type { ConnectionManager } from "./ConnectionManager";
import { SubscriptionBase, type TableHandlers } from "./SubscriptionBase";

export type { TableHandlers };

/** Maps server table names (shard module only) to their row types. */
type ShardTableRowMap = {
  cards: Card;
  players: Player;
  souls: Soul;
  zones: Zone;
  magnetic_actions: MagneticAction;
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

    conn.db.magnetic_actions.onInsert((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("magnetic_actions", "onInsert", (h) => h.onInsert?.(row));
    });
    conn.db.magnetic_actions.onUpdate((ctx, oldRow, newRow) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("magnetic_actions", "onUpdate", (h) => h.onUpdate?.(oldRow, newRow));
    });
    conn.db.magnetic_actions.onDelete((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("magnetic_actions", "onDelete", (h) => h.onDelete?.(row));
    });
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

  async subscribeWorldZone(macroZone: number): Promise<void> {
    return this.installSubscription(`zones:${macroZone}`, {
      queries: [
        `SELECT * FROM zones WHERE macro_zone = ${macroZone}`,
        `SELECT * FROM cards WHERE macro_zone = ${macroZone} AND surface = ${WORLD_LAYER}`,
        `SELECT * FROM souls WHERE macro_zone = ${macroZone} AND surface = ${WORLD_LAYER}`,
      ],
      scopeKey: `macroZone:${macroZone}`,
    });
  }

  unsubscribeWorldZone(macroZone: number): void {
    this.removeSubscription(`zones:${macroZone}`);
  }

  async subscribeMiniZone(anchorCardId: number): Promise<void> {
    return this.installSubscription(`mini_zone:${anchorCardId}`, {
      queries: [
        `SELECT * FROM zones WHERE macro_zone = ${anchorCardId} AND surface = ${MINI_ZONE_LAYER}`,
        `SELECT * FROM cards WHERE macro_zone = ${anchorCardId} AND surface = ${MINI_ZONE_LAYER}`,
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
}
