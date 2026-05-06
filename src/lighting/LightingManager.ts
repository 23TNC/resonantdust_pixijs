import type { Zone } from "../server/bindings/types";
import type { GameContext } from "../GameContext";
import { HEX_RADIUS } from "../cards/HexCardVisual";
import {
  getTileDefId,
  getTileHeight,
  unpackMacroZone,
} from "../world/worldCoords";

/**
 * Pixels of vertical relief per `u3` height step. Heights are stored 0..7;
 * scaling them into the same units as world x/y is what gives the cross
 * product a non-degenerate normal. `HEX_RADIUS / 4` puts a 1-step delta at
 * roughly 8° of slope — gentle enough that mixed terrain reads as varied
 * shading rather than as cliffs.
 */
export const HEIGHT_UNIT_PX = HEX_RADIUS / 4;

/** Default per-light tunables — exposed as constants so callers can match
 *  the spec's defaults without repeating the literals. */
const DEFAULT_SLOPE_STRENGTH = 0.35;
const DEFAULT_HEIGHT_STRENGTH = 0.15;
const DEFAULT_MIN_LIGHT = 0.02;

/** Final-brightness composition. The propagation accumulator is fed through
 *  `toneMap` and added to a constant ambient floor plus an upward bias on
 *  `normal.z` so flat surfaces are visible without lighting and so up-facing
 *  triangles never read totally black. */
const AMBIENT = 0.0; // 0.2;
const UPWARD_BIAS = 0.0; // 0.1;

export type LightHandle = number;

/** 3D vector / point in world space (`+x` east, `+y` south, `+z` up). */
export type Point3 = readonly [x: number, y: number, z: number];

/**
 * Grid-flood light source. The propagation seeds at the triangle that
 * contains `(x, y)` with `power` and walks outward through triangle
 * neighbours up to `range` steps, multiplying by `falloff` each step plus
 * `slopeBlock` / `heightBlock` penalties. `z` is the light's elevation in
 * raw `u3` units (multiply hex height by 1, not by `HEIGHT_UNIT_PX`); it
 * is recorded for callers / debug glyphs but not used by the propagation
 * formula itself, which only references triangle centroid heights.
 */
export interface Light {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Initial light value at the source triangle. */
  readonly power: number;
  /** Max BFS depth in triangle steps. */
  readonly range: number;
  /** Per-step multiplicative attenuation. `0..1`; lower = sharper falloff. */
  readonly falloff: number;
  /** Strength of the slope-block penalty. Default `0.35`. */
  readonly slopeStrength?: number;
  /** Strength of the height-block penalty (per raw `u3` step). Default `0.15`. */
  readonly heightStrength?: number;
  /** Propagation cuts off when `nextLight` falls below this. Default `0.02`. */
  readonly minLight?: number;
}

/**
 * The hex grid's vertex set tiles the plane with twice as many equilateral
 * triangles as hexes. Each hex `(q, r)` owns one of each:
 *
 * - `up`   — inscribed in the hex itself; corners at TOP, BR, BL.
 * - `down` — fills the south "between hexes" gap; corners at BR-of-(q,r),
 *            BL-of-(q,r), and the south-tip vertex shared by the SE and SW
 *            neighbours (= TOP-of-(q-1, r+2)).
 *
 * Together UP + DOWN cover the world without overlap.
 */
export type TriangleKind = "up" | "down";

export interface TriangleData {
  /**
   * Three world-space vertices of the triangle. Wound such that
   * `(p1 − p0) × (p2 − p0)` yields a +z normal for flat surfaces.
   */
  readonly points: readonly [Point3, Point3, Point3];
  /** Outward unit normal. */
  readonly normal: Point3;
}

export interface HexLighting {
  /** `0..1`. `AMBIENT + UPWARD_BIAS·max(0,nz) + toneMap(propagated)`. */
  readonly brightness: number;
  /** Linear-RGB. The propagation model is currently colourless, so this is
   *  grayscale `[brightness, brightness, brightness]`. */
  readonly color: readonly [r: number, g: number, b: number];
  /** The triangle's outward unit normal. */
  readonly normal: Point3;
}

const SX = (Math.sqrt(3) * HEX_RADIUS) / 2;

/** Reinhard-ish tone curve: maps `[0, ∞)` smoothly into `[0, 1)`. */
function toneMap(x: number): number {
  return 1 - Math.exp(-x);
}

interface NormalisedLight {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly power: number;
  readonly range: number;
  readonly falloff: number;
  readonly slopeStrength: number;
  readonly heightStrength: number;
  readonly minLight: number;
}

