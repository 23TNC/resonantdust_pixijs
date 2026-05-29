import type { CellGrid } from "../CellGrid";

/** Axial rect grid of the given cell footprint — the inventory grid. Cell
 *  `(q, r)`'s centre is the lattice point `(q*cellWidth, r*cellHeight)`; cell
 *  `(0, 0)` at the origin, mirroring `HexGrid` so the shared viewport math is
 *  identical. */
export class RectGrid implements CellGrid {
  readonly shape = "rect" as const;
  constructor(
    readonly cellWidth: number,
    readonly cellHeight: number,
  ) {}

  cellToPixel(q: number, r: number): { x: number; y: number } {
    return { x: q * this.cellWidth, y: r * this.cellHeight };
  }

  pixelToCellFractional(x: number, y: number): { q: number; r: number } {
    return { q: x / this.cellWidth, r: y / this.cellHeight };
  }

  roundCell(q: number, r: number): { q: number; r: number } {
    return { q: Math.round(q), r: Math.round(r) };
  }

  cellsInViewport(
    viewQ: number,
    viewR: number,
    baseQ: number,
    baseR: number,
    width: number,
    height: number,
    margin: number,
  ): { q: number; r: number }[] {
    const qSpan = width / (2 * this.cellWidth) + 0.5;
    const rSpan = height / (2 * this.cellHeight) + 0.5;
    const qMin = Math.floor(viewQ - qSpan) - margin;
    const qMax = Math.ceil(viewQ + qSpan) + margin;
    const rMin = Math.floor(viewR - rSpan) - margin;
    const rMax = Math.ceil(viewR + rSpan) + margin;
    const ranked: { q: number; r: number; d: number }[] = [];
    for (let r = rMin; r <= rMax; r++) {
      for (let q = qMin; q <= qMax; q++) {
        // Chebyshev distance from the anchor, for inside-out ordering.
        const d = Math.max(Math.abs(q - baseQ), Math.abs(r - baseR));
        ranked.push({ q, r, d });
      }
    }
    ranked.sort((a, b) => a.d - b.d);
    return ranked.map(({ q, r }) => ({ q, r }));
  }
}
