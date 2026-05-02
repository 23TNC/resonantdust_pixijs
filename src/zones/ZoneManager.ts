import type { ZoneId } from "./zoneId";

export type { ZoneId } from "./zoneId";
export { packZoneId, unpackZoneId } from "./zoneId";

export type ZoneTier = "active" | "hot" | "cold";

export type ZoneListener = (zoneId: ZoneId) => void;

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

  dispose(): void {
    this.entries.clear();
    this.refs.clear();
    for (const tier of TIERS) {
      this.addedListeners[tier].clear();
      this.removedListeners[tier].clear();
    }
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
