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

    // Arm the arrival wait BEFORE subscribing/calling so we can't miss the
    // row's first appearance in the raw `server` mirror. `waitForPlayer`
    // resolves on raw arrival (not buffered promotion), so it is immune to
    // the presentation-clock lag that would otherwise delay login.
    const arrived = this.waitForPlayer(name);

    // Subscribe BEFORE the reducer call so the row's first appearance
    // (existing player resolved by name, or freshly inserted) is
    // already covered by a live subscription when the gate fans it
    // back. Subscribing to a name that doesn't yet exist is fine — the
    // gate returns an empty initial set, then the upcoming reducer
    // write matches the filter and gets delivered as a row update.
    //
    // Clock sync no longer rides this reducer's delivery: the gate's
    // `time` heartbeat (`GateSubscriptionManager` → `onReducerEvent` →
    // `noteServerTime`) is the offset source now, independent of any
    // players row write.
    await this.data.subscriptions.subscribePlayerByName(name);
    this.subscribedName = name;

    // Reducer next. The gate establishes the session (WS → player_id,
    // read from the resolved/created players row by name) as part of
    // relaying this call. A reducer error (reserved name, validation
    // failure) throws here, before we wait on the row.
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
      // Login identity is a control fact, not a render-timed view: resolve
      // the instant the players row EXISTS in the raw `server` mirror,
      // WITHOUT waiting for `promote(now)` to surface it through the
      // presentation buffer. That buffer runs up to `clientDelay` behind
      // server time (1.5–5s), while the row is stamped only
      // `TIME_DRIFT_BUFFER_MS` (2s) in the past — so a freshly-claimed row
      // can sit in the buffered future and never promote within the login
      // timeout. `observeServer` fires on raw arrival; a synchronous
      // presence scan first covers the row already being present (re-login,
      // or arrival before this listener attached).
      const present = (): Player | undefined => {
        for (const row of this.data.players.current.values())
          if (row.name === name) return row;
        for (const row of this.data.players.server.values())
          if (row.name === name) return row;
        return undefined;
      };
      const existing = present();
      if (existing) {
        resolve(existing);
        return;
      }
      const unsub = this.data.players.observeServer((row) => {
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
    // The gate relays writes under its own identity, so the shard reducers
    // that authenticate the caller now trust a `caller_player_id` arg —
    // `ReducerManager` injects this for them.
    this.reducers.setCallerPlayerId(player?.playerId ?? null);
    for (const listener of this.listeners) listener(player);
  }
}
