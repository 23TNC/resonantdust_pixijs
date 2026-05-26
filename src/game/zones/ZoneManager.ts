import { INVENTORY_LAYER, packZoneId, PLAYER_INVENTORY_LAYER, type ZoneId } from "../../server/data/packing";
import { packMacroZone, WORLD_LAYER, zonesAroundAnchor } from "../world/worldCoords";

export type ZoneTier = "active" | "hot" | "cold";

export type ZoneListener = (zoneId: ZoneId) => void;

export type AnchorName = string;
/** Named viewport anchor. Carries the surface it's pinned to so
 *  `recomputeAnchorZones` can pack zone_ids on the right layer —
 *  WORLD_LAYER for the overworld, PLAYER_DIMENSION_LAYER for a
 *  player's pocket dim, etc. `surface` is part of the anchor's
 *  identity for zone-recompute purposes; changing it via
 *  `setAnchor(name, q, r, surface)` re-walks the surrounding ring
 *  on the new surface. */
export interface WorldAnchor {
  readonly q: number;
  readonly r: number;
  readonly surface: number;
}
export type AnchorListener = (
  name: AnchorName,
  q: number,
  r: number,
  surface: number,
) => void;

const TIERS: readonly ZoneTier[] = ["active", "hot", "cold"];

export class ZoneManager {
  private readonly entries = new Map<ZoneId, ZoneTier>();
  private readonly refs = new Map<ZoneId, number>();
  private readonly addedListeners: Record<ZoneTier, Set<ZoneListener>> = {
    active: new Set(),
    hot: new Set(),
    cold: new Set(),
  };
  private readonly removedListeners: Record<ZoneTier, Set<ZoneListener>> = {
    active: new Set(),
    hot: new Set(),
    cold: new Set(),
  };

  // ── World coordinate anchors ─────────────────────────────────────────────
  private readonly anchors = new Map<AnchorName, WorldAnchor>();
  private readonly anchorListeners = new Set<AnchorListener>();

  /** How many hex rings around each anchor to keep subscribed. */
  anchorRadius = 2;

  private prevAnchorZones = new Set<ZoneId>();

  /** Local player_id, set when login resolves. Read by the subscribe
   *  dispatch in `main.ts` to scope `PLAYER_DIMENSION_LAYER` zones to
   *  the local player's pocket dim (owner_id = player_id). `null`
   *  pre-login; consumers must defer player-dim subscriptions until
   *  this is populated. */
  private playerId: number | null = null;

  // Anchors are set by callers via `setAnchor(name, q, r, surface)`.
  // With the PanelManager rollout, each `GameViewPanel` owns a pair
  // of namespaced anchors (`viewport:<panelId>` / `soul:<panelId>`) —
  // there is no singleton `"viewport"` anchor anymore. Until any
  // panel is open there are no anchors and no zones get collected;
  // player row + chat subscriptions are the only baseline traffic.
  //
  // Surface plumbing: each anchor is tied to a surface (default
  // WORLD_LAYER). `recomputeAnchorZones` packs zone_ids using each
  // anchor's surface, so a viewport pinned to
  // `PLAYER_DIMENSION_LAYER` activates zones on that layer (which
  // the `main.ts` dispatch routes through `subscribePlayerDimension`
  // rather than `subscribeWorldZone`).
  constructor() {}

  /** Set the local player_id (called from `PlayerManager`'s login
   *  listener). Triggers a recompute so any pre-login player-dim
   *  anchors get their subscriptions activated. */
  setPlayerId(playerId: number | null): void {
    if (this.playerId === playerId) return;
    this.playerId = playerId;
    // No recompute needed — the zone IDs in `entries` don't change
    // when the player_id changes; the dispatcher in `main.ts`
    // reads `getPlayerId()` lazily when it fires `subscribeZone`.
    // Consumers that need a player-dim subscription installed
    // immediately after login should call `setAnchor(... surface =
    // PLAYER_DIMENSION_LAYER)` to seed the active set.
  }

  /** Read the local player_id. Returns `null` pre-login. Used by the
   *  `main.ts` zone-subscribe dispatcher to scope
   *  `PLAYER_DIMENSION_LAYER` subscriptions. */
  getPlayerId(): number | null {
    return this.playerId;
  }

  set(zoneId: ZoneId, tier: ZoneTier | null): void {
    const prev = this.entries.get(zoneId);
    if (prev === tier) return;

    if (prev !== undefined) {
      this.entries.delete(zoneId);
      this.fireRemoved(prev, zoneId);
    }

    if (tier) {
      this.entries.set(zoneId, tier);
      this.fireAdded(tier, zoneId);
    }
  }

  remove(zoneId: ZoneId): void {
    this.set(zoneId, null);
  }

  /**
   * Refcounted "I need this zone tracked" — first ensure promotes to `active`,
   * subsequent calls just bump the count. Returns a release fn; last release
   * demotes the zone to `null` (eviction policy on tier transitions is TBD).
   */
  ensure(zoneId: ZoneId): () => void {
    const prev = this.refs.get(zoneId) ?? 0;
    this.refs.set(zoneId, prev + 1);
    if (prev === 0) {
      this.set(zoneId, "active");
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(zoneId);
    };
  }

  /**
   * Convenience wrapper around `ensure` for the per-soul inventory
   * zone. Callers pass the soul's `card_id`; the inventory zone id
   * is computed here (`packZoneId(soulCardId, INVENTORY_LAYER)`) so
   * the surface-layer constant doesn't have to leak into every
   * consumer. Returns the same refcounted release fn shape as
   * `ensure`.
   */
  ensureInventory(soulCardId: number): () => void {
    return this.ensure(packZoneId(soulCardId, INVENTORY_LAYER));
  }

