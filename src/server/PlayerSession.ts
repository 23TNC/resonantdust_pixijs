import type { Player } from "../server/bindings/types";
import type { SpacetimeManager } from "../server/SpacetimeManager";
import type { DataManager } from "../state/DataManager";

const LOGIN_TIMEOUT_MS = 10_000;

export class PlayerSession {
  private player: Player | null = null;
  private readonly listeners = new Set<(player: Player | null) => void>();
  private releasePlayers: (() => void) | null = null;

  constructor(
    private readonly spacetime: SpacetimeManager,
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
    const conn = await this.spacetime.connect();
    if (this.player?.name === name) return this.player;

    if (!this.releasePlayers) {
      this.releasePlayers = this.data.trackPlayers();
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
    this.releasePlayers?.();
    this.releasePlayers = null;
    this.player = null;
    this.listeners.clear();
  }

  private findPlayerByName(name: string): Player | null {
    for (const row of this.data.players.server.values()) {
      if (row.name === name) return row;
    }
    return null;
  }

  private waitForPlayer(name: string): Promise<Player> {
    return new Promise<Player>((resolve, reject) => {
      // Read from the server map directly so the display delay on the players
      // store does not block login — the row lands in server immediately.
      const unsub = this.data.players.subscribeServerWrite((row) => {
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