/**
 * Per-light state. `contribution` is this light's per-triangle propagation
 * result from its last clean recompute; `dirty` flags it for recomputation
 * on the next `lightingAt` call. The aggregate `totalLight` is kept in sync
 * incrementally — when a dirty light is recomputed, the old contribution is
 * subtracted and the new one is added, so static lights pay nothing on
 * frames where only a dynamic light moved.
 */
interface LightEntry {
  light: NormalisedLight;
  dirty: boolean;
  contribution: Map<string, number>;
}

function normaliseLight(l: Light): NormalisedLight {
  return {
    x: l.x,
    y: l.y,
    z: l.z,
    power: l.power,
    range: l.range,
    falloff: l.falloff,
    slopeStrength: l.slopeStrength ?? DEFAULT_SLOPE_STRENGTH,
    heightStrength: l.heightStrength ?? DEFAULT_HEIGHT_STRENGTH,
    minLight: l.minLight ?? DEFAULT_MIN_LIGHT,
  };
}

function triKey(q: number, r: number, kind: TriangleKind): string {
  return `${q},${r},${kind}`;
}

function parseTriKey(key: string): { q: number; r: number; kind: TriangleKind } {
  const [qs, rs, ks] = key.split(",");
  return { q: Number(qs), r: Number(rs), kind: ks as TriangleKind };
}

/**
 * Triangle-graph adjacency. Each triangle has exactly three neighbours —
 * UP triangles bridge to three DOWN triangles and vice versa, derived from
 * the shared-edge/shared-vertex topology of the hex grid.
 */
function* triangleNeighbors(
  q: number,
  r: number,
  kind: TriangleKind,
): Generator<readonly [number, number, TriangleKind]> {
  if (kind === "up") {
    // BR-BL edge → DOWN of same hex.
    yield [q, r, "down"] as const;
    // TOP-BR edge → DOWN owned by NE neighbour.
    yield [q + 1, r - 1, "down"] as const;
    // BL-TOP edge → DOWN owned by NW neighbour.
    yield [q, r - 1, "down"] as const;
  } else {
    // BR-BL edge → UP of same hex.
    yield [q, r, "up"] as const;
    // east edge (BR → south-tip) → UP of SE neighbour.
    yield [q, r + 1, "up"] as const;
    // west edge (BL → south-tip) → UP of SW neighbour.
    yield [q - 1, r + 1, "up"] as const;
  }
}

/** Sign-of-cross-product test for `(x, y)` inside triangle `points` (ignoring
 *  z). Returns true on the boundary. */
