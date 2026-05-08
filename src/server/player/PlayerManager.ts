import type { Player } from "../spacetime/bindings/types";
import type { ConnectionManager } from "../spacetime/ConnectionManager";
import type { DataManager } from "../data/DataManager";

const LOGIN_TIMEOUT_MS = 10_000;

export class PlayerManager {
  private player: Player | null = null;
  private readonly listeners = new Set<(player: Player | null) => void>();
  private subscribed = false;

  constructor(
    private readonly connection: ConnectionManager,
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

  async claimOrLogin(name: string): Promise<Player> {
    const conn = await this.connection.connect();
    if (this.player?.name === name) return this.player;

    if (!this.subscribed) {
      await this.data.subscriptions.subscribePlayers();
      this.subscribed = true;
    }

    const existing = this.findPlayerByName(name);
    if (existing) {
      this.setPlayer(existing);
      return existing;
    }

    const inserted = this.waitForPlayer(name);
    await conn.reducers.claimOrLogin({ name });
    const player = await inserted;
    this.setPlayer(player);
    return player;
  }

  dispose(): void {
    if (this.subscribed) {
      this.data.subscriptions.unsubscribePlayers();
      this.subscribed = false;
    }
    this.player = null;
    this.listeners.clear();
  }

  private findPlayerByName(name: string): Player | null {
    for (const row of this.data.players.current.values()) {
      if (row.name === name) return row;
    }
    return null;
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
