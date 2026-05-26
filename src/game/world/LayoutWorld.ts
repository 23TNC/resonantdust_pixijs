import { Container, Graphics, type RenderTexture, Sprite, Texture } from "pixi.js";
import type { GameContext } from "../../GameContext";
import { LayoutNode } from "../layout/LayoutNode";
import type { LayoutManager } from "../layout/LayoutManager";
import { debug } from "../../debug";
import { WORLD_HEX_HEIGHT, WORLD_HEX_RADIUS, WORLD_HEX_WIDTH } from "./hexSize";
import { getTextureRegistry, type TextureDefinition } from "../definitions/TextureRegistry";
import { decodeZoneTiles, unpackMacroZone, WORLD_LAYER } from "./worldCoords";
import { unpackZoneId } from "../../server/data/packing";
import { getStackedState, STACKED_LOOSE } from "../cards/cardData";
import { localPlayerFactionFolder } from "../../server/player/playerFlags";

/** `card_type` value reserved for tile-cards (promoted zone tiles).
 *  Mirrors the constant in `gc.rs` / `world_gen.rs` /
 *  `movement.rs::TILE_CARD_TYPE`. Source of truth lives in
 *  `content/cards/types.json` (`tile` = 7). See
 *  `docs/TILE_AS_CARD.md`. */
const TILE_CARD_TYPE = 7;

const BG_COLOR = "#0d1218";

/** Number of decorative sprites placed per tile that has an object
 *  aspect. >1 fans them around the tile centre in a ring. */
const OBJECTS_PER_TILE = 3;

/** Fast integer hash → uint32. Used to seed per-tile texture picks and
 *  per-sprite scale variation. Stable across syncs since the inputs
 *  are world-hex coordinates that don't change as the camera pans. */
function hash(a: number, b: number, c: number): number {
  let h = ((a * 92821) ^ (b * 31337) ^ (c * 7919)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  return h;
}

/** Deterministic starting angle (radians) for a tile's object ring, so
 *  every tile's three objects rotate uniformly together but different
 *  tiles get different orientations. Caller adds this to
 *  `2π * n / OBJECTS_PER_TILE` for each `n`. Hash seed is offset past
 *  the ones used for texture pick / scale so they don't correlate. */
function tileAngleOffset(q: number, r: number): number {
  return (hash(q, r, OBJECTS_PER_TILE * 2) / 0x1_0000_0000) * 2 * Math.PI;
}

/** Maximum stock per definition slot (matches the u2 width on
 *  `stock0` / `stock1`). The tile's full "instance roster" is
 *  `MAX_STOCK_PER_SLOT * def.stock.length` long regardless of current
 *  stock — that fixed length is what gives slot stability. */
const MAX_STOCK_PER_SLOT = 3;

/** Per-instance hash seed bases. Each tile builds a fixed-length
 *  "instance roster" sized by the definition (not by current stock),
 *  so per-instance properties (scale variation, texture seed) need
 *  seeds keyed off the instance's roster index — that's what stays
 *  stable when stock decreases. Bands sit past everything else
 *  (slot permutation tops out at ~102) with room to spare. */
const INSTANCE_SCALE_SEED_BASE = 128;
const INSTANCE_TEX_SEED_BASE   = 144;

/** Hash seed band for [`ringAngleJitter`]. Past permutation (16-21 at
 *  max stock); 32 leaves headroom. */
const RING_ANGLE_JITTER_SEED_BASE = 32;

/** Per-sprite angle wiggle, expressed as a fraction of the inter-slot
 *  gap (`2π / totalSprites`). `0.5` means each sprite can wiggle up to
 *  half the gap in either direction — at which point neighbouring
 *  slots' wiggle windows are tangent, the theoretical maximum before
 *  sprites can trade slots. Tune downward if the result reads as too
 *  chaotic; this is the headroom ceiling, not necessarily the look
 *  you want. */
const RING_ANGLE_JITTER_FRACTION = 0.25;

/** Deterministic per-sprite angle wiggle in
 *  `[-fraction * slotGap, +fraction * slotGap]`, where `slotGap =
 *  2π / totalSprites`. Distance stays fixed (no centre bias), and
 *  with fraction < 0.5 the wiggle windows don't overlap, so sprites
 *  can't trade slots or cluster. */
function ringAngleJitter(q: number, r: number, n: number, totalSprites: number): number {
  const u = hash(q, r, RING_ANGLE_JITTER_SEED_BASE + n) / 0x1_0000_0000;
  const slotGap = (2 * Math.PI) / totalSprites;
  return (u * 2 - 1) * RING_ANGLE_JITTER_FRACTION * slotGap;
}

/** Fixed per-tile slot layout: 1 centre + 6 evenly-spaced ring slots
 *  (60° apart). Total = 7. Sprites fill slots in the order chosen by
 *  [`slotPermutation`]; the first `totalSprites` of that permutation
 *  are used. When stock decreases the *trailing* slots drop away, so
 *  remaining sprites keep their positions instead of getting
 *  re-distributed. Slot 0 is the centre; slots 1-6 are on the ring. */
const FIXED_SLOT_COUNT = 7;
const RING_SLOT_COUNT  = FIXED_SLOT_COUNT - 1; // 6 ring slots

/** Hash seed band for [`slotPermutation`]. Past angle jitter
 *  (32-37 at max stock); 96 leaves headroom. */
const SLOT_PERMUTATION_SEED_BASE = 96;

/** Deterministic permutation of `[0, FIXED_SLOT_COUNT)` keyed by
 *  `(q, r)`. Same shape as [`ringPermutation`]: returned as a fresh
 *  array, stable across syncs. Sprite `n` (`0 <= n < totalSprites`)
 *  occupies slot `slotPermutation(q, r)[n]`; trailing entries
 *  represent slots that would be filled if the tile had more stock. */
function slotPermutation(q: number, r: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < FIXED_SLOT_COUNT; i++) out.push(i);
  out.sort((a, b) => hash(q, r, SLOT_PERMUTATION_SEED_BASE + a) - hash(q, r, SLOT_PERMUTATION_SEED_BASE + b));
  return out;
}

/** Angle range (degrees, screen Y-down convention so 90° points down)
 *  that counts as the "bottom" half for the overlay snapshot filter.
 *  The "top" range is the same window rotated 180°. Tuneable —
 *  narrower means fewer same-tile objects render in front of the card
 *  but cleaner separation between in-front and behind. */
const BOTTOM_HALF_MIN_DEG = 40;
const BOTTOM_HALF_MAX_DEG = 140;
const BOTTOM_HALF_MIN_RAD = (BOTTOM_HALF_MIN_DEG * Math.PI) / 180;
const BOTTOM_HALF_MAX_RAD = (BOTTOM_HALF_MAX_DEG * Math.PI) / 180;

/**
 * Hit-passthrough panning surface for world cards.
 *
 * Cards added here keep raw world-space pixel coordinates via
 * `LayoutCard.setTarget(x, y)` — the surface itself sits at
 * `LayoutWorld.worldToLocal(0, 0)` in its parent's frame, so the surface's
 * PIXI transform carries the cards along when the viewport pans. The
 * override of `hitTestLayout` translates the parent-local pointer coord
 * into the surface's own frame before recursing; `_x` / `_y` (set by
 * `setBounds` from `LayoutWorld.layout()`) match the surface's position
 * so the translation is correct.
 *
 * Doesn't add itself to its own intersects test — pointer events fall
 * through onto cards (or pass entirely through to the world tile layer
 * underneath) rather than being captured by the empty surface.
 */
