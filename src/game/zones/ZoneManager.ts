import { type ZoneId, INVENTORY_LAYER, makeMacroZone, PLAYER_INVENTORY_LAYER } from "../../server/data/packing";
import { chunksAroundAnchor, WORLD_LAYER } from "../world/worldCoords";

/**
 * Subscription/render tier for a tracked zone, in a demotion-only distance
 * waterfall around the viewport anchors:
 *
 * - `active` — within `activeDistance`. Full subscription (zones+cards+souls for
 *   world, cards for inventory) AND render-registered. The only tier subscribed
 *   *proactively*; the active ring extends ahead of travel for load lead time.
 * - `hot` — the trailing wake: only entered by demotion from `active` (never a
 *   leading band). Same full subscription, held across active↔hot so panning
 *   back doesn't re-snapshot, but NOT render-registered. Drops to `cold` once it
 *   falls past `hotDistance`.
 * - `cold` — entered by demotion from `hot`. Subscribes the `zones` table ONLY
 *   (tile skeleton — no card/soul streaming) for a cheap keepalive of explored
 *   ground. **Terminal: never demoted out** (no `cold→null`); only promoted
 *   `cold→active` by re-entering the active ring. (A future `coldDistance` / LRU
 *   will bound it; today it accumulates.)
 *
 * Promotion is asymmetric — a zone only rises by re-entering the `active` ring;
 * re-entering the hot radius alone does not re-promote. That prevents boundary
 * flapping.
 */
export type ZoneTier = "active" | "hot" | "cold";

export type ZoneListener = (zoneId: ZoneId) => void;

/** The set of SpacetimeDB queries a tier subscribes. `active`+`hot` share
 *  `full` (so active↔hot never re-subscribes); `cold` is the lighter
 *  `skeleton` (zones table only); `none` holds no subscription. */
export type QueryClass = "full" | "skeleton" | "none";

export type SubscriptionChangeListener = (
  zoneId: ZoneId,
  queryClass: QueryClass,
) => void;

export type AnchorName = string;
/** Named viewport anchor. Carries the surface it's pinned to so
 *  `recomputeAnchorZones` can pack zone_ids on the right layer (e.g.
 *  WORLD_LAYER for the overworld). `surface` is part of the anchor's
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

/** Map a tier to its subscription query class. `active`+`hot` → `full`,
 *  `cold` → `skeleton`, `null` → `none`. `set()` fires
 *  `onSubscriptionChange` only when this value changes, so active↔hot (both
 *  `full`) stays silent while hot→cold / cold→active re-subscribe. */
