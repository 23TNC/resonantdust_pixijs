/** A cell-grid coordinate strategy — maps a cell `(q, r)` to/from a pixel and
 *  snaps a pixel to the nearest cell. The one thing that differs between the
 *  two grid views: world uses a pointy-top **hex** grid, inventory a **rect**
 *  grid. Everything else (card surface, viewport, retained-mode rendering) is
 *  shared by `LayoutWorld` once it's parameterized on a `CellGrid`.
 *
 *  All coordinates are **grid-space** (pan-independent): a viewport offset is
 *  added by the caller (`LayoutWorld` holds `viewQ/viewR`). `cellToPixel`
 *  returns the cell *centre*; cell `(0, 0)`'s centre is the grid origin. */
export interface CellGrid {
  /** Cell shape — drives how tile bodies are baked (hex polygon vs rect) so a
   *  viewport draws hexagon tiles on a hex grid and rectangle tiles on a rect
   *  grid. Pure rendering; the addressing math is identical either way. */
  readonly shape: "hex" | "rect";
  /** Pixel footprint of one cell — used for sprite sizing + centring. */
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** Cell `(q, r)` (may be fractional) → centre pixel in grid-space. */
  cellToPixel(q: number, r: number): { x: number; y: number };
  /** Grid-space pixel → fractional cell coords (inverse of `cellToPixel`). */
  pixelToCellFractional(x: number, y: number): { q: number; r: number };
  /** Snap fractional cell coords to the nearest integer cell. */
  roundCell(q: number, r: number): { q: number; r: number };
  /** Cells whose footprint overlaps a `width × height` viewport centred on
   *  fractional view `(viewQ, viewR)`, padded by `margin` cells on every side,
   *  sorted closest-first to integer anchor `(baseQ, baseR)` so a big fill
   *  paints inside-out. */
  cellsInViewport(
    viewQ: number,
    viewR: number,
    baseQ: number,
    baseR: number,
    width: number,
    height: number,
    margin: number,
  ): { q: number; r: number }[];
}
