// Row types for the `chat` shard — plain interfaces, SDK-decoupled.
// u64 → bigint, u32 → number; string → string.

export interface ChatMessage {
  sentAt: bigint;
  senderPlayerId: number;
  senderName: string;
  body: string;
}
