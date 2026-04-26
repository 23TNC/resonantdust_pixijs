import { Point } from "pixi.js";
import { client_zones, packZone, unpackZone, ZONE_SIZE, type ZoneId } from "@/spacetime/Data";
import { LayoutObject } from "@/ui/layout/LayoutObject";
import { LayoutViewport, type LayoutViewportOptions } from "@/ui/layout/LayoutViewport";
import { Zone } from "./Zone";

const SQRT3 = Math.sqrt(3);

// Pack two 16-bit signed integers into a 32-bit key for Map lookup.
// Valid for world_q/world_r in [-32768, 32767].
function posKey(q: number, r: number): number {
  return ((q & 0xffff) << 16) | (r & 0xffff);
}

export interface WorldOptions extends LayoutViewportOptions {
  z?: number;
  tileRadius?: number;
}

/**
 * Main game board. Extends LayoutViewport so the hex world can be panned and
 * clipped to the screen rect.
 *
 * Zone management:
 *   Call syncZones() whenever client_zones changes. World maintains one Zone
 *   child per entry in client_zones whose z matches _z. Each Zone is placed at
 *   its world-space pixel rect; the camera transform in LayoutViewport maps
 *   world pixels to screen pixels.
 *
 * Overlay children (players, animating cards):
 *   Register via addOverlay(). Unlike tile children, overlays may span zone
 *   boundaries, so they are tracked here rather than in Zone. Hit testing checks
 *   the World overlay index before falling through to Zone → Tile.
 *   Call invalidateOverlays() whenever an overlay's position changes outside of
 *   a layout pass so the hex-coverage index stays accurate.
 *
 * Geometry (flat-top hex, circumradius R, odd-q offset convention):
 *   Zone (zone_q, zone_r) covers world hexes
 *     q ∈ [zone_q·8, zone_q·8+7],  r ∈ [zone_r·8, zone_r·8+7].
 *
 *   Pixel rect of the zone in world space:
 *     left   = (zone_q·12 − 1) · R
 *     top    = (zone_r·8  − ½) · √3·R
 *     width  = 12.5 · R
 *     height = 8.5  · √3·R
 *
 *   Pixel centre of world hex (world_q, world_r):
 *     cx = world_q · 1.5 · R
 *     cy = world_r · √3·R  +  (odd(world_q) ? √3/2·R : 0)
 */
export class World extends LayoutViewport {
  private _z: number;
  private _tileRadius: number;
  private readonly _zones = new Map<ZoneId, Zone>();

  // ─── Overlay index ───────────────────────────────────────────────────────
  // Non-zone layout children (players, moving cards …) registered by the world
  // hex cells they visually cover.  The key is posKey(world_q, world_r).
  private readonly _overlayChildren = new Set<LayoutObject>();
  private readonly _overlayAtHex   = new Map<number, Set<LayoutObject>>();
  private          _overlayDirty   = false;

  // ─────────────────────────────────────────────────────────────────────────

  constructor(options: WorldOptions = {}) {
    super(options);
    this._z          = options.z          ?? 1;
    this._tileRadius = options.tileRadius ?? 16;
  }

  // ─── Configuration ───────────────────────────────────────────────────────

  setZ(z: number): void {
    if (this._z === z) return;
    this._z = z;
    this.syncZones();
  }

  getZ(): number { return this._z; }

  setTileRadius(R: number): void {
    if (this._tileRadius === R) return;
    this._tileRadius = R;
    this.invalidateLayout();
  }

  getTileRadius(): number { return this._tileRadius; }

  // ─── Zone management ─────────────────────────────────────────────────────

