import type { LayoutNode } from "./LayoutNode";
import type { ZoneId } from "../../server/data/packing";

export type SurfaceListener = (zoneId: ZoneId, surface: LayoutNode) => void;

/**
 * Scene-scoped registry of layout surfaces (parents) keyed by `ZoneId`.
 *
 * `LayoutInventory` / `LayoutWorld` register themselves on construction;
 * `LayoutCard` queries `surfaceFor(zoneId)` to self-attach to the right host.
 *
 * Surfaces don't position cards (LayoutCards self-position from game state) —
 * LayoutManager is just the "who hosts cards for this zone" lookup.
 */
export class LayoutManager {
  /**
   * Top-most surface used for in-flight UI (drag previews, tooltips, drop
   * indicators). Card visuals re-parent here while dragging — a card is
   * pulled out of its zone surface so it can roam freely above the rest of
   * the scene. GameScene wires this from `GameLayout.overlay` on enter.
   */
  overlay: LayoutNode | null = null;

  /**
   * Multiple surfaces can host a zone's cards at once — one per viewing panel.
   * Two `LayoutWorld`s showing the same region both register their
   * `worldCardSurface` here; a card row then renders a `CardView` per surface.
   * Single-panel is just a set of size one.
   */
  private readonly surfaces = new Map<ZoneId, Set<LayoutNode>>();
  private readonly registerListeners = new Set<SurfaceListener>();
  private readonly unregisterListeners = new Set<SurfaceListener>();

  /** First surface registered for `zoneId`, or `null`. Temporary shim for
   *  callers that still assume a single surface (the single-panel case);
   *  multi-view consumers use `surfacesFor`. */
  surfaceFor(zoneId: ZoneId): LayoutNode | null {
    const set = this.surfaces.get(zoneId);
    if (!set) return null;
    for (const s of set) return s; // first (insertion order)
    return null;
  }

  /** Every surface registered for `zoneId` — one per viewing panel. */
  surfacesFor(zoneId: ZoneId): LayoutNode[] {
    const set = this.surfaces.get(zoneId);
    return set ? [...set] : [];
  }

  register(zoneId: ZoneId, surface: LayoutNode): void {
    let set = this.surfaces.get(zoneId);
    if (!set) {
      set = new Set();
      this.surfaces.set(zoneId, set);
    }
    if (set.has(surface)) return; // already registered for this view
    set.add(surface);
    for (const listener of this.registerListeners) {
      try {
        listener(zoneId, surface);
      } catch (err) {
        console.error("[LayoutManager] register listener threw", err);
      }
    }
  }

  unregister(zoneId: ZoneId, surface: LayoutNode): void {
    const set = this.surfaces.get(zoneId);
    if (!set || !set.delete(surface)) return;
    if (set.size === 0) this.surfaces.delete(zoneId);
    for (const listener of this.unregisterListeners) {
      try {
        listener(zoneId, surface);
      } catch (err) {
        console.error("[LayoutManager] unregister listener threw", err);
      }
    }
  }

  /**
   * Listener fires whenever a surface registers. Useful for LayoutCards that
   * tried to attach before their surface existed — they wait for it to land.
   * Returns an unsubscribe fn.
   */
  onRegister(listener: SurfaceListener): () => void {
    this.registerListeners.add(listener);
    return () => {
      this.registerListeners.delete(listener);
    };
  }

  /** Symmetric to `onRegister`: fires when a surface unregisters for a zone
   *  (e.g. the zone left a panel's active rect, or the panel closed). The card
   *  layer uses this to drop that view's `CardView` for the zone's cards. */
  onUnregister(listener: SurfaceListener): () => void {
    this.unregisterListeners.add(listener);
    return () => {
      this.unregisterListeners.delete(listener);
    };
  }

  dispose(): void {
    this.surfaces.clear();
    this.registerListeners.clear();
    this.unregisterListeners.clear();
    this.overlay = null;
  }
}
