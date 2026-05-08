import { type ZoneId } from "../../server/data/packing";
// import { packMacroZone, WORLD_LAYER, zonesAroundAnchor } from "../world/worldCoords";

export type ZoneTier = "active" | "hot" | "cold";

export type ZoneListener = (zoneId: ZoneId) => void;

export type AnchorName = string;
export interface WorldAnchor { readonly q: number; readonly r: number; }
export type AnchorListener = (name: AnchorName, q: number, r: number) => void;

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

  private prevWorldZones = new Set<ZoneId>();

  constructor() {
    this.anchors.set("viewport", { q: 0, r: 0 });
    // this.recomputeWorldZones();
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
   * Set or update a named anchor point in world q/r space. No-ops if the
   * values are unchanged. Common names: `"viewport"`, `"player"`.
   *
   * LayoutWorld subscribes to `"viewport"` to know where to center its hex
   * grid. Other anchors keep their surrounding zones warm even when off-screen.
   */
  /* 
  setAnchor(name: AnchorName, q: number, r: number): void {
    const prev = this.anchors.get(name);
    if (prev?.q === q && prev.r === r) return;
    this.anchors.set(name, { q, r });
    for (const l of this.anchorListeners) l(name, q, r);
    this.recomputeWorldZones();
  }*/

  getAnchor(name: AnchorName): WorldAnchor | undefined {
    return this.anchors.get(name);
  }

  /** The `"viewport"` anchor, defaulting to origin if not yet set. */
  get viewportAnchor(): WorldAnchor {
    return this.anchors.get("viewport") ?? { q: 0, r: 0 };
  }

  /**
   * Subscribe to anchor changes. Fires immediately for every anchor already
   * set, then on every subsequent change. Returns an unsubscribe function.
   */
  onAnchorChange(listener: AnchorListener): () => void {
    this.anchorListeners.add(listener);
    for (const [name, { q, r }] of this.anchors) listener(name, q, r);
    return () => { this.anchorListeners.delete(listener); };
  }

  /*
  private recomputeWorldZones(): void {
    const next = new Set<ZoneId>();
    for (const { q, r } of this.anchors.values()) {
      for (const { zoneQ, zoneR } of zonesAroundAnchor(q, r, this.anchorRadius)) {
        next.add(packZoneId(packMacroZone(zoneQ, zoneR), WORLD_LAYER));
      }
    }
    for (const zoneId of this.prevWorldZones) {
      if (!next.has(zoneId)) this.set(zoneId, null);
    }
    for (const zoneId of next) {
      if (!this.prevWorldZones.has(zoneId)) this.set(zoneId, "active");
    }
    this.prevWorldZones = next;
  }
  */

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