class WorldCardSurface extends LayoutNode {
  override hitTestLayout(parentX: number, parentY: number): LayoutNode | null {
    const localX = parentX - this.x;
    const localY = parentY - this.y;
    for (let i = this.children.length - 1; i >= 0; i--) {
      const hit = this.children[i].hitTestLayout(localX, localY);
      if (hit) return hit;
    }
    return null;
  }
}

/**
 * Pointy-top hex tile grid view of the world.
 *
 * Each `Zone` row (a `ValidAtTable` entry on `data.zones`) encodes an
 * 8×8 block of tile definitions in its `t0..t7` packed columns. The
 * view caches decoded tile-by-tile data in `tileData` keyed by
 * `"${q},${r}"` (world-absolute hex coords). On every layout pass it
 * walks the visible hex range, looks up each `(q, r)` in the cache,
 * and assigns a tile sprite from the pool — falling back to
 * `EMPTY_TILE_PACKED` for hexes whose containing zone hasn't loaded
 * (or whose tile slot is `definition_id = 0`).
 *
 * Viewport panning is driven by `ZoneManager.onAnchorChange("viewport")`.
 * The anchor stores world-hex `(q, r)`; `worldToLocal(0, 0)` resolves
 * to the on-screen pixel position the origin hex maps to. Cards are
 * children of `worldCardSurface`, which is positioned at
 * `worldToLocal(0, 0)` — they pan with the viewport for free.
 *
 * Subscriptions:
 * - `zones.onAdded("active")` / `zones.onRemoved("active")`: register /
 *   unregister this view's `worldCardSurface` with the `LayoutManager`
 *   for every world-layer zone. Hex cards landing on those zones find
 *   their parent surface via `surfaceFor(zoneId)`.
 * - `data.zones.subscribe(...)`: tile cache hydration on insert /
 *   update / remove. Hydrate from the existing `data.zones.current`
 *   snapshot at construction.
 * - `zones.onAnchorChange(...)`: viewport `(viewQ, viewR)` tracker.
 */
