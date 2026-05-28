import type { LayoutNode } from "../../game/layout/LayoutNode";

/**
 * Minimal interface PanelManager requires of its tracked panels.
 * `DomPanel` (and therefore `PixiPanel`) satisfies it directly;
 * higher-level wrapper classes (e.g. `InventoryPanel`) can
 * implement it by delegating to an inner `PixiPanel`.
 */
export interface ManagedPanel {
  focus(): void;
  destroy(): void;
  onFocus(cb: () => void): () => void;
  onDestroy(cb: () => void): () => void;
}

/**
 * Central registry for the app's open panels.
 *
 * Keys are strings; convention is `"<type>:<entityId>"` for per-entity
 * panels (e.g. `"inventory:42"`, `"gameview:1"`) and just `"<type>"`
 * for singletons (e.g. `"details"`, `"blueprints"`).
 *
 * Callers use `ensure(id, factory)` to get-or-create — if the id is
 * already in the registry, the existing panel is focused and
 * returned; otherwise the factory runs and the new panel is
 * registered. Panels self-unregister when they `destroy()` (the
 * manager subscribes to their `onDestroy` event during `ensure`).
 *
 * `focused(prefix)` returns the most-recently-focused panel whose
 * id begins with `${prefix}:` (or equals `prefix` for singletons).
 * Used by global key handlers to route input — e.g. KeyE goes to
 * `panels.focused("inventory")`, Space to `panels.focused("gameview")`.
 *
 * Cascade-offset state lives here so new free-floating panels open
 * staggered rather than stacking exactly on top of each other.
 * Anchored panels (those that set `right` / `left` / pin to an edge)
 * ignore the offset — they're already pinned to a corner and
 * stacking is unavoidable.
 */
export class PanelManager {
  private readonly panels = new Map<string, ManagedPanel>();
  /** Last-focused panel id, keyed by id prefix (`"inventory"`,
   *  `"gameview"`, etc.) and also by exact id for singletons. */
  private readonly focusedByKey = new Map<string, string>();
  /** Interior LayoutNode → owning panel map. Wrapper panels
   *  (`InventoryPanel`, `GameViewPanel`, etc.) register the
   *  LayoutNode that hosts their interior content (the
   *  `LayoutInventory`, the `LayoutWorld`, etc.) so a Pixi-side
   *  hit-test can be resolved back to "which panel owns this
   *  hit?" via `findPanelByDescendant`. Used by `MainScene`'s
   *  input handlers to auto-focus the panel a body click /
   *  drag-start lands inside. */
  private readonly nodeToPanel = new Map<LayoutNode, ManagedPanel>();
  private cascadeIndex = 0;

  /** Get the existing panel for `id`, or create one via `factory`
   *  and register it. If the panel already exists, it is focused
   *  before being returned. The factory's return value is hooked
   *  into the manager's bookkeeping (`onFocus` updates the last-
   *  focused cache; `onDestroy` removes the entry). */
  ensure<P extends ManagedPanel>(id: string, factory: () => P): P {
    const existing = this.panels.get(id);
    if (existing) {
      existing.focus();
      return existing as P;
    }
    const panel = factory();
    this.panels.set(id, panel);
    panel.onFocus(() => this.handleFocus(id));
    panel.onDestroy(() => this.handleDestroy(id));
    // Open + focus the fresh panel. `focus()` on a closed DomPanel
    // first calls `open()` (which mounts the DOM node and fires
    // openChange listeners), then `bringToFront()` (which fires
    // `onFocus` — picked up by PixiPanel to lift its Pixi nodes to
    // the top of their layer, and by PanelManager itself to cache
    // last-focused-by-prefix). Without this call a freshly-created
    // panel sits in the registry with `isOpen = false` and never
    // renders.
    panel.focus();
    return panel;
  }

  get(id: string): ManagedPanel | null {
    return this.panels.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.panels.has(id);
  }

  /** Destroy and unregister the panel for `id`. No-op if absent.
   *  `handleDestroy` clears the map entry via the `onDestroy`
   *  listener installed in `ensure`. */
  close(id: string): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    panel.destroy();
  }

  /** Destroy every registered panel. Scene-teardown hook. */
  closeAll(): void {
    const snapshot = [...this.panels.values()];
    for (const panel of snapshot) panel.destroy();
    // Belt-and-suspenders — onDestroy listeners should have emptied
    // the map already.
    this.panels.clear();
    this.focusedByKey.clear();
  }

  *panelIds(): IterableIterator<string> {
    yield* this.panels.keys();
  }

  /** Returns the most-recently-focused panel whose id starts with
   *  `${prefix}:`, or equals `prefix` exactly (singletons). Null
   *  when no panel of that type is open. Use this to route global
   *  key handlers to the right per-type target. */
  focused(prefix: string): ManagedPanel | null {
    const id = this.focusedByKey.get(prefix);
    if (!id) return null;
    return this.panels.get(id) ?? null;
  }

  /** Associate a LayoutNode with a panel — clicks anywhere in
   *  `node`'s subtree (including `node` itself) will resolve to
   *  `panel` via `findPanelByDescendant`. Wrapper-panel
   *  constructors call this for their interior content root
   *  (`LayoutInventory`, `LayoutWorld`, etc.) so body clicks
   *  reach the right panel for focus / activation. Multiple nodes
   *  can map to the same panel — register each interior root the
   *  panel owns. */
  registerNode(node: LayoutNode, panel: ManagedPanel): void {
    this.nodeToPanel.set(node, panel);
  }

  /** Drop a `registerNode` mapping. Called from the wrapper
   *  panel's cleanup so a destroyed panel's nodes don't linger in
   *  the lookup. */
  unregisterNode(node: LayoutNode): void {
    this.nodeToPanel.delete(node);
  }

  /** Walk `hit`'s LayoutNode parent chain and return the first
   *  registered ancestor's panel, or `null`. `MainScene`'s
   *  `left_click` / `left_drag_start` handlers use this to
   *  focus the panel a Pixi-side interaction landed inside —
   *  closing the gap where body clicks (with `pointer-events:
   *  none` on the DOM panel) wouldn't otherwise raise focus. */
  findPanelByDescendant(hit: LayoutNode | null): ManagedPanel | null {
    let n: LayoutNode | null = hit;
    while (n) {
      const p = this.nodeToPanel.get(n);
      if (p) return p;
      n = n.parent;
    }
    return null;
  }

  /** Returns the next cascade offset for a free-floating panel.
   *  Callers stitch `dx`/`dy` into their `defaultRect.left` /
   *  `defaultRect.top`. Wraps after a handful of steps so panels
   *  don't drift off-screen on long sessions. */
  nextCascadeOffset(): { dx: number; dy: number } {
    const step = 30;
    const cycle = 6;
    const i = this.cascadeIndex % cycle;
    this.cascadeIndex++;
    return { dx: i * step, dy: i * step };
  }

  private handleFocus(id: string): void {
    this.focusedByKey.set(id, id);
    const colon = id.indexOf(":");
    if (colon > 0) {
      this.focusedByKey.set(id.slice(0, colon), id);
    }
  }

  private handleDestroy(id: string): void {
    this.panels.delete(id);
    if (this.focusedByKey.get(id) === id) this.focusedByKey.delete(id);
    const colon = id.indexOf(":");
    if (colon > 0) {
      const prefix = id.slice(0, colon);
      if (this.focusedByKey.get(prefix) === id) this.focusedByKey.delete(prefix);
    }
  }
}