  /**
   * Convenience wrapper around `ensure` for the player-wide
   * inventory zone (account-scoped, shared across all of the
   * player's souls). Mirror of `ensureInventory` but keyed on
   * `player_id` and `PLAYER_INVENTORY_LAYER (2)`. Returns the
   * same refcounted release fn.
   */
  ensurePlayerInventory(playerId: number): () => void {
    return this.ensure(packZoneId(playerId, PLAYER_INVENTORY_LAYER));
  }

  private release(zoneId: ZoneId): void {
    const prev = this.refs.get(zoneId) ?? 0;
    if (prev <= 1) {
      this.refs.delete(zoneId);
      this.set(zoneId, null);
    } else {
      this.refs.set(zoneId, prev - 1);
    }
  }

  tierOf(zoneId: ZoneId): ZoneTier | null {
    return this.entries.get(zoneId) ?? null;
  }

  has(zoneId: ZoneId): boolean {
    return this.entries.has(zoneId);
  }

  *zonesIn(tier: ZoneTier): Generator<ZoneId> {
    for (const [zoneId, t] of this.entries) {
      if (t === tier) yield zoneId;
    }
  }

  onAdded(tier: ZoneTier, listener: ZoneListener): () => void {
    this.addedListeners[tier].add(listener);
    return () => {
      this.addedListeners[tier].delete(listener);
    };
  }

  onRemoved(tier: ZoneTier, listener: ZoneListener): () => void {
    this.removedListeners[tier].add(listener);
    return () => {
      this.removedListeners[tier].delete(listener);
    };
  }

  // ── World coordinate anchor API ──────────────────────────────────────────

  /**
   * Set or update a named anchor point in (q, r) hex space on a
   * specific `surface`. No-ops if the values are unchanged. Common
   * names: `"viewport"`, `"player"`, `"viewport:<panelId>"`.
   *
   * `surface` defaults to `WORLD_LAYER` for backward compatibility
   * with the world-pan code. Player-dim viewports pass
   * `PLAYER_DIMENSION_LAYER` so `recomputeAnchorZones` packs zone
   * ids on the right layer and the `main.ts` dispatch routes them
   * through `subscribePlayerDimension`.
   *
   * LayoutWorld subscribes to `"viewport:<panelId>"` to know where
   * to center its hex grid. Other anchors keep their surrounding
   * zones warm even when off-screen.
   */
  setAnchor(name: AnchorName, q: number, r: number, surface: number = WORLD_LAYER): void {
    const prev = this.anchors.get(name);
    if (prev?.q === q && prev.r === r && prev.surface === surface) return;
    this.anchors.set(name, { q, r, surface });
    for (const l of this.anchorListeners) l(name, q, r, surface);
    this.recomputeAnchorZones();
  }

  /** Drop a named anchor entirely. The anchor's contribution to the
   *  active zone ring is removed in the next
   *  `recomputeAnchorZones` pass — zones that were only kept alive
   *  by this anchor demote and unsubscribe. */
  clearAnchor(name: AnchorName): void {
    if (!this.anchors.has(name)) return;
    this.anchors.delete(name);
    this.recomputeAnchorZones();
  }

  getAnchor(name: AnchorName): WorldAnchor | undefined {
    return this.anchors.get(name);
  }

  /**
   * Subscribe to anchor changes. Fires immediately for every anchor already
   * set, then on every subsequent change. Returns an unsubscribe function.
   */
  onAnchorChange(listener: AnchorListener): () => void {
    this.anchorListeners.add(listener);
    for (const [name, { q, r, surface }] of this.anchors) listener(name, q, r, surface);
    return () => { this.anchorListeners.delete(listener); };
  }

  /** Walk every anchor, pack a zone_id per `(zoneQ, zoneR)` in the
   *  anchor's `anchorRadius` ring on the anchor's surface, diff
   *  against the previous set, promote/demote zones accordingly.
   *  Same shape as the old world-only version; now surface-keyed. */
  private recomputeAnchorZones(): void {
    const next = new Set<ZoneId>();
    for (const { q, r, surface } of this.anchors.values()) {
      for (const { zoneQ, zoneR } of zonesAroundAnchor(q, r, this.anchorRadius)) {
        next.add(packZoneId(packMacroZone(zoneQ, zoneR), surface));
      }
    }
    for (const zoneId of this.prevAnchorZones) {
      if (!next.has(zoneId)) this.set(zoneId, null);
    }
    for (const zoneId of next) {
      if (!this.prevAnchorZones.has(zoneId)) this.set(zoneId, "active");
    }
    this.prevAnchorZones = next;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  dispose(): void {
    this.entries.clear();
    this.refs.clear();
    for (const tier of TIERS) {
      this.addedListeners[tier].clear();
      this.removedListeners[tier].clear();
    }
    this.anchors.clear();
    this.anchorListeners.clear();
  }

  private fireAdded(tier: ZoneTier, zoneId: ZoneId): void {
    for (const listener of this.addedListeners[tier]) {
      try {
        listener(zoneId);
      } catch (err) {
        console.error(`[ZoneManager] ${tier} added listener threw`, err);
      }
    }
  }

  private fireRemoved(tier: ZoneTier, zoneId: ZoneId): void {
    for (const listener of this.removedListeners[tier]) {
      try {
        listener(zoneId);
      } catch (err) {
        console.error(`[ZoneManager] ${tier} removed listener threw`, err);
      }
    }
  }
}
