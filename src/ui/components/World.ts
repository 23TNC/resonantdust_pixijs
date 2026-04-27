import { Point } from "pixi.js";
import {
  client_cards,
  macro_location_cards,
  client_zones,
  packMacroWorld,
  zoneQFromMacro,
  zoneRFromMacro,
  ZONE_SIZE,
  SURFACE_WORLD,
  type CardId,
  type MacroLocation,
} from "@/spacetime/Data";
import { LayoutObject } from "@/ui/layout/LayoutObject";
import { LayoutViewport, type LayoutViewportOptions } from "@/ui/layout/LayoutViewport";
import {
  type InputManager,
  type InputPointerData,
  type InputDragMoveData,
  type InputActionData,
} from "@/ui/input/InputManager";
import { Zone } from "./Zone";
import { CardStack } from "./CardStack";
import { Tile } from "./Tile";

const SQRT3 = Math.sqrt(3);

const DEFAULT_TITLE_H = 24;
const DEFAULT_CARD_H  = 120;
const DEFAULT_STACK_W = 80;

// Pack two 16-bit signed integers into a 32-bit key for Map lookup.
// Valid for world_q/world_r in [-32768, 32767].
function posKey(q: number, r: number): number {
  return ((q & 0xffff) << 16) | (r & 0xffff);
}

export interface WorldOptions extends LayoutViewportOptions {
  z?:           number;
  tileRadius?:  number;
  titleHeight?: number;
  cardHeight?:  number;
  stackWidth?:  number;
  input?:       InputManager;
}

/**
 * Main game board. Extends LayoutViewport so the hex world can be panned and
 * clipped to the screen rect.
 *
 * Zone management:
 *   Call syncZones() whenever client_zones changes. World maintains one Zone
 *   child per entry in client_zones whose layer matches _z. Each Zone is placed
 *   at its world-space pixel rect; the camera transform in LayoutViewport maps
 *   world pixels to screen pixels.
 *
 * Card overlay:
 *   World maintains one CardStack child per qualifying client_card. A card
 *   qualifies when its zone is one of the managed zones, surface === SURFACE_WORLD,
 *   and it is not dragging, returning, hidden, or stacked. The stack is
 *   centered on world hex (world_q, world_r) = (zone_q*8 + local_q, zone_r*8 + local_r).
 *   Reconciliation runs in updateLayoutChildren so any invalidateLayout() keeps
 *   the displayed set consistent.
 *
 * Overlay children (players, animating cards):
 *   Register via addOverlay(). Unlike tile children, overlays may span zone
 *   boundaries, so they are tracked here rather than in Zone. Hit testing checks
 *   the World overlay index before falling through to Zone → Tile.
 *   Call invalidateOverlays() whenever an overlay's position changes outside of
 *   a layout pass so the hex-coverage index stays accurate.
 *
 * Geometry (pointy-top hex, circumradius R, odd-r offset convention):
 *   Zone (zone_q, zone_r) covers world hexes
 *     q ∈ [zone_q·8, zone_q·8+7],  r ∈ [zone_r·8, zone_r·8+7].
 *
 *   Pixel rect of the zone in world space:
 *     left   = (zone_q·8  − ½) · √3·R
 *     top    = (zone_r·12 − 1) · R
 *     width  = 8.5  · √3·R
 *     height = 12.5 · R
 *
 *   Pixel centre of world hex (world_q, world_r):
 *     cx = world_q · √3·R  +  (odd(world_r) ? √3/2·R : 0)
 *     cy = world_r · 1.5 · R
 */
export class World extends LayoutViewport {
  private _z:           number;
  private _tileRadius:  number;
  private readonly _titleHeight: number;
  private readonly _cardHeight:  number;
  private readonly _stackWidth:  number;

  private readonly _zones  = new Map<MacroLocation, Zone>();
  private readonly _stacks = new Map<CardId, CardStack>();

