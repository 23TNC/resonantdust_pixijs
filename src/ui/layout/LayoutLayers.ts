import { LayoutObject, type LayoutObjectOptions } from "./LayoutObject";

export interface LayoutLayersOptions extends LayoutObjectOptions {
  /**
   * Define the available layers.
   *
   * Array form — layers are named in depth order, assigned depths 0, 1, 2 …:
   *   layers: ["base", "game", "ui", "modal"]
   *
   * Record form — explicit depth per layer (allows non-contiguous or shared depths):
   *   layers: { base: 0, game: 10, ui: 20, modal: 30 }
   */
  layers: string[] | Record<string, number>;
}

/**
 * A LayoutObject that organises its children into named depth layers.
 *
 * Every child added via add() is sized to fill the full innerRect on each
 * layout pass, so layers stack on top of one another like transparent panes.
 * Depth controls which pane renders in front; within the same layer, children
 * render in insertion order.
 *
 * Typical use — overlays:
 *
 *   const layers = new LayoutLayers({
 *     layers: ["world", "objects", "ui", "modal"],
 *   });
 *   layers.add(worldView,   "world");
 *   layers.add(hudPanel,    "ui");
 *   layers.add(confirmDlg,  "modal");
 *
 * Removing a child does not require knowing its layer:
 *   layers.remove(confirmDlg);
 */
export class LayoutLayers extends LayoutObject {
  private readonly _depths: ReadonlyMap<string, number>;

  constructor(options: LayoutLayersOptions) {
    super(options);

    const depths = new Map<string, number>();

    if (Array.isArray(options.layers)) {
      for (let i = 0; i < options.layers.length; i++) {
        depths.set(options.layers[i], i);
      }
    } else {
      for (const [name, depth] of Object.entries(options.layers)) {
        depths.set(name, depth);
      }
    }

    this._depths = depths;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Add a child to the named layer.  The child is sized to fill innerRect on
   * every layout pass.  Throws if the layer name was not declared at construction.
   */
  add<T extends LayoutObject>(child: T, layer: string): T {
    const depth = this._depths.get(layer);
    if (depth === undefined) throw new Error(`LayoutLayers: unknown layer "${layer}"`);
    return this.addLayoutChild(child, depth);
  }

  /** Remove a child regardless of which layer it was added to. */
  remove<T extends LayoutObject>(child: T): T | null {
    return this.removeLayoutChild(child);
  }

  /** Depth assigned to a layer, or undefined if the layer does not exist. */
  getDepth(layer: string): number | undefined {
    return this._depths.get(layer);
  }

  /** All declared layer names in depth order (ascending). */
  getLayers(): string[] {
    return [...this._depths.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([name]) => name);
  }

  // ─── Layout ──────────────────────────────────────────────────────────────

  /** Size every child to fill the full inner rect. */
  protected override updateLayoutChildren(): void {
    const { x, y, width, height } = this.innerRect;
    for (const child of this.getLayoutChildren()) {
      child.setLayout(x, y, width, height);
    }
  }
}