  /**
   * Synchronise Zone children with client_zones for the current z layer.
   * Call after any zone is added, removed, or if the z layer changes.
   */
  syncZones(): void {
    const active = new Set<ZoneId>();

    for (const key of Object.keys(client_zones)) {
      const zone_id = Number(key) as ZoneId;
      const data    = client_zones[zone_id];
      if (!data || data.z !== this._z) continue;

      active.add(zone_id);

      if (!this._zones.has(zone_id)) {
        const zone = new Zone({ zone_id });
        this._zones.set(zone_id, zone);
        this.addLayoutChild(zone);
      }
    }

    // Remove zones absent from client_zones or on a different z layer.
    for (const [zone_id, zone] of this._zones) {
      if (!active.has(zone_id)) {
        this.removeLayoutChild(zone);
        this._zones.delete(zone_id);
      }
    }

    this.invalidateLayout();
  }

  /** Return the Zone for a given zone_id, or undefined if not loaded. */
  getZone(zone_id: ZoneId): Zone | undefined {
    return this._zones.get(zone_id);
  }

  // ─── Overlay children ────────────────────────────────────────────────────

  /**
   * Add a non-tile child (player, moving card, etc.) to the world.
   * Its setLayout() calls should use world pixel coordinates.
   * Call invalidateOverlays() whenever the child is repositioned outside of a
   * layout pass so the hex-coverage index stays accurate.
   */
  addOverlay<T extends LayoutObject>(child: T, depth = 1): T {
    this._overlayChildren.add(child);
    this._overlayDirty = true;
    this.addLayoutChild(child, depth);
    return child;
  }

  /**
   * Notify World that one or more overlay children have moved since the last
   * layout pass. The coverage index will be rebuilt before the next hit test.
   */
  invalidateOverlays(): void {
    this._overlayDirty = true;
  }

  override removeLayoutChild<T extends LayoutObject>(child: T): T | null {
    if (this._overlayChildren.has(child)) {
      this._overlayChildren.delete(child);
      // Evict from all hex-coverage sets immediately so same-frame hit tests
      // do not return a stale reference.
      for (const set of this._overlayAtHex.values()) set.delete(child);
      for (const [key, set] of this._overlayAtHex) {
        if (set.size === 0) this._overlayAtHex.delete(key);
      }
    }
    return super.removeLayoutChild(child);
  }

  // ─── Camera helpers ──────────────────────────────────────────────────────

  /**
   * Pan so that world hex (world_q, world_r) is centred in the viewport.
   * Requires a valid innerRect (call after layout has run).
   */
  centerOnHex(world_q: number, world_r: number): void {
    const R  = this._tileRadius;
    const cx = world_q * 1.5 * R;
    const cy = world_r * SQRT3 * R + ((world_q & 1) !== 0 ? SQRT3 / 2 * R : 0);
    this.centerOn(cx, cy);
  }

  // ─── Layout ──────────────────────────────────────────────────────────────

  protected override updateLayoutChildren(): void {
    const R    = this._tileRadius;
    const hexH = SQRT3 * R;

    for (const [zone_id, zone] of this._zones) {
      const { zone_q, zone_r } = unpackZone(zone_id);
      const px = (zone_q * ZONE_SIZE * 1.5 - 1) * R;
      const py = (zone_r * ZONE_SIZE - 0.5)      * hexH;
      zone.setLayout(px, py, 12.5 * R, 8.5 * hexH);
    }

    // Zone pixel positions changed; the overlay hex-coverage index is stale.
    this._overlayDirty = true;
  }

  // ─── Hit test ────────────────────────────────────────────────────────────