  // ─── Overlay index ───────────────────────────────────────────────────────
  // Non-zone layout children (players, moving cards …) registered by the world
  // hex cells they visually cover.  The key is posKey(world_q, world_r).
  private readonly _overlayChildren = new Set<LayoutObject>();
  private readonly _overlayAtHex   = new Map<number, Set<LayoutObject>>();
  private          _overlayDirty   = false;

  // ─── Pan state ───────────────────────────────────────────────────────────
  private          _input:       InputManager | null;
  private          _panning    = false;
  private          _panPrevX   = 0;
  private          _panPrevY   = 0;
  private          _downTarget: LayoutObject | null = null;

  private readonly _boundPanDown:  (data: InputPointerData)  => void;
  private readonly _boundPanStart: (data: InputPointerData)  => void;
  private readonly _boundPanMove:  (data: InputDragMoveData) => void;
  private readonly _boundPanEnd:   (data: InputActionData)   => void;

  // ─────────────────────────────────────────────────────────────────────────

  constructor(options: WorldOptions = {}) {
    super(options);
    this._z           = options.z           ?? 1;
    this._tileRadius  = options.tileRadius  ?? 16;
    this._titleHeight = options.titleHeight ?? DEFAULT_TITLE_H;
    this._cardHeight  = options.cardHeight  ?? DEFAULT_CARD_H;
    this._stackWidth  = options.stackWidth  ?? DEFAULT_STACK_W;

    this._boundPanDown  = this._onPanDown.bind(this);
    this._boundPanStart = this._onPanStart.bind(this);
    this._boundPanMove  = this._onPanMove.bind(this);
    this._boundPanEnd   = this._onPanEnd.bind(this);

    this._input = options.input ?? null;
    if (this._input) {
      this._input.on("left_down",       this._boundPanDown);
      this._input.on("left_drag_start", this._boundPanStart);
      this._input.on("left_drag_move",  this._boundPanMove);
      this._input.on("left_drag_end",   this._boundPanEnd);
    }
  }

  override destroy(options?: Parameters<LayoutObject["destroy"]>[0]): void {
    if (this._input) {
      this._input.off("left_down",       this._boundPanDown);
      this._input.off("left_drag_start", this._boundPanStart);
      this._input.off("left_drag_move",  this._boundPanMove);
      this._input.off("left_drag_end",   this._boundPanEnd);
    }
    super.destroy(options);
  }

  // ─── Configuration ───────────────────────────────────────────────────────

  setInput(input: InputManager | null): void {
    if (this._input) {
      this._input.off("left_down",       this._boundPanDown);
      this._input.off("left_drag_start", this._boundPanStart);
      this._input.off("left_drag_move",  this._boundPanMove);
      this._input.off("left_drag_end",   this._boundPanEnd);
    }
    this._input = input;
    if (input) {
      input.on("left_down",       this._boundPanDown);
      input.on("left_drag_start", this._boundPanStart);
      input.on("left_drag_move",  this._boundPanMove);
      input.on("left_drag_end",   this._boundPanEnd);
    }
  }

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
    const active = new Set<MacroLocation>();

    for (const [macro, data] of client_zones) {
      if (data.layer !== this._z) continue;

      active.add(macro);

      if (!this._zones.has(macro)) {
        const zone = new Zone({ zone_id: macro });
        this._zones.set(macro, zone);
        this.addLayoutChild(zone);
      }
    }

    // Remove zones absent from client_zones or on a different z layer.
    for (const [macro, zone] of this._zones) {
      if (!active.has(macro)) {
        this.removeLayoutChild(zone);
        this._zones.delete(macro);
      }
    }

