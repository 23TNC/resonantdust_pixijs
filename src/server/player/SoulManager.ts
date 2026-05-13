import type { Soul } from "../spacetime/bindings/types";
import type { DataManager } from "../data/DataManager";
import type { PlayerManager } from "./PlayerManager";

/**
 * Tracks the local player's soul — the in-world avatar carrying the
 * player's positional state plus per-soul stat / fatigue / injury
 * counts. The chain is:
 *
 *   `PlayerManager` → `player.soul_card_id` (set by server at login) →
 *   `SoulManager` installs `subscribeSoul(id)` + `subscribeCard(id)` →
 *   the Soul row flows into `souls.current` / `soulsLocal`, the soul
 *   card row flows into `cards.current` / `cardsLocal` →
 *   listeners get a `(soul: Soul | null) => void` callback.
 *
 * Why both subscriptions: the Soul row carries the data we *react*
 * to (position + stats); the Card row is needed for the rect-card
 * visual to render. The world-zone subscription brings both in once
 * the soul anchor is set, but until then these per-id subs are the
 * bootstrap path so we can *learn* where the soul lives.
 *
 * Listeners fire on:
 * - First soul row arrival (soul_card_id resolves and the row lands
 *   via the new subscription).
 * - Any subsequent change to the soul row (position update, stat
 *   change, fatigue tick, etc.).
 * - Soul transitions (multi-character switch — not used today but the
 *   subscription teardown / reinstall path is ready).
 *
 * Wired up in `main.ts` after `PlayerManager` and `DataManager`. The
 * soul-tracking subscription is installed lazily on the first player
 * row that carries a non-zero `soul_card_id`, and torn down on
 * `dispose`.
 */
export class SoulManager {
  /** Current soul `card_id` we're subscribed to, or `null` if not
   *  yet known. Tracked separately from `soul` because the
   *  subscription lifecycle (install / tear-down) keys on the id,
   *  whereas listeners care about the row content. */
  private currentSoulId: number | null = null;
  /** Latest Soul row we've observed, or `null` if not yet delivered
   *  by the subscription (or the soul has no row in `soulsLocal`
   *  after teardown). */
  private soul: Soul | null = null;
  private readonly listeners = new Set<(soul: Soul | null) => void>();
  private unsubPlayer: (() => void) | null = null;
  private unsubSoulRow: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly players: PlayerManager,
    private readonly data: DataManager,
  ) {
    // React to player-row changes from PlayerManager. The setPlayer
    // path fires on first login and on every subsequent player-row
    // update (multi-character switch would land here too).
    this.unsubPlayer = this.players.on((player) => {
      this.handlePlayerChange(player?.soulCardId ?? 0);
    });
    // If PlayerManager already had a player when we attached
    // (unlikely under current main.ts ordering, but cheap to cover),
    // pull its initial soul id.
    const initial = this.players.getPlayer();
    if (initial) this.handlePlayerChange(initial.soulCardId);
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

  /** Player row's `soul_card_id` changed (or first arrived). Manage
   *  the subscription accordingly: drop the old soul subscription if
   *  the id changed or cleared, install a new one if we have a
   *  non-zero id. */
  private handlePlayerChange(soulCardId: number): void {
    if (this.disposed) return;
    const next = soulCardId === 0 ? null : soulCardId;
    if (next === this.currentSoulId) return;

    this.teardownSoulSubscription();
    this.currentSoulId = next;

    if (next === null) {
      // Player logged out, or migrated row arrived with
      // `soul_card_id = 0`. Drop the soul reference and notify.
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

    // Fire-and-forget for both subscriptions. The Soul row carries
    // the data we react to (position + stats); the Card row is what
    // the rect-card visual needs to actually render. The world-zone
    // subscription overlaps both once the soul anchor is set, but
    // until then these per-id subs bootstrap the chain.
    void this.data.subscriptions.subscribeSoul(next);
    void this.data.subscriptions.subscribeCard(next);
  }

  private teardownSoulSubscription(): void {
    if (this.currentSoulId !== null) {
      this.data.subscriptions.unsubscribeSoul(this.currentSoulId);
      this.data.subscriptions.unsubscribeCard(this.currentSoulId);
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
