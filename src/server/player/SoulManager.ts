import type { Soul } from "../spacetime/bindings/types";
import type { DataManager, LocalCard } from "../data/DataManager";
import type { PlayerManager } from "./PlayerManager";
import type { ZoneManager } from "../../game/zones/ZoneManager";

// `is_owned_by_player` is bit 4 of `cards_state` post unified-hold-counts rework.
const FLAG_OWNED_BY_PLAYER = 1 << 4;

/**
 * Tracks the local player's *active soul* — a legacy singleton
 * concept retained for consumers that still expect "the one soul
 * the player is controlling": `BlueprintsPanel`, `DragManager`,
 * `dropResolver`, `CardManager`'s soul-bucket fallback. In the
 * unified PanelManager model, "active" maps to the soul of the
 * currently-focused `GameViewPanel`; `MainScene.handlePlay` keeps
 * this manager in sync by calling `setActiveSoul(soulCardId)`
 * whenever a game-view panel is opened.
 *
 * `setActiveSoul(id)` installs `subscribeSoul(id)` +
 * `subscribeCard(id)` + `subscribeSoulPrivate(id)` so the soul row
 * arrives in `soulsLocal` and listeners (`on(cb)`) get notified.
 * `GameViewPanel` independently installs the same subs (deduped at
 * `SubscriptionBase`) so per-panel queries keep working even when
 * the singleton "active" pointer is stale.
 *
 * Also owns the player-wide owned-soul inventory tracker
 * (`startTrackingOwnedSoulInventories`) — refcounts every owned
 * soul's inventory zone so recipes keep ticking regardless of which
 * inventory panel is open.
 *
 * Future consolidation: consumers of `getSoul` / `getSoulId` /
 * `on` migrate to query `ctx.panels.focused("gameview")`'s soul
 * directly; this manager then sheds the singleton API and keeps
 * only the player-wide tracker.
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

  /** Refcounted inventory-zone holders for every soul currently owned
   *  by the local player, while
   *  `startTrackingOwnedSoulInventories()` is in effect. Keeps every
   *  soul's recipes processing on this client even when its inventory
   *  panel isn't open — view-panel `ensureInventory` calls stack on
   *  top of these via `ZoneManager` refcounts. */
  private readonly ownedSoulInventoryReleases = new Map<number, () => void>();
  private unsubOwnedSoulCards: (() => void) | null = null;

  constructor(
    private readonly players: PlayerManager,
    private readonly data: DataManager,
    private readonly zones: ZoneManager,
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
    this.stopTrackingOwnedSoulInventories();
    this.unsubPlayer?.();
    this.unsubPlayer = null;
    this.teardownSoulSubscription();
    this.listeners.clear();
  }

  /** Begin holding an inventory-zone refcount for every soul the
   *  local player owns. Must be called AFTER
   *  `subscribeOwnedCards(playerId)` — soul rows arrive via that
   *  subscription, and we both walk `cardsLocal` once for what's
   *  already there and listen for live add/remove. Balanced by
   *  `stopTrackingOwnedSoulInventories`. Second call is a no-op. */
  startTrackingOwnedSoulInventories(): void {
    if (this.disposed || this.unsubOwnedSoulCards) return;
    const playerId = this.lastSeenPlayerId;
    if (playerId === null) return;

    for (const row of this.data.cardsLocal.values()) {
      if (this.isOwnedSoul(row, playerId)) {
        this.holdInventory(row.cardId);
      }
    }

    this.unsubOwnedSoulCards = this.data.subscribeLocalCard((change) => {
      const pid = this.lastSeenPlayerId;
      if (pid === null) return;
      if (change.kind === "added") {
        if (this.isOwnedSoul(change.row, pid)) this.holdInventory(change.key);
      } else if (change.kind === "removed") {
        this.releaseInventory(change.key);
      } else {
        const was = this.isOwnedSoul(change.oldRow, pid);
        const is = this.isOwnedSoul(change.newRow, pid);
        if (was && !is) this.releaseInventory(change.key);
        else if (!was && is) this.holdInventory(change.key);
      }
    });
  }

  /** Drop every owned-soul inventory refcount and stop tracking. */
  stopTrackingOwnedSoulInventories(): void {
    this.unsubOwnedSoulCards?.();
    this.unsubOwnedSoulCards = null;
    for (const release of this.ownedSoulInventoryReleases.values()) release();
    this.ownedSoulInventoryReleases.clear();
  }

  private isOwnedSoul(card: LocalCard, playerId: number): boolean {
    return card.ownerId === playerId && (card.flagsState & FLAG_OWNED_BY_PLAYER) !== 0;
  }

  private holdInventory(soulCardId: number): void {
    if (this.ownedSoulInventoryReleases.has(soulCardId)) return;
    this.ownedSoulInventoryReleases.set(soulCardId, this.zones.ensureInventory(soulCardId));
  }

  private releaseInventory(soulCardId: number): void {
    const release = this.ownedSoulInventoryReleases.get(soulCardId);
    if (!release) return;
    this.ownedSoulInventoryReleases.delete(soulCardId);
    release();
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