    this.invalidateLayout();
  }

  /** Return the Zone for a given macro_location, or undefined if not loaded. */
  getZone(macro: MacroLocation): Zone | undefined {
    return this._zones.get(macro);
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
    const cx = world_q * SQRT3 * R + ((world_r & 1) !== 0 ? SQRT3 / 2 * R : 0);
    const cy = world_r * 1.5 * R;
    this.centerOn(cx, cy);
  }

  // ─── Layout ──────────────────────────────────────────────────────────────

  protected override updateLayoutChildren(): void {
    const R    = this._tileRadius;
    const hexW = SQRT3 * R;

    // ── Zones ────────────────────────────────────────────────────────────
    for (const [macro, zone] of this._zones) {
      const zone_q = zoneQFromMacro(macro);
      const zone_r = zoneRFromMacro(macro);
      const px = (zone_q * ZONE_SIZE - 0.5)       * hexW;
      const py = (zone_r * ZONE_SIZE * 1.5 - 1)   * R;
      zone.setLayout(px, py, 8.5 * hexW, 12.5 * R);
    }

    // ── Card stacks ──────────────────────────────────────────────────────
    const roots = this._findRoots();

    for (const [rootId, stack] of this._stacks) {
      if (!roots.has(rootId)) {
        this._stacks.delete(rootId);
        this.removeLayoutChild(stack);
        stack.destroy({ children: true });
      }
    }

    for (const rootId of roots) {
      if (!this._stacks.has(rootId)) {
        const stack = new CardStack({ titleHeight: this._titleHeight });
        stack.setCardId(rootId);
        this._stacks.set(rootId, stack);
        this.addOverlay(stack);
      }
    }

    for (const [rootId, stack] of this._stacks) {
      const card = client_cards[rootId];
      if (!card) continue;
      const cx = card.world_q * hexW + ((card.world_r & 1) !== 0 ? hexW / 2 : 0);
      const cy = card.world_r * 1.5 * R;
      // Stacks further south (larger world_r) render in front of northern ones.
      // 0x10000 base keeps all stacks above zones (depth 0).
      this.setChildDepth(stack, 0x10000 + card.world_r);
      stack.setLayout(cx - this._stackWidth / 2, cy - this._cardHeight / 2, this._stackWidth, this._cardHeight);
    }

    // Zone and stack positions changed; coverage index is stale.
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
    if (!hex) return this._hitSelf ? this : null;

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
    const macro = packMacroWorld(zone_q, zone_r, this._z);
    const zone  = this._zones.get(macro);
    if (zone?.visible) {
      return zone.hitTestLayout(globalX, globalY, ignore) ?? (this._hitSelf ? this : null);
    }

    return this._hitSelf ? this : null;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _findRoots(): Set<CardId> {
    const roots = new Set<CardId>();
    for (const macro of this._zones.keys()) {
      const set = macro_location_cards.get(macro);
      if (!set) continue;
      for (const card_id of set) {
        const card = client_cards[card_id];
        if (!card)                                continue;
        if (card.surface !== SURFACE_WORLD)       continue;
        if (card.dragging)                        continue;
        if (card.returning)                       continue;
        if (card.hidden)                          continue;
        if (card.stacked_up || card.stacked_down) continue;
        if (card.card_type === 6)                 continue;
        roots.add(card_id);
      }
    }
    return roots;
  }

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

    const qf = nx / SQRT3 - ny / 3;
    const rf = ny * (2 / 3);
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

    // axial → odd-r offset:  offset_q = axial_q + floor(axial_r / 2)
    return { q: q + (r >> 1), r };
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
      const lx = child.position.x + child.outerRect.x;
      const ly = child.position.y + child.outerRect.y;
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

  // ─── Pan handlers ────────────────────────────────────────────────────────

  private _onPanDown(data: InputPointerData): void {
    this._downTarget = data.target;
  }

  private _onPanStart(data: InputPointerData): void {
    if (this._downTarget !== null && !(this._downTarget instanceof Tile)) return;
    this._panning  = true;
    this._panPrevX = data.x;
    this._panPrevY = data.y;
  }

  private _onPanMove(data: InputDragMoveData): void {
    if (!this._panning) return;
    this.panBy(-(data.x - this._panPrevX), -(data.y - this._panPrevY));
    this._panPrevX = data.x;
    this._panPrevY = data.y;
  }

  private _onPanEnd(_data: InputActionData): void {
    this._panning = false;
  }
}
