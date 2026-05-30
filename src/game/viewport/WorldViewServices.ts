import type { RenderTexture } from "pixi.js";
import type { LayoutNode } from "../layout/LayoutNode";

/**
 * Per-view services a card needs from the `LayoutWorld` it lives in:
 * nearest-cell resolution, the in-front-objects occlusion bake, and a
 * tile-change subscription. These used to be last-write-wins singletons on
 * `GameContext` (`worldHexAt` / `worldOverlay` / `onTilesChanged`), which broke
 * the moment a second `LayoutWorld` existed — its constructor clobbered the
 * first's hooks. Now each card resolves the services of the specific view it's
 * attached to (see `findWorldView`), so multiple viewports coexist.
 *
 * `LayoutWorld` implements this (a `RectGrid` inventory view implements it too;
 * it just has no terrain, so `makeObjectOverlayForTile` draws nothing).
 */
export interface WorldViewServices {
  /** Global pixel → nearest cell `(q, r)` + the cell-centre's pixel offset. */
  worldHexAt(
    globalX: number,
    globalY: number,
  ): { q: number; r: number; offsetX: number; offsetY: number };
  /** Bake the objects in front of cell `(q, r)` into `target`; returns true
   *  if anything was drawn (false on a terrain-less surface). */
  makeObjectOverlayForTile(
    q: number,
    r: number,
    target: RenderTexture,
    width: number,
    height: number,
    offsetX?: number,
    offsetY?: number,
  ): boolean;
  /** Subscribe to this view's tile-data changes; returns an unsubscribe fn. */
  onTilesChanged(cb: () => void): () => void;
  /** Cell `(q, r)` → centre pixel in the card surface's local frame. Cards on
   *  a grid surface (e.g. inventory rect cells) position themselves with this
   *  rather than re-deriving the grid math. */
  cellToPixel(q: number, r: number): { x: number; y: number };
}

/** A `LayoutNode` that provides `WorldViewServices`. The brand lets the card
 *  layer recognise it by walking the parent chain WITHOUT a value-import of
 *  `LayoutWorld` (which would risk an import cycle). */
export interface WorldViewProvider extends WorldViewServices {
  readonly isWorldView: true;
}

/** Walk a node's parent chain to the `LayoutWorld` (or other provider) that
 *  owns it, returning its services. Returns the last-resolved value's owner is
 *  the caller's concern — this is a pure chain walk. Returns `null` when the
 *  node is detached / parented outside any view (e.g. a card in the drag
 *  overlay); callers that need a stable value across a drag should cache it. */
export function findWorldView(node: LayoutNode | null): WorldViewServices | null {
  let n: LayoutNode | null = node;
  while (n) {
    if ((n as Partial<WorldViewProvider>).isWorldView) {
      return n as unknown as WorldViewServices;
    }
    n = n.parent;
  }
  return null;
}
