import type { CellGrid } from "../CellGrid";

/** Pointy-top axial hex grid of the given display radius — the world
 *  grid. Implements the `CellGrid` coordinate strategy with the hex
 *  math `LayoutWorld` once used inline. */
export class HexGrid implements CellGrid {
  readonly shape = "hex" as const;
  readonly cellWidth: number;
  readonly cellHeight: number;

  constructor(private readonly radius: number) {
    this.cellWidth = Math.sqrt(3) * radius;
    this.cellHeight = radius * 2;
  }

  cellToPixel(q: number, r: number): { x: number; y: number } {
    const R = this.radius;
    return {
      x: R * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r),
      y: R * ((3 / 2) * r),
    };
  }

  pixelToCellFractional(x: number, y: number): { q: number; r: number } {
    const R = this.radius;
    return {
      q: x / (R * Math.sqrt(3)) - y / (3 * R),
      r: (2 * y) / (3 * R),
    };
  }

  roundCell(q: number, r: number): { q: number; r: number } {
    // Cube-coordinate rounding — naive axial round-then-pick-larger-residual
    // picks the wrong hex on triangle boundaries.
    const fx = q;
    const fz = r;
    const fy = -q - r;
    let rx = Math.round(fx);
    let ry = Math.round(fy);
    let rz = Math.round(fz);
    const ddx = Math.abs(rx - fx);
    const ddy = Math.abs(ry - fy);
    const ddz = Math.abs(rz - fz);
    if (ddx > ddy && ddx > ddz) rx = -ry - rz;
    else if (ddy > ddz) ry = -rx - rz;
    else rz = -rx - ry;
    return { q: rx, r: rz };
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
    const R = this.radius;
    const colW = Math.sqrt(3) * R; // horizontal step per dq (and per dr/2)
    const rowH = 1.5 * R; // vertical step per dr
    // Row span: a hex centre is on-screen when its y ± R overlaps [0, h].
    const rSpan = (height / 2 + R) / rowH;
    const rMin = Math.floor(viewR - rSpan) - margin;
    const rMax = Math.ceil(viewR + rSpan) + margin;
    const qSpan = width / (2 * colW) + 0.5;
    const ranked: { q: number; r: number; d: number }[] = [];
    for (let r = rMin; r <= rMax; r++) {
      const qCentre = viewQ - (r - viewR) / 2;
      const qMin = Math.floor(qCentre - qSpan) - margin;
      const qMax = Math.ceil(qCentre + qSpan) + margin;
      for (let q = qMin; q <= qMax; q++) {
        const dq = q - baseQ;
        const dr = r - baseR;
        // Axial hex distance from the anchor, for inside-out ordering.
        const d = (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
        ranked.push({ q, r, d });
      }
    }
    ranked.sort((a, b) => a.d - b.d);
    return ranked.map(({ q, r }) => ({ q, r }));
  }
}
