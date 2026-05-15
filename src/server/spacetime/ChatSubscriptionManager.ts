import { DbConnection as ChatDbConnection } from "./bindings/chat";
import type { ChatMessage } from "./bindings/chat/types";
import type { ConnectionManager } from "./ConnectionManager";
import { SubscriptionBase } from "./SubscriptionBase";

/** Maps chat module table names to their row types. */
type ChatTableRowMap = {
  chat_messages: ChatMessage;
} & Record<string, unknown>;

/**
 * Subscription manager for the chat module. Handles only `chat_messages` —
 * all game-data subscriptions live in `SubscriptionManager` (shard module).
 */
export class ChatSubscriptionManager extends SubscriptionBase<
  ChatDbConnection,
  ChatTableRowMap
> {
  constructor(
    connection: ConnectionManager<ChatDbConnection>,
    options?: { onReducerEvent?: (microsSinceUnixEpoch: bigint) => void },
  ) {
    super(connection, options);
  }

  protected override bindHandlers(conn: ChatDbConnection): void {
    conn.db.chat_messages.onInsert((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("chat_messages", "onInsert", (h) => h.onInsert?.(row));
    });
    conn.db.chat_messages.onUpdate((ctx, oldRow, newRow) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("chat_messages", "onUpdate", (h) => h.onUpdate?.(oldRow, newRow));
    });
    conn.db.chat_messages.onDelete((ctx, row) => {
      this.captureReducerTimestamp(ctx);
      this.fanOut("chat_messages", "onDelete", (h) => h.onDelete?.(row));
    });
  }

  /** Subscribe to the global chat feed with a `sent_at` cutoff. Only rows
   *  whose `sent_at > threshold` (packed u64) flow through. */
  async subscribeChat(threshold: bigint): Promise<void> {
    return this.installSubscription("chat", {
      queries: [`SELECT * FROM chat_messages WHERE sent_at > ${threshold.toString()}`],
      scopeKey: `since:${threshold.toString()}`,
    });
  }

  unsubscribeChat(): void {
    this.removeSubscription("chat");
  }
}