function subClassOf(tier: ZoneTier | null | undefined): QueryClass {
  if (tier === "active" || tier === "hot") return "full";
  if (tier === "cold") return "skeleton";
  return "none";
}

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

  // Subscription-class listeners. Fire only when a zone's query class changes
  // (full / skeleton / none) — so active↔hot (both `full`) stays silent while
  // hot→cold and cold→active re-subscribe. `main.ts` drives the actual
  // SpacetimeDB subscribe/unsubscribe off these; the per-tier `onAdded`/
  // `onRemoved` listeners drive render registration (which toggles on
  // active↔hot).
  private readonly subscriptionChangeListeners = new Set<SubscriptionChangeListener>();

  // Recency order of `hot` zones (Map preserves insertion order). A zone is
  // (re-)inserted at the back when it ENTERS hot (i.e. just left active on a
  // pan — the trailing edge most likely to be panned back into), so the
  // front is the least-recently-left zone, demoted to cold first when over
  // `maxHotZones`.
  private readonly hotLru = new Map<ZoneId, true>();

  // The churning wake = zones currently `active` or `hot`. Cold zones live in
  // `entries` but NOT here, so the demote pass in `recomputeAnchorZones` stays
  // O(active+hot) even as cold accumulates. A zone joins on promotion to
  // active and leaves when it demotes to cold.
  private readonly wake = new Set<ZoneId>();

  // ── World coordinate anchors ─────────────────────────────────────────────
  private readonly anchors = new Map<AnchorName, WorldAnchor>();
  private readonly anchorListeners = new Set<AnchorListener>();

  /** Active ring distance (Chebyshev, in chunks): zones within this many chunk
   *  rings of any anchor are `active` (full sub + rendered). Also the forward
   *  load-lead distance — the ring includes the next chunk before you reach it.
   *  Sizing rule: ≥ the render reach in chunks (≈1 at fullscreen; raise when
   *  zoomed out / on large panels, or for more lead at high pan speed).
   *  Mutable so callers can drive it from zoom / panel size. */
  activeDistance = 1;

  /** Hot wake depth (Chebyshev, in chunks): how far a demoted zone trails as a
   *  *full* subscription before downgrading to `cold` (skeleton). The bandwidth
   *  lever for expensive subs. Must be ≥ `activeDistance`. */
  hotDistance = 2;

  /** Hard ceiling on `hot` (full) subscriptions, as a multi-anchor safety
   *  valve. Per-anchor geometry already bounds the wake; this only binds when
   *  several anchors' wakes sum past it. Over-cap zones demote to `cold`
   *  (shedding cards/souls, keeping the skeleton) rather than dropping. Keep it
   *  above a single anchor's wake to avoid churn in the common case. Evicts
   *  least-recently-left first. */
  maxHotZones = 32;

  /** Whether the viewport this manager serves is a hex or rectangular grid.
   *  Informational forward hook (shear-aware selection / future rect surfaces);
   *  not branched on yet — selection is square chunk rings either way. */
  viewportGridType: "hex" | "rect" = "hex";

  /** Local player_id, set when login resolves. Read by client-local
   *  "who am I signed in as" lookups (e.g. `localPlayerFactionFolder`
   *  for drag previews). `null` pre-login. */
  private playerId: number | null = null;

  // Anchors are set by callers via `setAnchor(name, q, r, surface)`.
  // With the PanelManager rollout, each `GameViewPanel` owns a
  // namespaced `viewport:<panelId>` anchor — there is no singleton
  // `"viewport"` anchor anymore. Until any panel is open there are no
  // anchors and no zones get collected; player row + chat
  // subscriptions are the only baseline traffic.
  //
  // Surface plumbing: each anchor is tied to a surface (default
  // WORLD_LAYER). `recomputeAnchorZones` packs zone_ids using each
  // anchor's surface, so a viewport pinned to a non-world surface
  // activates zones on that layer.
  constructor() {}

  /** Set the local player_id (called from `PlayerManager`'s login
   *  listener). */
  setPlayerId(playerId: number | null): void {
    this.playerId = playerId;
  }

  /** Read the local player_id. Returns `null` pre-login. Used by
   *  client-local "who am I signed in as" lookups. */
  getPlayerId(): number | null {
    return this.playerId;
  }

  set(zoneId: ZoneId, tier: ZoneTier | null): void {
    const prev = this.entries.get(zoneId);
    if (prev === tier) return;

    const prevClass = subClassOf(prev);

    if (prev !== undefined) {
      this.entries.delete(zoneId);
      if (prev === "hot") this.hotLru.delete(zoneId);
      this.fireRemoved(prev, zoneId);
    }

    if (tier) {
      this.entries.set(zoneId, tier);
      if (tier === "hot") this.hotLru.set(zoneId, true); // MRU
      this.fireAdded(tier, zoneId);
    }

    const newClass = subClassOf(tier);
    if (prevClass !== newClass) this.fireSubscriptionChange(zoneId, newClass);
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
   * is computed here (`makeMacroZone(soulCardId, INVENTORY_LAYER, 0, 0).packed`) so
   * the surface-layer constant doesn't have to leak into every
   * consumer. Returns the same refcounted release fn shape as
   * `ensure`.
   */
  ensureInventory(soulCardId: number): () => void {
    return this.ensure(makeMacroZone(soulCardId, INVENTORY_LAYER, 0, 0).packed);
  }

  /**
   * Convenience wrapper around `ensure` for the player-wide
   * inventory zone (account-scoped, shared across all of the
   * player's souls). Mirror of `ensureInventory` but keyed on
   * `player_id` and `PLAYER_INVENTORY_LAYER (2)`. Returns the
   * same refcounted release fn.
   */
  ensurePlayerInventory(playerId: number): () => void {
    return this.ensure(makeMacroZone(playerId, PLAYER_INVENTORY_LAYER, 0, 0).packed);
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

  /** Every zone currently holding a live subscription, with its query class
   *  (`full` or `skeleton`). Used by `main.ts` for the initial catch-up before
   *  its `onSubscriptionChange` listener is registered. */
  *subscribedZones(): Generator<{ zoneId: ZoneId; queryClass: QueryClass }> {
    for (const [zoneId, t] of this.entries) {
      const queryClass = subClassOf(t);
      if (queryClass !== "none") yield { zoneId, queryClass };
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

  /** Fires when a zone's subscription query class changes (full / skeleton /
   *  none) — i.e. on null→sub, sub→null, and hot↔cold, but NOT on active↔hot
   *  (both `full`). The listener installs/swaps/drops the SpacetimeDB
   *  subscription accordingly. */
  onSubscriptionChange(listener: SubscriptionChangeListener): () => void {
    this.subscriptionChangeListeners.add(listener);
    return () => {
      this.subscriptionChangeListeners.delete(listener);
    };
  }

  // ── World coordinate anchor API ──────────────────────────────────────────

  /**
   * Set or update a named anchor point in (q, r) hex space on a
   * specific `surface`. No-ops if the values are unchanged. Common
   * names: `"viewport"`, `"player"`, `"viewport:<panelId>"`.
   *
   * `surface` defaults to `WORLD_LAYER` for backward compatibility
   * with the world-pan code. Non-world viewports pass their own
   * surface so `recomputeAnchorZones` packs zone ids on the right
   * layer.
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

  /** Demotion-only distance waterfall over square (Chebyshev) chunk rings,
   *  surface-keyed (each anchor packs zone_ids on its own layer):
   *
   *  1. Demote pass over the current wake (active ∪ hot) only — cold is
   *     terminal and skipped. A zone that left the active ring → `hot`; a hot
   *     zone that fell past `hotDistance` → `cold` (and leaves the wake).
   *  2. Promote pass — the active ring (within `activeDistance`) is the ONLY
   *     proactive subscribe, promoting from hot / cold / fresh.
   *  3. Multi-anchor LRU valve — excess full (hot) subs demote to `cold`.
   *
   *  Promotion happens only here via the active ring, so a cold/hot zone never
   *  rises by merely re-entering the hot radius — preventing boundary flapping. */
  private recomputeAnchorZones(): void {
    const activeSet = new Set<ZoneId>();
    const hotEligible = new Set<ZoneId>();
    for (const { q, r, surface } of this.anchors.values()) {
      for (const { zoneQ, zoneR } of chunksAroundAnchor(q, r, this.activeDistance)) {
        activeSet.add(makeMacroZone(0, surface, zoneQ, zoneR).packed);
      }
      for (const { zoneQ, zoneR } of chunksAroundAnchor(q, r, this.hotDistance)) {
        hotEligible.add(makeMacroZone(0, surface, zoneQ, zoneR).packed);
      }
    }

    // 1. Demote pass — wake (active ∪ hot) only. Safe to delete from `wake`
    //    mid-iteration (the current element is simply not revisited). A zone
    //    that left the active ring goes to `hot`, or straight to `cold` if it
    //    also jumped past `hotDistance` (a teleport) — so the wake never holds
    //    a stale full sub for an out-of-range chunk.
    for (const zoneId of this.wake) {
      if (activeSet.has(zoneId)) continue;
      if (hotEligible.has(zoneId)) {
        // Within the wake: a zone that just left the active ring becomes hot;
        // a zone already hot stays hot (set() no-ops on same tier).
        this.set(zoneId, "hot");
      } else {
        // Past the wake (normal trailing edge, or a teleport jump) → cold
        // skeleton (terminal).
        this.set(zoneId, "cold");
        this.wake.delete(zoneId);
      }
    }

    // 2. Promote pass — active ring is the only proactive subscribe.
    for (const zoneId of activeSet) {
      this.set(zoneId, "active"); // hot→active register-only; cold→active upgrades to full
      this.wake.add(zoneId);
    }

    // 3. Multi-anchor LRU valve — excess full subs shed cards/souls to cold.
    while (this.hotLru.size > this.maxHotZones) {
      const lru = this.hotLru.keys().next().value;
      if (lru === undefined) break;
      this.set(lru, "cold");
      this.wake.delete(lru);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  dispose(): void {
    this.entries.clear();
    this.refs.clear();
    this.hotLru.clear();
    this.wake.clear();
    for (const tier of TIERS) {
      this.addedListeners[tier].clear();
      this.removedListeners[tier].clear();
    }
    this.subscriptionChangeListeners.clear();
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

  private fireSubscriptionChange(zoneId: ZoneId, queryClass: QueryClass): void {
    for (const listener of this.subscriptionChangeListeners) {
      try {
        listener(zoneId, queryClass);
      } catch (err) {
        console.error(`[ZoneManager] subscriptionChange listener threw`, err);
      }
    }
  }
}