  /**
   * Hit test that checks overlay children before tiles.
   *
   * Algorithm:
   *   1. Convert cursor to world pixel space (undo camera offset).
   *   2. Convert world pixel → world hex via cube-coordinate math.
   *   3. Walk overlay candidates registered at that hex.
   *   4. Fall through to the Zone at that hex → Tile → this.
   */
  override hitTestLayout(globalX: number, globalY: number, ignore?: ReadonlySet<LayoutObject>): LayoutObject | null {
    if (ignore?.has(this)) return null;

    const local = this.toLocal(new Point(globalX, globalY));
    if (!this.innerRect.contains(local.x, local.y)) return null;

    if (this._overlayDirty) this._rebuildOverlayIndex();

    // Undo the camera transform to reach world pixel coordinates.
    const cam = this.getCamera();
    const wx  = local.x - this.innerRect.x + cam.x;
    const wy  = local.y - this.innerRect.y + cam.y;

    const hex = this._worldPixelToHex(wx, wy);
    if (!hex) return this;

    const { q: world_q, r: world_r } = hex;

    // ── Overlays (above tiles) ───────────────────────────────────────────
    const candidates = this._overlayAtHex.get(posKey(world_q, world_r));
    if (candidates?.size) {
      for (const overlay of candidates) {
        if (!overlay.visible) continue;
        const hit = overlay.hitTestLayout(globalX, globalY, ignore);
        if (hit) return hit;
      }
    }

    // ── Zone → Tile ──────────────────────────────────────────────────────
    const zone_q  = Math.floor(world_q / ZONE_SIZE);
    const zone_r  = Math.floor(world_r / ZONE_SIZE);
    const zone_id = packZone(zone_q, zone_r, this._z);
    const zone    = this._zones.get(zone_id);
    if (zone?.visible) {
      return zone.hitTestLayout(globalX, globalY, ignore) ?? this;
    }

    return this;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  /**
   * Convert world pixel coordinates to the nearest world hex cell (q, r).
   *
   * World pixel space: center of hex (q, r) sits at
   *   (q·1.5·R,  r·√3·R + odd(q)·√3/2·R)
   * Inverted via the flat-top pixel→axial formula, cube-coordinate rounding,
   * then axial→odd-q offset conversion.
   */
  private _worldPixelToHex(wx: number, wy: number): { q: number; r: number } | null {
    const R = this._tileRadius;
    if (R <= 0) return null;

    const nx = wx / R;
    const ny = wy / R;

    const qf = nx * (2 / 3);
    const rf = nx * (-1 / 3) + ny / SQRT3;
    const sf = -qf - rf;

    let q = Math.round(qf);
    let r = Math.round(rf);
    const s = Math.round(sf);

    const dq = Math.abs(q - qf);
    const dr = Math.abs(r - rf);
    const ds = Math.abs(s - sf);

    if (dq > dr && dq > ds) {
      q = -r - s;
    } else if (dr > ds) {
      r = -q - s;
    }

    // axial → odd-q offset:  offset_r = axial_r + floor(axial_q / 2)
    return { q, r: r + (q >> 1) };
  }

  /**
   * Rebuild the hex-coverage index for all overlay children.
   *
   * Five points are sampled in world pixel space (four corners + centre).
   * Each maps to a world hex cell; the child is registered under every distinct
   * cell found, so overlays spanning hex boundaries are reachable from either side.
   */
  private _rebuildOverlayIndex(): void {
    this._overlayAtHex.clear();
    this._overlayDirty = false;

    for (const child of this._overlayChildren) {
      const lx = child.position.x;
      const ly = child.position.y;
      const rw = child.outerRect.width;
      const rh = child.outerRect.height;

      const points: [number, number][] = [
        [lx,          ly         ],  // top-left
        [lx + rw,     ly         ],  // top-right
        [lx,          ly + rh    ],  // bottom-left
        [lx + rw,     ly + rh    ],  // bottom-right
        [lx + rw / 2, ly + rh / 2], // centre
      ];

      const seen = new Set<number>();

      for (const [px, py] of points) {
        const hex = this._worldPixelToHex(px, py);
        if (!hex) continue;

        const key = posKey(hex.q, hex.r);
        if (seen.has(key)) continue;
        seen.add(key);

        let set = this._overlayAtHex.get(key);
        if (!set) { set = new Set(); this._overlayAtHex.set(key, set); }
        set.add(child);
      }
    }
  }
}
