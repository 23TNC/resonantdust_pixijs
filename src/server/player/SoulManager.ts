import type { Soul } from "../spacetime/bindings/types";
import type { DataManager } from "../data/DataManager";
import type { PlayerManager } from "./PlayerManager";

/**
 * Tracks the local player's *active soul* — the in-world avatar
 * carrying positional state plus per-soul stat / fatigue / injury
 * counts.
 *
 * Source of the active-soul id: `CharacterSelectScene.handlePlay`
 * calls `setActiveSoul(cardId)` with the soul the user picked. There
 * is no server-side "currently controlled soul" — `Player` rows
 * carry only identity (id + name); each reducer that needs a soul
 * takes one explicitly, and the client-side active soul is purely
 * a UI-layer construct.
 *
 * Once set, this manager installs `subscribeSoul(id)` +
 * `subscribeCard(id)`, the Soul row flows into `souls.current` /
 * `soulsLocal`, the soul card row flows into `cards.current` /
 * `cardsLocal`, and listeners get a `(soul: Soul | null) => void`
 * callback.
 *
 * Why both subscriptions: the Soul row carries the data we *react*
 * to (position + stats); the Card row is needed for the rect-card
 * visual to render. The world-zone subscription brings both in once
 * the soul anchor is set, but until then these per-id subs are the
 * bootstrap path so we can *learn* where the soul lives.
 *
 * Listeners fire on:
 * - First soul row arrival after `setActiveSoul`.
 * - Any subsequent change to the soul row (position update, stat
 *   change, fatigue tick, etc.).
 * - Soul transitions (subsequent `setActiveSoul` calls).
 *
 * Wired up in `main.ts` after `PlayerManager` and `DataManager`.
 * The soul-tracking subscription is installed when
 * `setActiveSoul(id)` is first called with a non-zero id, and torn
 * down on `dispose` or `setActiveSoul(0)`.
 */
export class SoulManager {
  /** Current soul `card_id` we're subscribed to, or `null` if no
   *  active soul has been set yet (pre-character-select). */
  private currentSoulId: number | null = null;
  /** Latest Soul row we've observed, or `null` if not yet delivered
   *  by the subscription (or the soul has no row in `soulsLocal`
   *  after teardown). */
  private soul: Soul | null = null;
  private readonly listeners = new Set<(soul: Soul | null) => void>();
  private unsubPlayer: (() => void) | null = null;
  private unsubSoulRow: (() => void) | null = null;
  private disposed = false;
  private lastSeenPlayerId: number | null = null;

  constructor(
    private readonly players: PlayerManager,
    private readonly data: DataManager,
  ) {
    // Listen for player-id transitions (login / logout / switch).
    // When the active player changes, clear the active soul so a
    // stale id from the previous session doesn't leak across.
    // We do NOT pick a default soul from the player row — there
    // is no server-side "current soul" pointer anymore;
    // `CharacterSelectScene` is what sets the active soul.
    this.unsubPlayer = this.players.on((player) => {
      const newPlayerId = player?.playerId ?? null;
      if (newPlayerId !== this.lastSeenPlayerId) {
        this.lastSeenPlayerId = newPlayerId;
        // Drop any soul we were tracking under the prior player.
        this.handleActiveSoulChange(0);
      }
    });
    const initial = this.players.getPlayer();
    if (initial) {
      this.lastSeenPlayerId = initial.playerId;
    }
  }

  /** Set the soul this manager tracks. Called by
   *  `CharacterSelectScene.handlePlay` when the user picks a soul
   *  to play. Pass `0` (or any non-positive id) to clear and tear
   *  down the soul subscription. */
  setActiveSoul(soulCardId: number): void {
    if (this.disposed) return;
    this.handleActiveSoulChange(soulCardId <= 0 ? 0 : soulCardId);
  }

  /** Latest Soul row, or `null` if the soul hasn't been resolved yet
   *  (player not logged in, or `soul_card_id == 0` and awaiting lazy
   *  migration). */
  getSoul(): Soul | null {
    return this.soul;
  }

  /** Current soul's `card_id`, or `null` if not yet known. */
  getSoulId(): number | null {
    return this.currentSoulId;
  }

  /** Listen for soul row changes — first arrival, position updates,
   *  flag flips, soul switches. Fires immediately on subscribe with
   *  the current soul (which may be `null`). Returns an
   *  unsubscribe fn. */
  on(listener: (soul: Soul | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.soul);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubPlayer?.();
    this.unsubPlayer = null;
    this.teardownSoulSubscription();
    this.listeners.clear();
  }

  /** Active soul transitioned (set via `setActiveSoul` or cleared by
   *  a player-id change). Manage the subscription accordingly: drop
   *  the old soul subscription if the id changed or cleared, install
   *  a new one if we have a non-zero id. */
  private handleActiveSoulChange(soulCardId: number): void {
    if (this.disposed) return;
    const next = soulCardId === 0 ? null : soulCardId;
    if (next === this.currentSoulId) return;

    this.teardownSoulSubscription();
    this.currentSoulId = next;

    if (next === null) {
      // Active soul cleared (logout / pre-character-select). Drop
      // the soul reference and notify.
      this.setSoul(null);
      return;
    }

    // Install the new subscription. The row may land in
    // `souls.current` between when we call `subscribeSoul` and when
    // its first row arrives — register the row listener BEFORE
    // calling subscribe so we don't miss the initial event.
    this.unsubSoulRow = this.data.subscribeLocalSoulKey(next, (change) => {
      if (change.kind === "removed") {
        this.setSoul(null);
        return;
      }
      const row = change.kind === "added" ? change.row : change.newRow;
      this.setSoul(row);
    });

    // Surface any row that's already in `soulsLocal` (e.g. the soul
    // arrived via a different subscription before our single-card
    // one finished installing). The per-key listener only fires on
    // diffs, not initial state.
    const existing = this.data.soulsLocal.get(next);
    if (existing) this.setSoul(existing);

    // Fire-and-forget for the soul-scoped subscriptions:
    // - `subscribeSoul` brings in the public Soul row (position +
    //   stat counters — visible to other players in the same zone).
    // - `subscribeCard` brings in the soul's Card row, which the
    //   rect-card visual needs to actually render.
    // - `subscribeSoulPrivate` brings in the per-soul private state
    //   (blueprints, etc.) — this row is only delivered to the
    //   client(s) that explicitly subscribe by card_id, mirroring
    //   the PlayerProfile convention.
    // The world-zone subscription overlaps the first two once the
    // soul anchor is set, but the SoulPrivate row only ever arrives
    // through this path.
    void this.data.subscriptions.subscribeSoul(next);
    void this.data.subscriptions.subscribeCard(next);
    void this.data.subscriptions.subscribeSoulPrivate(next);
  }

  private teardownSoulSubscription(): void {
    if (this.currentSoulId !== null) {
      this.data.subscriptions.unsubscribeSoul(this.currentSoulId);
      this.data.subscriptions.unsubscribeCard(this.currentSoulId);
      this.data.subscriptions.unsubscribeSoulPrivate(this.currentSoulId);
    }
    this.unsubSoulRow?.();
    this.unsubSoulRow = null;
  }

  private setSoul(soul: Soul | null): void {
    if (this.soul === soul) return;
    this.soul = soul;
    for (const listener of this.listeners) listener(soul);
  }
}
