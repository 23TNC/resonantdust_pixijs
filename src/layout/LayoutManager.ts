import type { LayoutNode } from "./LayoutNode";
import type { ZoneId } from "../zones/zoneId";

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

  private readonly surfaces = new Map<ZoneId, LayoutNode>();
  private readonly registerListeners = new Set<SurfaceListener>();

  /** Returns the surface for `zoneId`, or `null` if none registered yet. */
  surfaceFor(zoneId: ZoneId): LayoutNode | null {
    return this.surfaces.get(zoneId) ?? null;
  }

  register(zoneId: ZoneId, surface: LayoutNode): void {
    if (this.surfaces.has(zoneId)) {
      console.warn(
        `[LayoutManager] surface for zone ${zoneId} already registered; overwriting`,
      );
    }
    this.surfaces.set(zoneId, surface);
    for (const listener of this.registerListeners) {
      try {
        listener(zoneId, surface);
      } catch (err) {
        console.error("[LayoutManager] register listener threw", err);
      }
    }
  }

  unregister(zoneId: ZoneId): void {
    this.surfaces.delete(zoneId);
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

  dispose(): void {
    this.surfaces.clear();
    this.registerListeners.clear();
    this.overlay = null;
  }
}