function pointInTri(
  x: number,
  y: number,
  points: readonly [Point3, Point3, Point3],
): boolean {
  const [p0, p1, p2] = points;
  const d1 = (x - p1[0]) * (p0[1] - p1[1]) - (p0[0] - p1[0]) * (y - p1[1]);
  const d2 = (x - p2[0]) * (p1[1] - p2[1]) - (p1[0] - p2[0]) * (y - p2[1]);
  const d3 = (x - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (y - p0[1]);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

/** Centroid of a triangle. */
function triCenter(tri: TriangleData): Point3 {
  const [p0, p1, p2] = tri.points;
  return [
    (p0[0] + p1[0] + p2[0]) / 3,
    (p0[1] + p1[1] + p2[1]) / 3,
    (p0[2] + p1[2] + p2[2]) / 3,
  ];
}

/**
 * Builds a triangle mesh on top of the world hex grid: every hex contributes
 * one upward inscribed triangle and one downward "between hexes" triangle,
 * so triangles tile the plane at 2× hex density. Each triangle vertex sits
 * at the mean height of the three hexes that share it.
 *
 * Lighting uses a grid flood-fill model rather than direct N·L shading: each
 * registered light seeds at the triangle containing its `(x, y)` and walks
 * outward through triangle neighbours, attenuating with a per-step `falloff`
 * plus `slopeBlock` (next normal opposes propagation direction → wall) and
 * `heightBlock` (next centroid is taller → uphill cost). Lights stack
 * linearly into a per-triangle accumulator, and the final brightness adds
 * an ambient floor + an `n.z` upward bias on top of `toneMap(accumulator)`.
 *
 * World frame: `+x` east, `+y` south (matches LayoutWorld pixel axes), `+z`
 * up. Vertex `z` is in pixels (`u3 * HEIGHT_UNIT_PX`); the propagation
 * converts back to raw `u3` for `heightBlock`.
 */
export class LightingManager {
  /** `${q},${r}` → tile height (0..7). Missing entries are treated as 0. */
  private readonly heights = new Map<string, number>();

  /** Lazy per-triangle geometry cache. */
  private readonly triCache = new Map<string, TriangleData>();

  private readonly lights = new Map<LightHandle, LightEntry>();
  private nextHandle = 1;

  /** `triKey → totalLight`. Always kept in sync with the sum of every
   *  registered light's `contribution`. Updated incrementally inside
   *  `_ensureFreshLighting` — only dirty lights are recomputed, and their
   *  delta (`new − old`) is applied per affected triangle. */
  private readonly totalLight = new Map<string, number>();

  private readonly unsubZones: () => void;

  constructor(ctx: GameContext) {
    for (const zone of ctx.data.values("zones")) this.ingest(zone);

    this.unsubZones = ctx.data.subscribe("zones", (change) => {
      const zone = change.kind === "delete" ? change.oldValue : change.newValue;
      if (!zone) return;
      this.evictZone(zone);
      if (change.kind !== "delete") this.ingest(zone);
      // Heights along a zone border feed neighbouring hexes' triangle
      // vertices, so the safe blast radius for the geometry is "everything
      // we've cached." Every light's propagation depends on the geometry,
      // so they all get marked dirty.
      this.triCache.clear();
      for (const entry of this.lights.values()) entry.dirty = true;
    });
  }

  registerLight(light: Light): LightHandle {
    const handle = this.nextHandle++;
    this.lights.set(handle, {
      light: normaliseLight(light),
      dirty: true,
      contribution: new Map(),
    });
    return handle;
  }

  unregisterLight(handle: LightHandle): void {
    const entry = this.lights.get(handle);
    if (!entry) return;
    this._subtractContribution(entry.contribution);
    this.lights.delete(handle);
  }

  /** Replace a registered light's parameters in place and flag it for
   *  recomputation on the next `lightingAt` call. Static lights pay no
   *  cost; only the updated light walks its flood-fill again. */
  updateLight(handle: LightHandle, light: Light): void {
    const entry = this.lights.get(handle);
    if (!entry) return;
    entry.light = normaliseLight(light);
    entry.dirty = true;
  }

  /** Mark a registered light as needing its propagation recomputed. Useful
   *  when something other than the light's own parameters has changed and
   *  you want to force a refresh — though zone updates already mark every
   *  light dirty automatically. */
  markLightDirty(handle: LightHandle): void {
    const entry = this.lights.get(handle);
    if (entry) entry.dirty = true;
  }

  /** Tile height in `u3` units (0..7). 0 for unknown / unloaded tiles. */
  heightAt(q: number, r: number): number {
    return this.heights.get(`${q},${r}`) ?? 0;
  }

  /**
   * Three world-space points and the outward unit normal of the triangle
   * `kind` owned by hex `(q, r)`. Cached; safe to call every frame.
   */
  triangleAt(q: number, r: number, kind: TriangleKind): TriangleData {
    const key = triKey(q, r, kind);
    const hit = this.triCache.get(key);
    if (hit) return hit;
    const tri =
      kind === "up" ? this.computeUp(q, r) : this.computeDown(q, r);
    this.triCache.set(key, tri);
    return tri;
  }

  /** Final brightness for the requested triangle: ambient + upward bias +
   *  tone-mapped flood-fill light. */
  lightingAt(q: number, r: number, kind: TriangleKind): HexLighting {
    const tri = this.triangleAt(q, r, kind);
    this._ensureFreshLighting();

    const propagated = this.totalLight.get(triKey(q, r, kind)) ?? 0;
    const nz = Math.max(0, tri.normal[2]);
    const brightness = Math.min(
      1,
      AMBIENT + UPWARD_BIAS * nz + toneMap(propagated),
    );

    return {
      brightness,
      color: [brightness, brightness, brightness],
      normal: tri.normal,
    };
  }

  dispose(): void {
    this.unsubZones();
    this.heights.clear();
    this.triCache.clear();
    this.lights.clear();
    this.totalLight.clear();
  }

  // ── propagation ──────────────────────────────────────────────────────────

  /** Walk every registered light, recompute the dirty ones, and apply the
   *  delta of (new contribution − old contribution) to `totalLight`. */
  private _ensureFreshLighting(): void {
    for (const entry of this.lights.values()) {
      if (!entry.dirty) continue;
      const next = this._computeContribution(entry.light);
      this._applyContributionDelta(entry.contribution, next);
      entry.contribution = next;
      entry.dirty = false;
    }
  }

  /** Subtract `oldContrib` and add `newContrib` to `totalLight`, dropping
   *  keys whose accumulated value goes to zero (within floating-point
   *  noise) so the map stays compact. */
  private _applyContributionDelta(
    oldContrib: Map<string, number>,
    newContrib: Map<string, number>,
  ): void {
    this._subtractContribution(oldContrib);
    for (const [k, v] of newContrib) {
      this.totalLight.set(k, (this.totalLight.get(k) ?? 0) + v);
    }
  }

  private _subtractContribution(contrib: Map<string, number>): void {
    for (const [k, v] of contrib) {
      const next = (this.totalLight.get(k) ?? 0) - v;
      if (next > 1e-9) this.totalLight.set(k, next);
      else this.totalLight.delete(k);
    }
  }

  /**
   * Dijkstra-style flood fill for one light, returning a fresh per-triangle
   * contribution map. The brightest unvisited triangle is dequeued first so
   * each triangle is finalised at its peak reachable light value.
   */
  private _computeContribution(light: NormalisedLight): Map<string, number> {
    const contribution = new Map<string, number>();
    const sourceKey = this.findContainingTriangle(light.x, light.y);
    if (sourceKey === null) return contribution;

    const visited = new Map<string, number>();
    const queue: { key: string; light: number; step: number }[] = [
      { key: sourceKey, light: light.power, step: 0 },
    ];

    while (queue.length > 0) {
      // Pop the brightest unvisited entry.
      let bestIdx = 0;
      for (let i = 1; i < queue.length; i++) {
        if (queue[i].light > queue[bestIdx].light) bestIdx = i;
      }
      const item = queue.splice(bestIdx, 1)[0];
      if (visited.has(item.key)) continue;
      visited.set(item.key, item.light);

      if (item.step >= light.range) continue;

      const { q, r, kind } = parseTriKey(item.key);
      const cur = triCenter(this.triangleAt(q, r, kind));

      for (const [nq, nr, nkind] of triangleNeighbors(q, r, kind)) {
        const neighborKey = triKey(nq, nr, nkind);
        if (visited.has(neighborKey)) continue;

        const neighborTri = this.triangleAt(nq, nr, nkind);
        const next = triCenter(neighborTri);

        // Unit propagation direction in xy.
        const dirX = next[0] - cur[0];
        const dirY = next[1] - cur[1];
        const dirLen = Math.hypot(dirX, dirY) || 1;
        const dx = dirX / dirLen;
        const dy = dirY / dirLen;

        // Slope block: next triangle's normal opposes the propagation
        // direction (its front face points back toward us → wall).
        const slopeBlock = Math.max(
          0,
          -(neighborTri.normal[0] * dx + neighborTri.normal[1] * dy),
        );

        // Height block: stepping uphill costs; downhill is free. Convert
        // pixel z back to raw `u3` so `heightStrength` can be O(0.1).
        const nextZ = next[2] / HEIGHT_UNIT_PX;
        const curZ = cur[2] / HEIGHT_UNIT_PX;
        const heightBlock = Math.max(0, nextZ - curZ) * light.heightStrength;

        const nextLight =
          item.light *
          light.falloff *
          (1 - slopeBlock * light.slopeStrength) *
          (1 - heightBlock);

        if (nextLight < light.minLight) continue;
        queue.push({
          key: neighborKey,
          light: nextLight,
          step: item.step + 1,
        });
      }
    }

    for (const [k, v] of visited) contribution.set(k, v);
    return contribution;
  }

  /**
   * Finds the triangle whose 2D footprint contains `(x, y)`. Approximates
   * the hex via axial-coord rounding then tests the UP/DOWN of a 3×3
   * neighbourhood — UP+DOWN tile the plane without overlap, so exactly one
   * test passes (or none, if the point is outside the loaded grid).
   */
  private findContainingTriangle(x: number, y: number): string | null {
    const fq = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / HEX_RADIUS;
    const fr = ((2 / 3) * y) / HEX_RADIUS;
    const fx = fq, fz = fr, fy = -fq - fr;
    let rx = Math.round(fx);
    let ry = Math.round(fy);
    let rz = Math.round(fz);
    const ddx = Math.abs(rx - fx);
    const ddy = Math.abs(ry - fy);
    const ddz = Math.abs(rz - fz);
    if (ddx > ddy && ddx > ddz) rx = -ry - rz;
    else if (ddy > ddz) ry = -rx - rz;
    else rz = -rx - ry;
    const baseQ = rx;
    const baseR = rz;

    for (let dq = -1; dq <= 1; dq++) {
      for (let dr = -1; dr <= 1; dr++) {
        const q = baseQ + dq;
        const r = baseR + dr;
        for (const kind of ["up", "down"] as const) {
          const tri = this.triangleAt(q, r, kind);
          if (pointInTri(x, y, tri.points)) return triKey(q, r, kind);
        }
      }
    }
    return null;
  }

  // ── internals: triangle geometry ─────────────────────────────────────────

  /** TOP corner of hex `(q, r)`. Shared with `(q, r-1)` and `(q+1, r-1)`. */
  private vertexTop(q: number, r: number): Point3 {
    const cx = HEX_RADIUS * Math.sqrt(3) * (q + r / 2);
    const cy = HEX_RADIUS * 1.5 * r;
    const z =
      ((this.heightAt(q, r) +
        this.heightAt(q, r - 1) +
        this.heightAt(q + 1, r - 1)) /
        3) *
      HEIGHT_UNIT_PX;
    return [cx, cy - HEX_RADIUS, z];
  }

  /** BR corner of hex `(q, r)`. Shared with `(q+1, r)` and `(q, r+1)`. */
  private vertexBR(q: number, r: number): Point3 {
    const cx = HEX_RADIUS * Math.sqrt(3) * (q + r / 2);
    const cy = HEX_RADIUS * 1.5 * r;
    const z =
      ((this.heightAt(q, r) +
        this.heightAt(q + 1, r) +
        this.heightAt(q, r + 1)) /
        3) *
      HEIGHT_UNIT_PX;
    return [cx + SX, cy + HEX_RADIUS / 2, z];
  }

  /** BL corner of hex `(q, r)`. Shared with `(q-1, r)` and `(q-1, r+1)`. */
  private vertexBL(q: number, r: number): Point3 {
    const cx = HEX_RADIUS * Math.sqrt(3) * (q + r / 2);
    const cy = HEX_RADIUS * 1.5 * r;
    const z =
      ((this.heightAt(q, r) +
        this.heightAt(q - 1, r) +
        this.heightAt(q - 1, r + 1)) /
        3) *
      HEIGHT_UNIT_PX;
    return [cx - SX, cy + HEX_RADIUS / 2, z];
  }

  /** Inscribed UP triangle. Wound `top → BR → BL` so the cross product
   *  yields a `+z` normal for flat surfaces. */
  private computeUp(q: number, r: number): TriangleData {
    return triangle(
      this.vertexTop(q, r),
      this.vertexBR(q, r),
      this.vertexBL(q, r),
    );
  }

  /** South-pointing DOWN triangle. The south-tip vertex is the TOP corner
   *  of hex `(q-1, r+2)` — equivalently the BL of the SE neighbour and the
   *  BR of the SW neighbour. Wound `DN → UL → UR` for a `+z` normal. */
  private computeDown(q: number, r: number): TriangleData {
    return triangle(
      this.vertexTop(q - 1, r + 2),
      this.vertexBL(q, r),
      this.vertexBR(q, r),
    );
  }

  private ingest(zone: Zone): void {
    const { zoneQ, zoneR } = unpackMacroZone(zone.macroZone);
    const ts: bigint[] = [
      zone.t0, zone.t1, zone.t2, zone.t3,
      zone.t4, zone.t5, zone.t6, zone.t7,
    ];
    for (let r = 0; r < 8; r++) {
      const t = ts[r];
      if (t === 0n) continue;
      for (let q = 0; q < 8; q++) {
        const tileByte = Number((t >> BigInt(q * 8)) & 0xffn);
        if (getTileDefId(tileByte) === 0) continue;
        this.heights.set(`${zoneQ + q},${zoneR + r}`, getTileHeight(tileByte));
      }
    }
  }

  private evictZone(zone: Zone): void {
    const { zoneQ, zoneR } = unpackMacroZone(zone.macroZone);
    for (let r = 0; r < 8; r++) {
      for (let q = 0; q < 8; q++) {
        this.heights.delete(`${zoneQ + q},${zoneR + r}`);
      }
    }
  }
}

function triangle(p0: Point3, p1: Point3, p2: Point3): TriangleData {
  const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
  const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz) || 1;
  return {
    points: [p0, p1, p2],
    normal: [nx / len, ny / len, nz / len],
  };
}
