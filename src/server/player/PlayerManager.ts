import type { DbConnection as ShardDbConnection } from "../spacetime/bindings/shard";
import type { Player } from "../spacetime/bindings/types";
import type { ConnectionManager } from "../spacetime/ConnectionManager";
import type { DataManager } from "../data/DataManager";

const LOGIN_TIMEOUT_MS = 10_000;

export class PlayerManager {
  private player: Player | null = null;
  private subscribedName: string | null = null;
  private readonly listeners = new Set<(player: Player | null) => void>();

  constructor(
    private readonly connection: ConnectionManager<ShardDbConnection>,
    private readonly data: DataManager,
  ) {}

  getPlayer(): Player | null {
    return this.player;
  }

  isLoggedIn(): boolean {
    return this.player !== null;
  }

  on(listener: (player: Player | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Trust-on-first-use login by name. Fires the `claim_or_login`
   *  reducer (which finds or creates the player and binds this
   *  connection's `Identity` → `player_id` server-side via
   *  `player_sessions`), then subscribes to the single `players` row
   *  matching `name` to learn the resolved `player_id`.
   *
   *  Idempotent for same-name re-entry: returns the cached `Player`
   *  without re-issuing the reducer or subscription. In-place name
   *  switches are rejected — callers must `dispose()` first. */
  async claimOrLogin(name: string): Promise<Player> {
    const conn = await this.connection.connect();
    if (this.player?.name === name) return this.player;
    if (this.player) {
      throw new Error(
        `PlayerManager already holds "${this.player.name}"; dispose() before claiming "${name}"`,
      );
    }

    // Reducer first. On success, the server has either resolved the
    // existing player row by name or inserted a new one, and the
    // (caller identity → player_id) mapping in `player_sessions` is
    // bound. A reducer error (reserved name, validation failure)
    // throws here, before any subscription is taken.
    await conn.reducers.claimOrLogin({ name });

    // Listener BEFORE subscribe: `data.players.subscribe` fires from
    // inside `promote(now)`, which runs on the per-frame tick — not
    // synchronously when the subscription applies. Setting up the
    // listener first guarantees we don't miss the row's first
    // appearance in `current` after the next promote tick.
    const arrived = this.waitForPlayer(name);
    await this.data.subscriptions.subscribePlayerByName(name);
    this.subscribedName = name;

    const player = await arrived;
    this.setPlayer(player);
    return player;
  }

  dispose(): void {
    if (this.subscribedName !== null) {
      this.data.subscriptions.unsubscribePlayerByName(this.subscribedName);
      this.subscribedName = null;
    }
    this.player = null;
    this.listeners.clear();
  }

  private waitForPlayer(name: string): Promise<Player> {
    return new Promise<Player>((resolve, reject) => {
      const unsub = this.data.players.subscribe((change) => {
        if (change.kind === "removed") return;
        const row = change.kind === "added" ? change.row : change.newRow;
        if (row.name !== name) return;
        unsub();
        clearTimeout(timer);
        resolve(row);
      });
      const timer = setTimeout(() => {
        unsub();
        reject(
          new Error(
            `claimOrLogin("${name}") timed out after ${LOGIN_TIMEOUT_MS}ms`,
          ),
        );
      }, LOGIN_TIMEOUT_MS);
    });
  }

  private setPlayer(player: Player | null): void {
    this.player = player;
    for (const listener of this.listeners) listener(player);
  }
}