export class LayoutWorld extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly tileLayer = new Container();
  private readonly objectContainer: Container;
  private readonly worldCardSurface = new WorldCardSurface();
  /** Debug overlay drawn above the tile layer. Currently used to
   *  ring tiles whose `(packed, stocks)` came from a `cardsLocal`
   *  tile-card (`card_type == 7`) rather than the zone-derived
   *  `tileData` cache — helps diagnose tile-card sizing /
   *  parenting bugs at a glance. Cleared and repainted every
   *  `layout()` pass. */
  private readonly debugOverlay = new Graphics();

  /** Pixi container that holds world cards and pans with the
   *  viewport (positioned each frame at `worldToLocal(0, 0)`).
   *  Exposed so view-layer extras like the movement-arrow overlay
   *  can attach overlays in the same hex-pixel coord space cards
   *  use, without re-implementing the pan transform. Children added
   *  here render *above* tiles and *interleaved* with cards (z-order
   *  follows add order; arrows added after a card draw on top of
   *  it). */
  get worldOverlayContainer(): Container {
    return this.worldCardSurface.container;
  }
  private readonly spritePool: Sprite[] = [];
  private readonly activeSprites: Sprite[] = [];

  /** Flat tile cache keyed by `"${q},${r}"`. Each entry carries the
   *  packed definition id plus the two row-mutable stock counters
   *  (0..=3 each, indexed by the tile def's `stock` slot order).
   *  Missing entries render as `EMPTY_TILE_PACKED`. */
  private readonly tileData = new Map<
    string,
    { packed: number; stock0: number; stock1: number }
  >();

  private viewQ = 0;
  private viewR = 0;

  private readonly unsubAnchor: () => void;
  private readonly unsubZones: () => void;
  private readonly unsubCards: () => void;
  private readonly unsubZoneAdded: () => void;
  private readonly unsubZoneRemoved: () => void;
  private readonly unsubObjectLoad: () => void;
  private readonly tileChangeListeners = new Set<() => void>();

  /** ZoneManager anchor name this view tracks for its (q, r)
   *  viewport. Singleton instances pass `"viewport"`; per-panel
   *  instances (multiple game-view panels open at once) pass
   *  `"viewport:<panelId>"` so each panel anchors zones around its
   *  own viewport independently. Stored so destroy can clear the
   *  matching anchor if the panel doesn't outlive this view. */
  readonly viewportAnchorName: string;

  /** Surface this view renders. World panels start at `WORLD_LAYER`
   *  (the default); player-dim panels start at
   *  `PLAYER_DIMENSION_LAYER`. Mutable via [`setSurface`] so a
   *  single panel can be re-pointed at a different surface
   *  (e.g., the 👁-on-soul jump in `OwnedCardsPanel`). Used to
   *  filter incoming card/zone rows to this view's surface, and to
   *  gate `worldCardSurface` registration so each LayoutWorld only
   *  registers itself for zones on its own layer. */
  surface: number;

  /** Stored for [`setSurface`] — we need `LayoutManager` to
   *  re-register `worldCardSurface` against the new surface's
   *  active zones. `ctx` is available via the inherited
   *  `LayoutNode.ctx` getter once `setContext` has propagated, so
   *  we don't store it ourselves. */
  private readonly layoutManagerRef: LayoutManager;

  constructor(
    ctx: GameContext,
    layoutManager: LayoutManager,
    viewportAnchorName: string = "viewport",
    surface: number = WORLD_LAYER,
  ) {
    super();
    this.viewportAnchorName = viewportAnchorName;
    this.surface = surface;
    this.layoutManagerRef = layoutManager;

    // Container z-order: bg < tileLayer < objectLayer < worldCardSurface.
    // bg is the dark backdrop; tileLayer holds tile sprites; objectLayer
    // holds decorative object sprites (trees, rocks) that sit above tiles
    // but below world cards; cards live in worldCardSurface on top.
    //
    // No clip mask: GameLayout draws the world view first and the
    // title bar / inventory views after, so any world content that
    // bleeds outside the world's rect (e.g. a world card whose
    // viewport-pan position drifts past the edge) gets covered by
    // the adjacent views. The masked-clip path costs ~2 extra draw
    // calls; the over-draw cost of letting world bleed get painted
    // and then overwritten is cheaper.
    this.objectContainer = ctx.objects.createContainer();
    this.container.addChild(this.bg);
    this.container.addChild(this.tileLayer);
    this.container.addChild(this.objectContainer);

    // Wire worldCardSurface into the LayoutNode tree manually — we
    // want its PIXI container to sit on top of tileLayer for z-order,
    // but the surface is also a logical child for hit-testing /
    // layout-tree walks.
    this.worldCardSurface.parent = this;
    this.children.push(this.worldCardSurface);
    this.container.addChild(this.worldCardSurface.container);

    // Debug overlay on top of everything except drag previews
    // (MainLayout's overlay still wins via its high zIndex). Stays
    // hit-transparent — it's a raw Graphics, not a LayoutNode, so
    // hit-test ignores it entirely.
    this.container.addChild(this.debugOverlay);

    // Register the card surface for every zone on THIS view's
    // surface that the ZoneManager tracks now and as zones enter /
    // leave "active" tier. Hex cards landing on these zones resolve
    // their parent surface via `LayoutManager.surfaceFor(zoneId)`.
    // The `=== this.surface` check means a world LayoutWorld and a
    // player-dim LayoutWorld can coexist without stealing each
    // other's zone registrations.
    const registerZone = (zoneId: number): void => {
      if (unpackZoneId(zoneId).layer === this.surface) {
        layoutManager.register(zoneId, this.worldCardSurface);
      }
    };
    const unregisterZone = (zoneId: number): void => {
      if (unpackZoneId(zoneId).layer === this.surface) {
        layoutManager.unregister(zoneId);
      }
    };
    for (const zoneId of ctx.zones.zonesIn("active")) registerZone(zoneId);
    for (const zoneId of ctx.zones.zonesIn("hot")) registerZone(zoneId);
    this.unsubZoneAdded = ctx.zones.onAdded("active", registerZone);
    this.unsubZoneRemoved = ctx.zones.onRemoved("active", unregisterZone);

    this.unsubAnchor = ctx.zones.onAnchorChange((name, q, r) => {
      if (name !== this.viewportAnchorName) return;
      this.viewQ = q;
      this.viewR = r;
      this.invalidate();
    });

    // Re-layout once any object texture pack finishes loading. The
    // first sync after a fresh `get` returns null until the pack lands
    // in the atlas; this hook ensures we run a second sync once it's
    // ready instead of waiting for a pan to invalidate us.
    this.unsubObjectLoad = ctx.lodTextures.onLoad(() => this.invalidate());

    // Expose the per-card "in-front objects" snapshot service for hex
    // cards on world surfaces. Cards call this when their (q, r)
    // changes to refresh their alpha-overlay sprite. Scene-scoped:
    // cleared in destroy().
    ctx.worldOverlay = (q, r, target, width, height, offsetX, offsetY) => this.makeObjectOverlayForTile(q, r, target, width, height, offsetX, offsetY);

    // Inverse of `worldToLocal` for the world-card-surface coordinate
    // space — given a pixel (px, py) where (0, 0) is the world hex
    // (0, 0)'s centre (i.e. the same frame `setTarget` uses), returns
    // the nearest axial hex `(q, r)`. Cards use this each frame while
    // dragging or tweening to detect when their visual position
    // crosses a tile boundary and refresh their overlay.
    ctx.worldHexAt = (px, py) => this.worldHexAt(px, py);

    // Tile-change subscription used by cards to refresh their
    // overlay when zone data lands or updates. Fires from the
    // `data.zones.subscribe` callback below.
    ctx.onTilesChanged = (cb) => {
      this.tileChangeListeners.add(cb);
      return () => this.tileChangeListeners.delete(cb);
    };

    // Hydrate tile cache from zones already in `data.zones.current`.
    // Filter by surface so a player-dim LayoutWorld doesn't ingest
    // world tiles (and vice versa) — necessary now that multiple
    // surfaces can have Zone rows in `current` simultaneously.
    for (const zone of ctx.data.zones.current.values()) {
      if (zone.surface !== this.surface) continue;
      for (const tile of decodeZoneTiles(zone, ctx.definitions)) {
        this.tileData.set(`${tile.q},${tile.r}`, {
          packed: tile.packed,
          stock0: tile.stock0,
          stock1: tile.stock1,
        });
      }
    }

    // Deferred re-invalidate one frame after construction. The first
    // layout pass runs synchronously off `LayoutNode`'s initial
    // `selfDirty = true`, but at that moment some inputs may still
    // be settling: zone rows that arrived in `cards.server` but
    // haven't been promoted to `data.zones.current` by `promote()`
    // yet, scene bounds not yet applied by `SceneManager.resize`,
    // texture atlas pages still warming on the renderer. Any of
    // those produce a first frame that renders empty / wrong tiles
    // and then sits idle until the user pans (which fires
    // `onAnchorChange` → invalidate → relayout, masking the bug).
    // One extra invalidate scheduled via the ticker guarantees a
    // re-layout once any one-frame race has resolved.
    ctx.app.ticker.addOnce(() => this.invalidate());

    // Live updates: on every zone insert / update / remove, evict the
    // zone's 8×8 block from `tileData` and re-decode if the row still
    // exists. Cheaper than a full rescan; per-zone diffing isn't worth
    // it for the 64-tile window.
    // Tile-card subscription: post-tile-as-card, a card row at a
    // world hex with `card_type == 7` is the canonical source of
    // truth for tile def + stocks (`docs/TILE_AS_CARD.md`). When
    // such a card lands / mutates / is reaped (demotion), the
    // tile-overlay rendering needs to refresh — invalidate +
    // notify, same as the zone-side subscription below.
    this.unsubCards = ctx.data.cards.subscribe((change) => {
      const row =
        change.kind === "removed" ? change.oldRow
        : change.kind === "added" ? change.row
        : change.newRow;
      if (row.surface !== this.surface) return;
      const cardType = (row.packedDefinition >> 12) & 0xf;
      if (cardType !== TILE_CARD_TYPE) return;
      // Update-on-update only fires when the relevant fields
      // (packed_def / flags_bk stock bits) actually changed; let
      // the cheap render re-decide instead of diffing here.
      this.invalidate();
      for (const cb of this.tileChangeListeners) cb();
    });

    this.unsubZones = ctx.data.zones.subscribe((change) => {
      debug.log(
        ["zone"],
        `[LayoutWorld] zone change kind=${change.kind} key=${change.key}`,
      );
      const zone =
        change.kind === "removed" ? change.oldRow
        : change.kind === "added" ? change.row
        : change.newRow;
      // Filter to this view's surface so a world LayoutWorld
      // doesn't react to player-dim zone changes (and vice versa).
      if (zone.surface !== this.surface) return;
      const { zoneQ, zoneR } = unpackMacroZone(zone.macroZone);
      for (let t = 0; t < 8; t++) {
        for (let b = 0; b < 8; b++) {
          this.tileData.delete(`${zoneQ + b},${zoneR + t}`);
        }
      }
      if (change.kind !== "removed") {
        const newRow = change.kind === "added" ? change.row : change.newRow;
        for (const tile of decodeZoneTiles(newRow, ctx.definitions)) {
          this.tileData.set(`${tile.q},${tile.r}`, {
            packed: tile.packed,
            stock0: tile.stock0,
            stock1: tile.stock1,
          });
        }
      }
      this.invalidate();
      // Notify subscribed cards so their in-front-objects overlay
      // re-bakes against the freshly arrived tile data.
      for (const cb of this.tileChangeListeners) cb();
    });
  }

  /** Re-point this view at a different surface. Unregisters the
   *  `worldCardSurface` from active zones on the OLD surface
   *  (`onAdded("active") → registerZone` only fires for zones
   *  matching the current `this.surface`; without this manual
   *  pass the old-surface zones would leak in `LayoutManager`
   *  until they leave "active"), flips the surface, registers it
   *  for active zones on the NEW surface, clears + re-hydrates
   *  the tile cache, and invalidates.
   *
   *  Caller still needs to update the viewport anchor's surface
   *  via `ZoneManager.setAnchor(name, q, r, surface)` so
   *  `recomputeAnchorZones` swaps the subscribed zones to the new
   *  layer. `GameViewPanel.focusAt` packages both calls together
   *  for the typical "jump to soul" flow.
   *
   *  No-op when `newSurface === this.surface`. */
  setSurface(newSurface: number): void {
    if (newSurface === this.surface) return;
    const oldSurface = this.surface;
    for (const zoneId of this.ctx.zones.zonesIn("active")) {
      if (unpackZoneId(zoneId).layer === oldSurface) {
        this.layoutManagerRef.unregister(zoneId);
      }
    }
    this.surface = newSurface;
    for (const zoneId of this.ctx.zones.zonesIn("active")) {
      if (unpackZoneId(zoneId).layer === newSurface) {
        this.layoutManagerRef.register(zoneId, this.worldCardSurface);
      }
    }
    // Tile cache is keyed by world `(q, r)` — surface-agnostic at
    // the key level, but the VALUES came from the old surface's
    // Zones. Clear and re-hydrate from any new-surface Zones
    // already in `data.zones.current`.
    this.tileData.clear();
    for (const zone of this.ctx.data.zones.current.values()) {
      if (zone.surface !== this.surface) continue;
      for (const tile of decodeZoneTiles(zone, this.ctx.definitions)) {
        this.tileData.set(`${tile.q},${tile.r}`, {
          packed: tile.packed,
          stock0: tile.stock0,
          stock1: tile.stock1,
        });
      }
    }
    this.invalidate();
    for (const cb of this.tileChangeListeners) cb();
  }

  /** World hex `(q, r)` → pixel position in this node's local frame.
   *  Centers the viewport anchor on the node's midpoint; off-axis hexes
   *  fan out from there in pointy-top axial layout. */
  worldToLocal(q: number, r: number): { x: number; y: number } {
    const dq = q - this.viewQ;
    const dr = r - this.viewR;
    return {
      x: this.width / 2 + WORLD_HEX_RADIUS * (Math.sqrt(3) * dq + Math.sqrt(3) / 2 * dr),
      y: this.height / 2 + WORLD_HEX_RADIUS * (3 / 2 * dr),
    };
  }

  /** Inverse of `worldToLocal`. Snaps to the nearest hex via cube-coord
   *  rounding (the naive axial round-then-pick-the-larger-residual
   *  picks the wrong hex on triangle boundaries). */
  localToWorld(localX: number, localY: number): { q: number; r: number } {
    const dx = localX - this.width / 2;
    const dy = localY - this.height / 2;
    const fq = this.viewQ + dx / (WORLD_HEX_RADIUS * Math.sqrt(3)) - dy / (3 * WORLD_HEX_RADIUS);
    const fr = this.viewR + (2 * dy) / (3 * WORLD_HEX_RADIUS);
    // Cube-coordinate rounding for the correct nearest-hex snap.
    const fx = fq;
    const fz = fr;
    const fy = -fq - fr;
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

  private acquireSprite(): Sprite {
    const s = this.spritePool.pop() ?? new Sprite(Texture.EMPTY);
    s.visible = true;
    // Hex textures are baked at HEX_TEXTURE_* dimensions; rescale to
    // the world display size every acquire (cheap, and lets a
    // WORLD_HEX_* change take effect on the next layout pass without
    // touching pooled sprites elsewhere).
    //
    // Oversize by 2px past the ceiled bbox. Why two: the bake's
    // hex polygon has a vertical right edge at bake-x ≈ 124.7
    // inside a 125-wide texture; Pixi's linear-filtered upscale
    // to the display size adds ~1px of AA fringe at that edge.
    // Position rounding (`Math.round` in the layout loop below)
    // makes neighbour spacing alternate between 124 and 125 px in
    // a periodic pattern set by the irrational `√3 * R` step
    // (period ≈ 1 / (√3 mod 1) ≈ 3-4 tiles, which is exactly the
    // beat the seams showed up at). With `ceil + 1` (126), the
    // 125-spacing case leaves 1px of bbox overlap — not enough
    // for both neighbours' AA fringes to land on each other's
    // opaque interior, so the dark BG bleeds through at the seam
    // and the seam visibly migrates with the viewport pan. `ceil
    // + 2` (127) guarantees ≥2px overlap in every case, fully
    // absorbing the AA fringe regardless of which side of the
    // beat each pair lands on. Same reasoning on the height axis
    // for safety even though row spacing has 36px of bbox slack.
    s.setSize(Math.ceil(WORLD_HEX_WIDTH) + 2, Math.ceil(WORLD_HEX_HEIGHT) + 2);
    this.tileLayer.addChild(s);
    this.activeSprites.push(s);
    return s;
  }

  private releaseActiveSprites(): void {
    for (const s of this.activeSprites) {
      s.visible = false;
      this.tileLayer.removeChild(s);
      this.spritePool.push(s);
    }
    this.activeSprites.length = 0;
  }

  protected override layout(): void {
    const w = this.width;
    const h = this.height;

    this.bg.clear();
    this.bg.rect(0, 0, w, h).fill({ color: BG_COLOR });

    this.releaseActiveSprites();
    // Reset the debug overlay; card-sourced tiles in the loop
    // below append rings to it.
    this.debugOverlay.clear();

    // Conservative ring radius: enough hex columns to cover the larger
    // of width / height plus a margin for half-tiles peeking in at the
    // edges. The +2 is a safety margin against rounding.
    const range = Math.ceil(Math.max(w, h) / (WORLD_HEX_RADIUS * Math.sqrt(3))) + 2;
    const baseQ = Math.round(this.viewQ);
    const baseR = Math.round(this.viewR);

    // Tile centre objects (the `def.object` slot — e.g. the alter at
    // the pocket-dimension centre, or building tiles) render in the
    // local player's faction palette. Computed once per layout pass
    // since the local-player row doesn't change per tile. Ring
    // decoration objects intentionally don't take faction — they're
    // world / climate flora that read as part of the landscape rather
    // than as anyone's property. Refine to per-zone-owner lookup if
    // shared dimensions ever need faction-tinted centres.
    const tileFaction = localPlayerFactionFolder(this.ctx) ?? undefined;
    // Hoisted: needed both by the tile body-fill branch (resolving
    // `def.texture`) and by the centre/instance object loop later in
    // the per-tile body. `getTextureRegistry()` returns a cached
    // singleton — repeat calls are cheap, but one binding reads
    // clearer than scattered calls.
    const reg = getTextureRegistry();

    for (let dq = -range; dq <= range; dq++) {
      for (let dr = -range; dr <= range; dr++) {
        const q = baseQ + dq;
        const r = baseR + dr;
        const { x, y } = this.worldToLocal(q, r);

        // Cull off-screen hexes by their bounding box. A more precise
        // hex-vs-rect cull would be cheaper per-tile but more code; the
        // bounding box is fine at typical viewport sizes.
        if (x + WORLD_HEX_WIDTH / 2 < 0 || x - WORLD_HEX_WIDTH / 2 > w) continue;
        if (y + WORLD_HEX_HEIGHT / 2 < 0 || y - WORLD_HEX_HEIGHT / 2 > h) continue;

        const entry = this.tileViewAt(q, r);
        const sprite = this.acquireSprite();
        if (entry !== null) {
          const def = this.ctx.definitions.decode(entry.packed) ?? null;
          // `def.texture` (when set) fills the tile body via the
          // textures pipeline. Faction-aware via the same local-
          // player lookup we use for tile centre objects; faction
          // recursion to neutral happens inside `lodTextures.get`.
          // `null` (no texture ref) keys the bake to the colour-only
          // variant. When the ideal LOD lands (or upgrades from the
          // white-fallback), the `lodTextures.onLoad` subscription
          // re-invalidates and the next layout pass picks the new
          // texture-filled bake. Body-fill aspects are shape-driven
          // — desired size is the world hex's bbox so the LOD picker
          // grabs a bucket large enough to cover-fit without
          // upscaling.
          let bodyTex: Texture | null = null;
          const texRef = def?.texture;
          if (texRef) {
            bodyTex = this.ctx.lodTextures.get(
              texRef.name,
              Math.max(WORLD_HEX_WIDTH, WORLD_HEX_HEIGHT),
              hash(q, r, INSTANCE_TEX_SEED_BASE),
              texRef.index,
              tileFaction,
            );
          }
          sprite.texture = this.ctx.cardTextures.getHex(def, bodyTex);
        } else {
          sprite.texture = this.ctx.cardTextures.getHex(null);
        }
        // Round to integer pixels. Sub-pixel positions smear the
        // hex polygon's anti-aliased edges across two pixel rows /
        // columns, so adjacent hexes can't meet cleanly — even
        // with the size ceiled to overlap, fractional positions
        // re-introduce a faint seam as the viewport pans.
        sprite.position.set(
          Math.round(x - WORLD_HEX_WIDTH / 2),
          Math.round(y - WORLD_HEX_HEIGHT / 2),
        );

        // Debug: ring tiles whose `(packed, stocks)` came from a
        // `cardsLocal` tile-card rather than the zone snapshot.
        // The radius matches the inscribed hex circle so the ring
        // hugs the tile's footprint; misshapen rings (smaller /
        // larger) flag tile-cards being drawn at the wrong scale.
        if (entry?.source === "card") {
          this.debugOverlay
            .circle(x, y, WORLD_HEX_RADIUS)
            .stroke({ color: 0xff0000, width: 2, alpha: 0.9 });
        }
      }
    }

    // Anchor the card surface at the origin hex's pixel position so a
    // card whose `setTarget` carries raw world-relative pixel offsets
    // ends up in the right spot after the surface's PIXI translation.
    const origin = this.worldToLocal(0, 0);
    this.worldCardSurface.setBounds(origin.x, origin.y, w, h);

    // Queue object sprites for every visible tile, sourced from the
    // tile def's `stock` slots. Each slot contributes its row value
    // (0..=3) of sprites — a tile with `wood: 2, stone: 1` renders
    // 2 wood + 1 stone sprite. Defs without `stock` fall back to the
    // legacy per-aspect single-texture path used by non-tile decor.
    // (`reg` is hoisted above so the tile body-fill branch and this
    // loop share one binding.)
    for (let dq = -range; dq <= range; dq++) {
      for (let dr = -range; dr <= range; dr++) {
        const q = baseQ + dq;
        const r = baseR + dr;
        const entry = this.tileViewAt(q, r);
        if (entry === null) continue;
        const def = this.ctx.definitions.decode(entry.packed);
        if (!def) continue;

        // Build the tile's "instance roster": one entry per *potential*
        // object regardless of current stock. The roster length is
        // fixed by the definition (`MAX_STOCK_PER_SLOT * def.stock.length`),
        // so a wood-2/stone-1 tile and a wood-1/stone-0 tile share the
        // same roster shape — they just differ in which entries have
        // `present = true`. That fixed shape + index is what makes the
        // slot assignment stable across stock changes. Legacy stockless
        // defs use `OBJECTS_PER_TILE` copies of their first aspect, all
        // marked present.
        // Ring instances: built from `stock` (per-row mutable
        // counts) or from the legacy `aspects` fallback. These
        // populate the 6 ring slots (1..6) of the 7-slot layout.
        const instances: { tex: TextureDefinition; present: boolean; index?: number }[] = [];
        if (def.stock && def.stock.length > 0) {
          for (let i = 0; i < def.stock.length; i++) {
            const slot = def.stock[i];
            if (!slot) continue;
            const aspectName = this.ctx.definitions.aspectInfo(slot.aspectId)?.name;
            if (!aspectName) continue;
            const tex = reg.find(aspectName);
            if (!tex) continue;
            const cur = i === 0 ? entry.stock0 : entry.stock1;
            if (slot.mode === "index") {
              // Index mode: one sprite per slot, pinned to
              // `_<cur>.png`. Cycling the stock value cycles the
              // visible variant. `cur = 0` → no sprite (matches
              // count mode's empty state). See
              // docs/STOCK_INDEX_MODE.md.
              instances.push({ tex, present: cur > 0, index: cur });
            } else {
              // Count mode (default): N copies for stock = N, each
              // pseudo-randomly picked from the pack. Roster
              // reserves `MAX_STOCK_PER_SLOT` positions per slot so
              // the visible / hidden mix is stable per (q, r).
              for (let k = 0; k < MAX_STOCK_PER_SLOT; k++) {
                instances.push({ tex, present: k < cur });
              }
            }
          }
        } else if (def.aspects) {
          for (const pair of def.aspects) {
            if (!pair) continue;
            const aspectName = this.ctx.definitions.aspectInfo(pair[0])?.name;
            if (!aspectName) continue;
            const tex = reg.find(aspectName);
            if (!tex) continue;
            for (let k = 0; k < OBJECTS_PER_TILE; k++) {
              instances.push({ tex, present: true });
            }
            break;
          }
        }

        // Centre instance — pinned to slot 0 when the def declares
        // an `object`. Falls back to nothing if the referenced
        // aspect isn't renderable (unknown / no `size`). See
        // docs/CARD_OBJECT_UNIFICATION.md (M5).
        let centre: { tex: TextureDefinition; index?: number } | null = null;
        if (def.object) {
          const cTex = reg.find(def.object.name);
          if (cTex) centre = { tex: cTex, index: def.object.index };
        }

        if (instances.length === 0 && !centre) continue;
        let presentCount = centre ? 1 : 0;
        for (const inst of instances) if (inst.present) presentCount++;
        if (presentCount === 0) continue;

        const ringRadius = WORLD_HEX_RADIUS / 2;

        const { x: cx, y: cy } = this.worldToLocal(q, r);
        // Cull only when every sprite's bounding box is fully off-screen.
        // The cluster spans `ringRadius` from the tile centre; each sprite
        // adds its own scaled half-width / anchor-offset on top, so the
        // effective cluster footprint is ringRadius + sprite extent.
        // Anchor is (0.5, 0.75): sprite extends 0.5 to each side
        // horizontally, 0.75 above its position and 0.25 below.
        let maxSpriteSize = 0;
        for (const inst of instances) {
          if (!inst.present) continue;
          const s = inst.tex.size * inst.tex.scale.max;
          if (s > maxSpriteSize) maxSpriteSize = s;
        }
        if (centre) {
          // Card-side `object.scale` overrides the object's declared
          // envelope — use the override here so cull math matches the
          // sprite the renderer will actually draw below.
          const maxScale = def.object?.scale?.max ?? centre.tex.scale.max;
          const s = centre.tex.size * maxScale;
          if (s > maxSpriteSize) maxSpriteSize = s;
        }
        const halfX  = ringRadius + maxSpriteSize * 0.5;
        const topY   = ringRadius + maxSpriteSize * 0.75;
        const botY   = ringRadius + maxSpriteSize * 0.25;
        if (cx + halfX < 0 || cx - halfX > w) continue;
        if (cy + botY < 0 || cy - topY > h) continue;

        // Fixed 7-slot layout (1 centre + 6 ring). When the def
        // carries an `object`, centre (slot 0) is reserved for it
        // and ring instances skip slot 0. When no `object`, the
        // original behaviour: ring instances permute across all
        // 7 slots, leaving slot 0 empty if instance count < 7.
        const slotOrder = centre
          ? slotPermutation(q, r).filter(s => s !== 0)
          : slotPermutation(q, r);
        const startAngle = tileAngleOffset(q, r);

        // Centre instance first, when present. A def carrying a
        // faction sub-aspect (e.g. tile-flavoured chorus variant)
        // overrides the local player's tileFaction so the variant
        // looks the same regardless of who's viewing it. A def's
        // `object.scale` overrides the object's declared scale
        // envelope so the same pack can render at a different size.
        if (centre) {
          const t = hash(q, r, INSTANCE_SCALE_SEED_BASE) / 0x1_0000_0000;
          const scaleEnv = def.object?.scale ?? centre.tex.scale;
          const scale = scaleEnv.min + t * (scaleEnv.max - scaleEnv.min);
          const centreFaction =
            this.ctx.definitions.cardFactionOverride(def) ?? tileFaction;
          this.ctx.objects.add(this.objectContainer, {
            name: centre.tex.name,
            // `tex.size` is the aspect's preferred draw size in px;
            // `ObjectManager` resolves the matching LOD and scales
            // the sprite to render at this size × `scale`.
            desiredSize: centre.tex.size,
            // Index pins a specific variant when set; otherwise the
            // per-tile coordinate hash provides deterministic variance.
            seed: hash(q, r, INSTANCE_TEX_SEED_BASE),
            index: centre.index,
            faction: centreFaction,
            x: cx,
            y: cy,
            scale,
            sortKey: cy,
            anchorX: centre.tex.anchor.x,
            anchorY: centre.tex.anchor.y,
          });
        }

        for (let i = 0; i < instances.length; i++) {
          const inst = instances[i];
          if (!inst.present) continue;
          const slot = slotOrder[i];
          if (slot === undefined) break; // more ring instances than ring slots
          let x: number;
          let y: number;
          if (slot === 0) {
            x = cx;
            y = cy;
          } else {
            const ringN = slot - 1;
            const angle = startAngle + (2 * Math.PI * ringN) / RING_SLOT_COUNT + ringAngleJitter(q, r, ringN, RING_SLOT_COUNT);
            x = cx + Math.cos(angle) * ringRadius;
            y = cy + Math.sin(angle) * ringRadius;
          }
          const t = hash(q, r, INSTANCE_SCALE_SEED_BASE + i + 1) / 0x1_0000_0000;
          const scale = inst.tex.scale.min + t * (inst.tex.scale.max - inst.tex.scale.min);
          this.ctx.objects.add(this.objectContainer, {
            name: inst.tex.name,
            // Per-aspect preferred draw size; LOD picker resolves
            // the matching bucket and the sprite is scaled to
            // render at this size × `scale`.
            desiredSize: inst.tex.size,
            seed: hash(q, r, INSTANCE_TEX_SEED_BASE + i + 1),
            index: inst.index,
            x, y,
            scale,
            sortKey: y,
            anchorX: inst.tex.anchor.x,
            anchorY: inst.tex.anchor.y,
          });
        }
      }
    }
    this.ctx.objects.sync(this.objectContainer);
  }

  /** Render the "in-front objects" snapshot for a card on tile (q, r)
   *  into the caller-provided RenderTexture. Returns true if any
   *  sprite was drawn (false ⇒ no overlay needed for this tile).
   *
   *  The snapshot includes the bottom-half ring objects of the card's
   *  own tile plus the top-half ring objects of the two southern
   *  neighbours (q-1, r+1) and (q, r+1) — the three tiles whose
   *  visible sprites can overlap the card's bounding box.
   *
   *  Coordinate space inside the target RT is overlay-local: origin
   *  at the RT's (0, 0), card centre at (width/2, height/2). World
   *  pixel offsets from the card's tile centre are applied verbatim
   *  (the card sits centred on its world hex, so world deltas map
   *  directly to overlay-local deltas around the centre). */
  /** Convert a global pixel coord (Pixi stage frame) to the axial hex
   *  `(q, r)` underneath it, plus the pixel offset from that point to
   *  the tile's centre in the world-card-surface frame (so when the
   *  caller is exactly centred on the tile, offset is `(0, 0)`).
   *
   *  Works regardless of which parent the caller is mounted under —
   *  during drag the card is re-parented to a global overlay, so its
   *  local position is no longer in the world-card-surface frame.
   *  Going through global → surface-local via `getGlobalPosition()`
   *  keeps both states equivalent. */
  /** Packed tile definition + current stock counters at world hex
   *  `(q, r)`, or `null` if the containing zone hasn't loaded yet
   *  (tile data missing from the cache). Used by the click→details
   *  flow to surface tile details when the user clicks an empty
   *  world hex (no card on it). Stock counters map to the def's
   *  `stock` slot order — `stock0` ↔ `def.stock[0]`.
   *
   *  Card-priority: a promoted tile-card at this hex
   *  (`docs/TILE_AS_CARD.md`) wins over the zone slot — its
   *  `packed_definition` and `flags_bk.tile_stock_{0,1}` reflect
   *  any mid-action mutations (e.g. wood decremented after
   *  cut_tree). Falls back to `zonesLocal` only when no tile-card
   *  resolves. */
  tileAt(q: number, r: number): { packed: number; stock0: number; stock1: number } | null {
    return this.tileViewAt(q, r);
  }

  /** Card-priority `(packed, stock0, stock1)` lookup at hex
   *  `(q, r)`. Consults `cardsLocal` for a Free tile-card at the
   *  hex (matching the zone's `card_type`), else falls back to the
   *  zone-derived `tileData` cache. Returns `null` when neither
   *  resolves (off-map / zone not loaded).
   *
   *  `source` distinguishes which path produced the entry —
   *  `"card"` means a tile-card row in `cardsLocal` mid-action
   *  (mutated by `chain_stitch`), `"zone"` means the resting
   *  zone-derived snapshot. Used by `layout()` to ring card-
   *  sourced tiles in the debug overlay so tile-card sizing /
   *  parenting bugs are visible at a glance. */
  private tileViewAt(
    q: number,
    r: number,
  ): { packed: number; stock0: number; stock1: number; source: "card" | "zone" } | null {
    const tileCard = this.findFreeTileCardAt(q, r);
    if (tileCard !== null) {
      return {
        packed: tileCard.packedDefinition,
        stock0:
          this.ctx.definitions.cardFlagFieldValueIn(
            "cards_bk",
            tileCard.flagsBk,
            "tile_stock_0",
          ) ?? 0,
        stock1:
          this.ctx.definitions.cardFlagFieldValueIn(
            "cards_bk",
            tileCard.flagsBk,
            "tile_stock_1",
          ) ?? 0,
        source: "card",
      };
    }
    const zone = this.tileData.get(`${q},${r}`);
    if (!zone) return null;
    return { ...zone, source: "zone" };
  }

  /** Find a tile-card (`card_type == 7`) whose hex resolves to world
   *  `(q, r)`. Walks every tile-card in `cardsLocal`; for each,
   *  resolves its hex either directly from `microZone` (Free state)
   *  or by chasing the parent-pointer chain to the first Free
   *  ancestor (OnRoot / Slot state — set by chain_stitch when the
   *  tile-card was bound to an action). The orphan case (Free
   *  ancestor reaped by GC before the tile-card was demoted) returns
   *  `null` and the caller falls back to zone data — temporary
   *  staleness that resolves on the next server tile write or the
   *  next GC demote-then-promote cycle. Bounded by total card count
   *  × max chain depth; called per-tile during overlay rendering so
   *  kept tight. */
  private findFreeTileCardAt(q: number, r: number) {
    for (const row of this.ctx.data.cardsLocal.values()) {
      // Match the LayoutWorld instance's own surface. Each LayoutWorld
      // is scoped to a single surface (world, mini-zone, player-dim,
      // …) — a tile-card promotion on a different surface belongs to
      // a different LayoutWorld instance, not this one. The prior
      // hard-coded `WORLD_LAYER` filter dated from when LayoutWorld
      // only served the world surface; left dim tile-cards invisible
      // here (and the zone-tile rendering double-drew over them).
      if (row.surface !== this.surface) continue;
      const cardType = (row.packedDefinition >> 12) & 0xf;
      if (cardType !== TILE_CARD_TYPE) continue;
      const hex = this.resolveTileCardHex(row);
      if (hex === null) continue;
      const { zoneQ, zoneR } = unpackMacroZone(row.macroZone);
      if (zoneQ + hex.q !== q || zoneR + hex.r !== r) continue;
      return row;
    }
    return null;
  }

  /** Resolve a tile-card's local (q, r) within its zone. For Free
   *  tile-cards, read bits 5-7 / 2-4 of `microZone` directly. For
   *  OnRoot / Slot tile-cards (chain_stitch repacked `microZone` as
   *  `[position:4 | direction:2 | state:2]` and lost the original
   *  hex), walk the parent chain to the first Free ancestor and
   *  inherit its (q, r). Returns `null` when the chain dead-ends
   *  (parent reaped) or exceeds the depth cap. */
  private resolveTileCardHex(
    row: { microZone: number; microLocation: number },
  ): { q: number; r: number } | null {
    let cur: { microZone: number; microLocation: number } | undefined = row;
    for (let depth = 0; depth < 32 && cur !== undefined; depth++) {
      if (getStackedState(cur.microZone) === STACKED_LOOSE) {
        return {
          q: (cur.microZone >> 5) & 0x7,
          r: (cur.microZone >> 2) & 0x7,
        };
      }
      cur = this.ctx.data.cardsLocal.get(cur.microLocation);
    }
    return null;
  }

  worldHexAt(
    globalX: number,
    globalY: number,
  ): { q: number; r: number; offsetX: number; offsetY: number } {
    const sg = this.worldCardSurface.container.getGlobalPosition();
    const px = globalX - sg.x;
    const py = globalY - sg.y;
    const fq = px / (WORLD_HEX_RADIUS * Math.sqrt(3)) - py / (3 * WORLD_HEX_RADIUS);
    const fr = (2 * py) / (3 * WORLD_HEX_RADIUS);
    const fy = -fq - fr;
    let rx = Math.round(fq);
    let ry = Math.round(fy);
    let rz = Math.round(fr);
    const ddx = Math.abs(rx - fq);
    const ddy = Math.abs(ry - fy);
    const ddz = Math.abs(rz - fr);
    if (ddx > ddy && ddx > ddz) rx = -ry - rz;
    else if (ddy > ddz) ry = -rx - rz;
    else rz = -rx - ry;
    const tileCenterPx = WORLD_HEX_RADIUS * (Math.sqrt(3) * rx + (Math.sqrt(3) / 2) * rz);
    const tileCenterPy = WORLD_HEX_RADIUS * ((3 / 2) * rz);
    return { q: rx, r: rz, offsetX: tileCenterPx - px, offsetY: tileCenterPy - py };
  }

  makeObjectOverlayForTile(
    q_c: number,
    r_c: number,
    target: RenderTexture,
    width: number,
    height: number,
    offsetX: number = 0,
    offsetY: number = 0,
  ): boolean {
    // Tile centre in overlay-local coords. When the card is exactly
    // centred on its tile, `offsetX/Y` are 0 and the tile centre
    // lands at the overlay's geometric centre. When the card has
    // drifted off-centre (mid-drag, mid-tween), the caller passes
    // the displacement so the snapshot stays anchored to the world
    // hex underneath rather than to the card.
    const tileCenterX = width / 2 + offsetX;
    const tileCenterY = height / 2 + offsetY;
    const dyNeighbor  = 1.5 * WORLD_HEX_RADIUS;
    const dxNeighbor  = WORLD_HEX_WIDTH / 2;

    const dxSide = WORLD_HEX_WIDTH;
    const temp = new Container();
    // Stage every sprite across all 5 contributing tiles, then sort
    // by y and addChild in painter's order. The per-tile angle sweep
    // visits ring positions in `n` order (uniform-jittered startAngle
    // → no guarantee of y-monotonicity), and the implicit "tile call
    // order = z order" used to mean a top-half sprite on a southern
    // neighbour could paint over its own bottom-half neighbours on
    // the same tile. One global y-sort settles both axes at once.
    const staged: { sprite: Sprite; y: number }[] = [];
    // Own tile + same-row neighbours: only the bottom slice (40°-140°)
    // so trees / rocks in those halves can poke "in front of" the card.
    this.placeOverlayObjectsForTile(staged, q_c,     r_c,     tileCenterX,              tileCenterY,              "bottom");
    this.placeOverlayObjectsForTile(staged, q_c - 1, r_c,     tileCenterX - dxSide,     tileCenterY,              "bottom");
    this.placeOverlayObjectsForTile(staged, q_c + 1, r_c,     tileCenterX + dxSide,     tileCenterY,              "bottom");
    // Southern neighbours: every object — anything on either of the two
    // tiles below us can end up in front of the card as we drift south.
    this.placeOverlayObjectsForTile(staged, q_c - 1, r_c + 1, tileCenterX - dxNeighbor, tileCenterY + dyNeighbor, "all");
    this.placeOverlayObjectsForTile(staged, q_c,     r_c + 1, tileCenterX + dxNeighbor, tileCenterY + dyNeighbor, "all");

    if (staged.length > 0) {
      staged.sort((a, b) => a.y - b.y);
      for (const { sprite } of staged) temp.addChild(sprite);
      this.ctx.app.renderer.render({ container: temp, target, clear: true });
    }
    temp.destroy({ children: true });
    return staged.length > 0;
  }

  /** Helper for makeObjectOverlayForTile: build sprites for this
   *  tile's ring objects, positioned around `(centerX, centerY)` in
   *  the overlay's local coords, and push them into `staged` paired
   *  with their final y coordinate. The caller sorts the staged
   *  array by y once across every contributing tile so painter's
   *  order is correct regardless of which tile-call produced any
   *  given sprite.
   *
   *  `half` filters the angle sweep:
   *  - `"bottom"`: angles in the BOTTOM_HALF_*_DEG window (default
   *    40°-140°), the "in front of card" half.
   *  - `"top"`: that same window rotated 180°, the "behind card" half.
   *  - `"all"`: every ring slot; useful for tiles whose objects can
   *    cover any part of the card regardless of angle.
   *
   *  Skips silently if the tile has no aspect-mapped texture or if
   *  the object pack hasn't finished loading yet (the card's
   *  onLoad subscription will trigger a re-snapshot). */
  private placeOverlayObjectsForTile(
    staged: { sprite: Sprite; y: number }[],
    q: number,
    r: number,
    centerX: number,
    centerY: number,
    half: "top" | "bottom" | "all",
  ): void {
    const entry = this.tileViewAt(q, r);
    if (entry === null) return;
    const def = this.ctx.definitions.decode(entry.packed);
    if (!def) return;

    // Build the same fixed-length "instance roster" the main sync
    // uses (lines 477-503) — one entry per *potential* object,
    // tagged with `present` based on the current stock counter.
    // Identical inputs → identical roster → identical slot
    // assignment, so the overlay lines up with the world surface.
    const reg = getTextureRegistry();
    const instances: { tex: TextureDefinition; present: boolean; index?: number }[] = [];
    if (def.stock && def.stock.length > 0) {
      for (let i = 0; i < def.stock.length; i++) {
        const slot = def.stock[i];
        if (!slot) continue;
        const aspectName = this.ctx.definitions.aspectInfo(slot.aspectId)?.name;
        if (!aspectName) continue;
        const tex = reg.find(aspectName);
        if (!tex) continue;
        const cur = i === 0 ? entry.stock0 : entry.stock1;
        // Mirror the main-sync branch (`syncTiles`) so the overlay
        // roster matches the world surface exactly: same (q, r) +
        // same stock-slot index always produces identical
        // `present` / `index` markings. See STOCK_INDEX_MODE.md.
        if (slot.mode === "index") {
          instances.push({ tex, present: cur > 0, index: cur });
        } else {
          for (let k = 0; k < MAX_STOCK_PER_SLOT; k++) {
            instances.push({ tex, present: k < cur });
          }
        }
      }
    } else if (def.aspects) {
      for (const pair of def.aspects) {
        if (!pair) continue;
        const aspectName = this.ctx.definitions.aspectInfo(pair[0])?.name;
        if (!aspectName) continue;
        const tex = reg.find(aspectName);
        if (!tex) continue;
        for (let k = 0; k < OBJECTS_PER_TILE; k++) {
          instances.push({ tex, present: true });
        }
        break;
      }
    }
    // Centre instance — `def.object` is the tile's pinned centre
    // sprite (alter, table, fountain, etc. under the unified card
    // model). Mirrors the main render path at the top of
    // [`syncTiles`] so the overlay roster carries the same centre
    // the world surface drew. Without this, tile-card objects
    // (alter, table) wouldn't occlude cards visually — a soul
    // placed on the alter's tile would render in front of the
    // alter sprite instead of behind it.
    let centre: { tex: TextureDefinition; index?: number; scaleMin: number; scaleMax: number } | null = null;
    if (def.object) {
      const cTex = reg.find(def.object.name);
      if (cTex) {
        const scaleEnv = def.object.scale ?? cTex.scale;
        centre = {
          tex: cTex,
          index: def.object.index,
          scaleMin: scaleEnv.min,
          scaleMax: scaleEnv.max,
        };
      }
    }

    if (instances.length === 0 && !centre) return;

    const ringRadius = WORLD_HEX_RADIUS / 2;
    const startAngle = tileAngleOffset(q, r);
    const TWO_PI = 2 * Math.PI;
    // Must mirror the main sync — same `(q, r)` produces the same
    // slot order, so the overlay's sprites line up with the world's.
    // When `centre` is set, slot 0 is reserved for it; ring instances
    // skip slot 0 (same filter the main render path applies).
    const slotOrder = centre
      ? slotPermutation(q, r).filter(s => s !== 0)
      : slotPermutation(q, r);

    // Centre first — pinned to (centerX, centerY), filtered out on
    // "bottom" queries (the own-tile / same-row-neighbour overlay
    // case) because the centre sprite already renders behind cards
    // on its own tile via the main pass z-order; re-adding it via
    // the overlay would double-layer it. "all" (southern neighbour
    // tiles) keeps the centre so an alter / table on a southward tile
    // can occlude a card placed northward.
    if (centre && half !== "bottom") {
      const tex = centre.tex;
      const t = hash(q, r, INSTANCE_SCALE_SEED_BASE) / 0x1_0000_0000;
      const variance = centre.scaleMin + t * (centre.scaleMax - centre.scaleMin);
      const seed = hash(q, r, INSTANCE_TEX_SEED_BASE);
      const objTex = this.ctx.lodTextures.get(tex.name, tex.size, seed, centre.index);
      const sprite = new Sprite(objTex);
      sprite.anchor.set(tex.anchor.x, tex.anchor.y);
      sprite.position.set(centerX, centerY);
      sprite.scale.set((tex.size / objTex.width) * variance);
      staged.push({ sprite, y: centerY });
    }

    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      if (!inst.present) continue;
      const tex = inst.tex;
      const slot = slotOrder[i];
      if (slot === undefined) break; // more ring instances than ring slots
      let sx: number;
      let sy: number;
      if (slot === 0) {
        // Centre sprite — treat as "top half" for filtering. The
        // sprite overlaps the tile centre but visually sits behind a
        // card placed on the tile (anchor at 0.75 puts most of its
        // height above its position, which is the part the card
        // would occlude). Skip on "bottom" queries (the own-tile /
        // same-row-neighbour overlay case) so the centre sprite
        // doesn't bleed into the card's translucent overlay.
        // Only reachable when `centre` is null — when `centre` is
        // set, slot 0 was filtered out of `slotOrder` above.
        if (half === "bottom") continue;
        sx = centerX;
        sy = centerY;
      } else {
        const ringN = slot - 1;
        const angle = startAngle + (TWO_PI * ringN) / RING_SLOT_COUNT + ringAngleJitter(q, r, ringN, RING_SLOT_COUNT);
        // Normalize to [0, 2π) so the BOTTOM_HALF_*_RAD window is well
        // defined regardless of how many times jitter has rotated past 0.
        const norm = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
        if (
          half === "bottom" &&
          (norm < BOTTOM_HALF_MIN_RAD || norm > BOTTOM_HALF_MAX_RAD)
        ) continue;
        if (
          half === "top" &&
          (norm < BOTTOM_HALF_MIN_RAD + Math.PI || norm > BOTTOM_HALF_MAX_RAD + Math.PI)
        ) continue;
        // "all" — no angle filter.
        sy = centerY + Math.sin(angle) * ringRadius;
        sx = centerX + Math.cos(angle) * ringRadius;
      }

      const t = hash(q, r, INSTANCE_SCALE_SEED_BASE + i) / 0x1_0000_0000;
      const variance = tex.scale.min + t * (tex.scale.max - tex.scale.min);
      const seed = hash(q, r, INSTANCE_TEX_SEED_BASE + i);
      // `LodTextureManager.get` always returns a Texture (substitute
      // / white fallback covers load-pending). Sprite scale =
      // `(desiredSize / objTex.width) × variance` so the rendered
      // size matches the aspect's `tex.size × variance` regardless
      // of which LOD bucket backs it this frame.
      const objTex = this.ctx.lodTextures.get(tex.name, tex.size, seed, inst.index);
      const sprite = new Sprite(objTex);
      sprite.anchor.set(tex.anchor.x, tex.anchor.y);
      sprite.position.set(sx, sy);
      sprite.scale.set((tex.size / objTex.width) * variance);
      staged.push({ sprite, y: sy });
    }
  }

  override destroy(): void {
    // Detach card nodes without destroying — CardManager owns their
    // lifecycle, and we're just the host. Children will reparent
    // elsewhere on the next layout pass (or get destroyed by
    // CardManager when their data row goes away).
    for (const card of [...this.worldCardSurface.children]) {
      this.worldCardSurface.removeChild(card);
    }
    this.unsubAnchor();
    this.unsubZones();
    this.unsubCards();
    this.unsubZoneAdded();
    this.unsubZoneRemoved();
    this.unsubObjectLoad();
    this.ctx.worldOverlay = null;
    this.ctx.worldHexAt = null;
    this.ctx.onTilesChanged = null;
    this.tileChangeListeners.clear();
    this.ctx.objects.destroyContainer(this.objectContainer);
    for (const s of this.activeSprites) s.destroy();
    this.activeSprites.length = 0;
    for (const s of this.spritePool) s.destroy();
    this.spritePool.length = 0;
    super.destroy();
  }
}
