import { type ZoneId, INVENTORY_LAYER, makeMacroZone, PLAYER_INVENTORY_LAYER, regionOfZone } from "../../server/data/packing";
import { chunksAroundAnchor, WORLD_LAYER } from "../viewport/worldCoords";

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

/** Fires when a region needs subscribing (`true`) or releasing (`false`) — a
 *  region is subscribed while any world zone inside it is wanted. `main.ts`
 *  maps this to `subscribeRegion` / `unsubscribeRegion`. */
export type RegionSubscriptionListener = (
  macroRegion: bigint,
  subscribed: boolean,
) => void;

/** Fires when a wanted world zone is present-but-not-yet-available and needs the
 *  server to spawn it. `main.ts` maps this to `reducers.requestZone`. */
export type ZoneRequestListener = (zoneId: ZoneId) => void;

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
  /** Zone owner band the anchor's chunks belong to — `0` for the world
   *  (default), a soul/anchor `card_id` for an inventory / mini-zone bucket.
   *  `recomputeAnchorZones` packs this into the subscribed zone ids so a
   *  non-world viewport subscribes ITS owner's chunks, not owner 0's. */
  readonly owner: number;
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
  private readonly regionSubscriptionListeners = new Set<RegionSubscriptionListener>();
  private readonly zoneRequestListeners = new Set<ZoneRequestListener>();
  /** `main.ts` maps these to `reducers.ensureRegion` — fired when a gated zone
   *  is wanted but no `Region` governs it yet (the server declares one with
   *  surface-keyed presence, self-healing). */
  private readonly ensureRegionListeners = new Set<ZoneRequestListener>();

  // ── Region gate ──────────────────────────────────────────────────────────
  // Gated zones (world + soul inventory) only exist where a `Region` permits
  // them; the waterfall decides what we *want*, and the gate decides what we
  // actually subscribe based on the region's presence/availability bits.
  // Non-gated surfaces (player inventory / mini_zone / pocket) are
  // server-provisioned and bypass the gate entirely. See `isGated`.

  /** Latest presence/availability bitfields per subscribed `macro_region`,
   *  fed by `noteRegion` from the client's region table mirror. */
  private readonly regionBits = new Map<bigint, { presence: bigint; available: bigint }>();
  /** Wanted world zones grouped by their `macro_region`. Drives region
   *  subscription (a region is subscribed while its set is non-empty) and tells
   *  `noteRegion` which zones to re-evaluate when a region's bits change. */
  private readonly regionWanted = new Map<bigint, Set<ZoneId>>();
  /** World zones we've already fired `request_zone` for, so a present-but-
   *  unavailable zone isn't re-requested on every region update. Cleared when
   *  the zone stops being wanted. */
  private readonly requested = new Set<ZoneId>();
  /** Regions we've already fired `ensure_region` for (keyed by `macro_region`),
   *  so a gated zone with no governing region asks the server to declare one
   *  only once. Cleared when the region's wanted set empties. */
  private readonly ensuredRegions = new Set<bigint>();
  /** Zones whose row currently lives in `data.zones.current` — fed by
   *  `noteZoneArrived` / `noteZoneDeparted` from `main.ts`. Used as the
   *  authoritative "did the row land" signal in `effectiveClassFor`, so a
   *  region whose `zone_available` bit got out of sync with the actual
   *  Zones table (e.g. zones wiped while the region row persisted) still
   *  triggers a fresh `request_zone` on next viewport open. */
  private readonly arrivedZones = new Set<ZoneId>();
  /** The query class last emitted to the SDK per zone (the *gated* result, vs
   *  the *desired* class derived from the tier). Absent = `none`. */
  private readonly emitted = new Map<ZoneId, QueryClass>();

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
    if (prevClass !== newClass) this.onDesireChanged(zoneId, prevClass, newClass);
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

  /** Every zone whose (gated) subscription is currently live, with its query
   *  class. Reflects the region gate's *emitted* decisions, not raw desire —
   *  used by `main.ts` for the initial catch-up. (Empty at boot, before any
   *  anchor is set.) */
  *subscribedZones(): Generator<{ zoneId: ZoneId; queryClass: QueryClass }> {
    for (const [zoneId, queryClass] of this.emitted) {
      yield { zoneId, queryClass };
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

  /** Fires when a zone's *effective* (region-gated) subscription class changes
   *  (full / skeleton / none). The listener installs/swaps/drops the
   *  SpacetimeDB subscription accordingly. */
  onSubscriptionChange(listener: SubscriptionChangeListener): () => void {
    this.subscriptionChangeListeners.add(listener);
    return () => {
      this.subscriptionChangeListeners.delete(listener);
    };
  }

  /** Fires when a region must be subscribed (`true`) / released (`false`). */
  onRegionSubscriptionChange(listener: RegionSubscriptionListener): () => void {
    this.regionSubscriptionListeners.add(listener);
    return () => {
      this.regionSubscriptionListeners.delete(listener);
    };
  }

  /** Fires when a wanted world zone needs the server to spawn it. */
  onZoneRequest(listener: ZoneRequestListener): () => void {
    this.zoneRequestListeners.add(listener);
    return () => {
      this.zoneRequestListeners.delete(listener);
    };
  }

  /** Fires when a gated zone is wanted but no `Region` governs it — the server
   *  should declare one (`ensure_region`). `main.ts` maps this to
   *  `reducers.ensureRegion`. */
  onEnsureRegion(listener: ZoneRequestListener): () => void {
    this.ensureRegionListeners.add(listener);
    return () => {
      this.ensureRegionListeners.delete(listener);
    };
  }

  /** Feed the latest presence/availability bits for a subscribed region (from
   *  the client's region mirror). Re-evaluates every wanted zone in that
   *  region — promoting newly-present/available zones into a live subscription
   *  and firing `request_zone` for present-but-unavailable ones. */
  noteRegion(macroRegion: bigint, presence: bigint, available: bigint): void {
    this.regionBits.set(macroRegion, { presence, available });
    const set = this.regionWanted.get(macroRegion);
    if (!set) return;
    for (const zoneId of [...set]) this.reconcileSubscription(zoneId);
  }

  /** Forget a region's bits (its row was removed). Wanted zones in it fall back
   *  to ungated `none` until/unless the region reappears. */
  noteRegionRemoved(macroRegion: bigint): void {
    if (!this.regionBits.delete(macroRegion)) return;
    const set = this.regionWanted.get(macroRegion);
    if (!set) return;
    for (const zoneId of [...set]) this.reconcileSubscription(zoneId);
  }

  /** Mark `zoneId`'s row as present in `data.zones.current`. Clears any
   *  pending `requested` flag for it — the request has been fulfilled
   *  (or the row was already there). Wired by `main.ts` from the
   *  `data.zones` subscription so the row's arrival is the authoritative
   *  signal in `effectiveClassFor` (alongside the region's `available`
   *  bit). */
  noteZoneArrived(zoneId: ZoneId): void {
    this.arrivedZones.add(zoneId);
    this.requested.delete(zoneId);
  }

  /** Mark `zoneId`'s row as gone from `data.zones.current`. Also clears
   *  `requested` so that if the zone is still wanted, `effectiveClassFor`
   *  re-requests it on the next reconcile. */
  noteZoneDeparted(zoneId: ZoneId): void {
    this.arrivedZones.delete(zoneId);
    this.requested.delete(zoneId);
  }

  // ── Region gate internals ────────────────────────────────────────────────

  /** True iff `zoneId`'s surface is region-gated: the world layer or a soul's
   *  inventory layer (souls get an inventory `Region` on spawn). Other
   *  surfaces (player inventory, mini-zone, pocket) are server-provisioned and
   *  bypass the gate, subscribing directly. */
  private isGated(zoneId: ZoneId): boolean {
    const surface = Number((zoneId >> 24n) & 0xffn);
    return surface === WORLD_LAYER || surface === INVENTORY_LAYER;
  }

  /** Called from `set()` when a zone's desired query class crosses a boundary.
   *  Maintains per-region "wanted" ref-counts (world only) and reconciles the
   *  zone's actual subscription through the gate. */
  private onDesireChanged(zoneId: ZoneId, prevDesire: QueryClass, newDesire: QueryClass): void {
    if (this.isGated(zoneId)) {
      if (prevDesire === "none" && newDesire !== "none") this.addWanted(zoneId);
      else if (prevDesire !== "none" && newDesire === "none") this.removeWanted(zoneId);
    }
    this.reconcileSubscription(zoneId);
  }

  private addWanted(zoneId: ZoneId): void {
    const { macroRegion } = regionOfZone(zoneId);
    let set = this.regionWanted.get(macroRegion);
    if (!set) {
      set = new Set();
      this.regionWanted.set(macroRegion, set);
    }
    const fresh = set.size === 0;
    set.add(zoneId);
    if (fresh) this.fireRegionSubscription(macroRegion, true);
  }

  private removeWanted(zoneId: ZoneId): void {
    const { macroRegion } = regionOfZone(zoneId);
    const set = this.regionWanted.get(macroRegion);
    this.requested.delete(zoneId);
    if (!set) return;
    set.delete(zoneId);
    if (set.size === 0) {
      this.regionWanted.delete(macroRegion);
      this.regionBits.delete(macroRegion);
      this.ensuredRegions.delete(macroRegion);
      this.fireRegionSubscription(macroRegion, false);
    }
  }

  /** Recompute a zone's gated subscription class and emit a change only when it
   *  differs from what's currently live. */
  private reconcileSubscription(zoneId: ZoneId): void {
    const effective = this.effectiveClassFor(zoneId);
    const prev = this.emitted.get(zoneId) ?? "none";
    if (effective === prev) return;
    if (effective === "none") this.emitted.delete(zoneId);
    else this.emitted.set(zoneId, effective);
    this.fireSubscriptionChange(zoneId, effective);
  }

  /** The query class a zone should actually subscribe at, after region gating.
   *  Non-gated zones bypass (return their desire). Gated zones return `none`
   *  until their region is known and marks the zone present; a present-but-
   *  unavailable zone fires `request_zone` once and subscribes optimistically. */
  private effectiveClassFor(zoneId: ZoneId): QueryClass {
    const desire = subClassOf(this.entries.get(zoneId));
    if (desire === "none") return "none";
    if (!this.isGated(zoneId)) return desire;

    // A gated zone needs a governing `Region` before `request_zone` can spawn
    // it (the reducer no-ops without one). If no region is in our mirror yet,
    // ask the server to declare one — `ensure_region` writes surface-keyed
    // presence, the row arrives via the region subscription → `noteRegion`
    // re-enters here with the region known, and we then request the zone. We
    // still subscribe optimistically (0 rows until it spawns). This replaces
    // the prior unconditional `request_zone`, which silently no-op'd whenever a
    // region was absent (e.g. a soul's inventory region was never seeded).
    const { macroRegion } = regionOfZone(zoneId);
    if (!this.regionBits.has(macroRegion)) {
      if (!this.ensuredRegions.has(macroRegion)) {
        this.ensuredRegions.add(macroRegion);
        this.fireEnsureRegion(zoneId);
      }
      return desire;
    }

    // Region is known — request the zone's materialization once. The
    // `arrivedZones` check keeps this self-healing if the Zones table and
    // region bits ever drift (zones wiped while the region row persisted).
    if (!this.arrivedZones.has(zoneId) && !this.requested.has(zoneId)) {
      this.requested.add(zoneId);
      this.fireZoneRequest(zoneId);
    }
    return desire;
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
  setAnchor(
    name: AnchorName,
    q: number,
    r: number,
    surface: number = WORLD_LAYER,
    owner: number = 0,
  ): void {
    const prev = this.anchors.get(name);
    if (prev?.q === q && prev.r === r && prev.surface === surface && prev.owner === owner) return;
    this.anchors.set(name, { q, r, surface, owner });
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
    for (const { q, r, surface, owner } of this.anchors.values()) {
      for (const { zoneQ, zoneR } of chunksAroundAnchor(q, r, this.activeDistance)) {
        activeSet.add(makeMacroZone(owner, surface, zoneQ, zoneR).packed);
      }
      for (const { zoneQ, zoneR } of chunksAroundAnchor(q, r, this.hotDistance)) {
        hotEligible.add(makeMacroZone(owner, surface, zoneQ, zoneR).packed);
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
    this.regionSubscriptionListeners.clear();
    this.zoneRequestListeners.clear();
    this.ensureRegionListeners.clear();
    this.regionBits.clear();
    this.regionWanted.clear();
    this.requested.clear();
    this.ensuredRegions.clear();
    this.arrivedZones.clear();
    this.emitted.clear();
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

  private fireRegionSubscription(macroRegion: bigint, subscribed: boolean): void {
    for (const listener of this.regionSubscriptionListeners) {
      try {
        listener(macroRegion, subscribed);
      } catch (err) {
        console.error(`[ZoneManager] regionSubscription listener threw`, err);
      }
    }
  }

  private fireZoneRequest(zoneId: ZoneId): void {
    for (const listener of this.zoneRequestListeners) {
      try {
        listener(zoneId);
      } catch (err) {
        console.error(`[ZoneManager] zoneRequest listener threw`, err);
      }
    }
  }

  private fireEnsureRegion(zoneId: ZoneId): void {
    for (const listener of this.ensureRegionListeners) {
      try {
        listener(zoneId);
      } catch (err) {
        console.error(`[ZoneManager] ensureRegion listener threw`, err);
      }
    }
  }
}
