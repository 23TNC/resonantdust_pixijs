import type { Player } from "../spacetime/bindings/types";
import type { DataManager } from "../data/DataManager";
import type { ReducerManager } from "../spacetime/ReducerManager";

const LOGIN_TIMEOUT_MS = 10_000;

export class PlayerManager {
  private player: Player | null = null;
  private subscribedName: string | null = null;
  private readonly listeners = new Set<(player: Player | null) => void>();

  constructor(
    private readonly reducers: ReducerManager,
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
    if (this.player?.name === name) return this.player;
    if (this.player) {
      throw new Error(
        `PlayerManager already holds "${this.player.name}"; dispose() before claiming "${name}"`,
      );
    }

    // Listener BEFORE subscribe: `data.players.subscribe` fires from
    // inside `promote(now)`, which runs on the per-frame tick — not
    // synchronously when the subscription applies. Setting up the
    // listener first guarantees we don't miss the row's first
    // appearance in `current` after the next promote tick.
    const arrived = this.waitForPlayer(name);

    // **Subscribe BEFORE the reducer call.** This reducer is the
    // session's clock-sync primitive: the server's row write needs to
    // be delivered to *this client* via the transaction-update path
    // (not the post-subscribe initial-state path) so the row
    // callback fires with a `Reducer`-tagged event. That's what the
    // existing `captureReducerTimestamp` mechanism in
    // `SubscriptionBase` keys off of to seed `noteServerTime` and
    // sync the offset window. If we called the reducer first and
    // subscribed after, the row would arrive via initial-subscription
    // delivery (no timestamp) and we'd stay unsynced.
    //
    // Subscribing to a name that doesn't yet exist is fine — the SDK
    // returns an empty initial set, then the upcoming reducer write
    // matches the filter and gets delivered as a row update.
    await this.data.subscriptions.subscribePlayerByName(name);
    this.subscribedName = name;

    // Reducer next. Server has either resolved the existing player
    // row by name or inserted a new one, and the (caller identity →
    // player_id) mapping in `player_sessions` is bound. A reducer
    // error (reserved name, validation failure) throws here, before
    // we wait on the row. claim_or_login is exempt from the server's
    // `effective_now_ms` grace check (see `players.rs`) since it's
    // the very call that establishes the offset — the `client_time_ms`
    // we send is whatever stale value `serverNowMs()` returns from
    // the fallback, and that's fine.
    await this.reducers.claimOrLogin({ name });

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
