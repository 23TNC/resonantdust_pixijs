import { Container, Graphics, type RenderTexture, Sprite, Texture } from "pixi.js";
import type { GameContext } from "../../GameContext";
import { LayoutNode } from "../layout/LayoutNode";
import type { LayoutManager } from "../layout/LayoutManager";
import { debug } from "../../debug";
import type { CellGrid } from "./CellGrid";
import type { WorldViewProvider } from "./WorldViewServices";
import { HexObjectDecorator, tileSeed } from "./hex/HexObjectDecorator";
import { ZoneTileCache, type TileView } from "./ZoneTileCache";
import { WORLD_LAYER } from "./worldCoords";
import { decodeMacroZone, type ZoneId } from "../../server/data/packing";
import { localPlayerFactionFolder } from "../../server/player/playerFlags";

const BG_COLOR = "#0d1218";

/** Default number of tile-rings kept built beyond the visible rect.
 *  The buffer absorbs pan latency: when the integer hex anchor
 *  crosses a boundary the newly-revealed row was already built (it
 *  was off-screen margin), so only the new *outer* margin row is
 *  fresh — and it has ~a hex-width of pan slack before it becomes
 *  visible. Exposed as `LayoutWorld.marginRings` so 1 / 3 can be
 *  tried at runtime (a future settings knob can write to it). */
const DEFAULT_MARGIN_RINGS = 2;

/** Max tiles built per `layout()` pass while draining the build
 *  queue. Spreads a large fill (scene enter, teleport, surface swap)
 *  or a fresh margin edge over several frames instead of hitching on
 *  one. Edge rows land off-screen, so the spread is invisible. */
const BUILD_BUDGET = 12;

/** Render signature for a tile — every input that changes its drawn
 *  output (packed def + the two stock counters + which source the
 *  data came from, since that drives the debug ring). A data update
 *  that leaves this unchanged is a no-op the retained renderer skips. */
function tileSig(entry: TileView | null): string {
  if (entry === null) return "none";
  return `${entry.source}:${entry.packed}:${entry.stock0}:${entry.stock1}`;
}

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
 * A grid viewport node: renders one `(owner, surface)` zone's tiles + cards
 * onto a pluggable `CellGrid` (hex world or rect inventory — a
 * pure render-shape toggle). Three responsibilities are split out so this
 * class stays the viewport *shell*:
 *
 *  - **Tile data** → `ZoneTileCache` (`this.cache`): the `(q,r)` → tile lookup
 *    (`tileViewAt`), hydrated from `Zone` rows + promoted tile-cards, owning
 *    the zone/card subscriptions. This node only queries it and reacts to its
 *    `onChange`.
 *  - **Object decoration** (trees/rocks + the card occlusion overlay) →
 *    `HexObjectDecorator` (`this.decorator`), wired only for hex grids.
 *  - **This node** keeps the retained tile renderer (sprite pool + active-rect
 *    diff + build/drop), the pan transform, the `worldCardSurface` host for
 *    cards, and the `WorldViewServices` facade cards resolve via `findWorldView`.
 *
 * Panning is driven by `ZoneManager.onAnchorChange(viewportAnchorName)`: the
 * anchor stores cell `(q, r)`, and `panLayer` + `worldCardSurface` are
 * repositioned to `worldToLocal(0, 0)` each layout pass so the whole grid pans
 * by one transform write — cards ride along for free. A cell with no tile data
 * falls back to `EMPTY_TILE_PACKED`. Tile changes (the cache's `onChange`)
 * re-render only the affected active tiles and re-notify cards to re-bake.
 */
export class LayoutWorld extends LayoutNode implements WorldViewProvider {
  /** Brand: lets the card layer recognise this node as a `WorldViewServices`
   *  provider via a parent-chain walk (`findWorldView`) without value-importing
   *  `LayoutWorld`. */
  readonly isWorldView = true as const;

  private readonly bg = new Graphics();
  /** Holds the tile + object + debug layers in stable world-pixel
   *  space and is itself positioned at `worldToLocal(0, 0)` every
   *  pass — so a pan is a single transform write on this container,
   *  not a per-sprite reposition. Mirrors how `worldCardSurface`
   *  already carries cards. */
  private readonly panLayer = new Container();
  private readonly tileLayer = new Container();
  /** World/hex tile-object decoration (trees, rocks, centre objects + the card
   *  occlusion overlay). Only hex viewports carry one — a rect inventory has no
   *  terrain objects, so this stays `null` and `makeObjectOverlayForTile`
   *  draws nothing. */
  private readonly decorator: HexObjectDecorator | null;
  private readonly worldCardSurface = new WorldCardSurface();
  /** Debug overlay drawn above the tile layer. Currently used to ring tiles
   *  whose `(packed, stocks)` came from a tile-card (`source === "card"`)
   *  rather than the zone-derived snapshot — helps diagnose tile-card sizing /
   *  parenting bugs at a glance. Cleared and repainted every `layout()` pass. */
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
  /** Recycled tile (hex-body) sprites. One per built tile while
   *  active; returned here on drop so a tile re-entering the active
   *  rect reuses the allocation. */
  private readonly spritePool: Sprite[] = [];

  /** Currently-built tiles, keyed by `"${q},${r}"`. The retained set:
   *  a tile's sprites are created once on enter, released on exit, and
   *  re-rendered in place only when `sig` (its packed def + stocks +
   *  source) changes. `cardSourced` drives the debug ring. */
  private readonly retained = new Map<
    string,
    { q: number; r: number; tileSprite: Sprite; sig: string; cardSourced: boolean }
  >();

  /** Keys currently inside the active rect (visible + margin). The
   *  drain loop checks this so a tile that left the rect before it
   *  was built is skipped. */
  private activeKeys = new Set<string>();

  /** Tiles inside the active rect not yet built, ordered closest-to-
   *  centre first. Drained `BUILD_BUDGET` per pass; `layout()` returns
   *  `true` while non-empty so it keeps running until drained. */
  private buildQueue: { q: number; r: number; key: string }[] = [];

  /** Number of tile-rings kept built beyond the visible rect. See
   *  `DEFAULT_MARGIN_RINGS`. Public + mutable so the buffer size can
   *  be tuned at runtime. */
  marginRings = DEFAULT_MARGIN_RINGS;

  /** `(q,r)` of the integer hex the viewport last reconciled around,
   *  plus the rect dims at that time. A change in any of these means
   *  the active rect shifted (boundary cross / resize) → re-diff.
   *  `NaN` forces the first pass to reconcile. */
  private lastBaseQ = NaN;
  private lastBaseR = NaN;
  private diffW = NaN;
  private diffH = NaN;

  /** Last applied background size — redraw `bg` only when it changes. */
  private lastW = NaN;
  private lastH = NaN;

  /** Local-player faction folder applied to the built tiles. A change
   *  (login resolving) invalidates every baked centre/body texture
   *  choice → full rebuild. */
  private lastTileFaction: string | undefined = undefined;

  /** Set when a LOD pack lands (`lodTextures.onLoad`); the next pass
   *  re-resolves textures for the active tiles (bounded) instead of a
   *  full grid rebuild. */
  private texturesDirty = false;

  /** Set when the retained set must be torn down and rebuilt wholesale
   *  (surface swap, faction change). Honoured at the top of `layout()`. */
  private rebuildPending = false;

  /** The tile data model — `(owner, surface)`-scoped, answers `tileViewAt`.
   *  Owns the zone/card subscriptions; `null` for a terrain-less view. */
  private readonly cache: ZoneTileCache | null;

  private viewQ = 0;
  private viewR = 0;

  /** Cell ↔ pixel + nearest-cell snap strategy (required). The only
   *  cell-shape-aware surface in this view; a `HexGrid` makes a world viewport,
   *  a `RectGrid` an inventory viewport. Assigned from the constructor arg. */
  private readonly grid: CellGrid;

  /** False for terrain-less grid views (inventory). Gates tile hydration,
   *  the zone/tile-card subscriptions, and the per-cell tile build. */
  private readonly renderTerrain: boolean;
  /** True → cell (0,0) anchored near the panel's top-left (fixed grid view);
   *  false → centred (pannable world view). See the `origin` ctor opt. */
  private readonly originTopLeft: boolean;

  private readonly unsubAnchor: () => void;
  private readonly unsubZoneAdded: () => void;
  private readonly unsubZoneRemoved: () => void;
  private readonly unsubObjectLoad: () => void;
  private readonly unsubShowInfo: () => void;
  private readonly tileChangeListeners = new Set<() => void>();

  /** ZoneManager anchor name this view tracks for its (q, r)
   *  viewport. Singleton instances pass `"viewport"`; per-panel
   *  instances (multiple game-view panels open at once) pass
   *  `"viewport:<panelId>"` so each panel anchors zones around its
   *  own viewport independently. Stored so destroy can clear the
   *  matching anchor if the panel doesn't outlive this view. */
  readonly viewportAnchorName: string;

  /** Surface this view renders. World panels start at `WORLD_LAYER`
   *  (the default); non-world panels pass their own surface. Mutable
   *  via [`setSurface`] so a single panel can be re-pointed at a
   *  different surface (e.g. a soul-jump affordance). Used to
   *  filter incoming card/zone rows to this view's surface, and to
   *  gate `worldCardSurface` registration so each LayoutWorld only
   *  registers itself for zones on its own layer. */
  surface: number;

  /** Owner band of the zones this viewport shows: `0` for the world (the
   *  chunked, pannable overworld), a soul `card_id` for an inventory. Drops
   *  into this viewport resolve to THIS owner — a viewport is `(owner, surface)`
   *  regardless of grid shape, so an inventory is just a world view pointed at
   *  the owner's bucket. */
  readonly owner: number;
  /** True for a single-chunk bucket (inventory): the board is the one chunk
   *  `(0,0)` (cells 0..7 per axis), built whole regardless of pan. False for
   *  the world, which tiles infinitely across chunks as the viewport pans. */
  readonly singleChunk: boolean;


  constructor(
    ctx: GameContext,
    layoutManager: LayoutManager,
    viewportAnchorName: string = "viewport",
    surface: number = WORLD_LAYER,
    grid: CellGrid,
    opts: {
      /** When false, skip all terrain/tile work (hydration, the
       *  zone/tile-card subscriptions, and the per-cell tile build in
       *  `layout()`). The card surface still renders. Used by the inventory
       *  viewport — a grid bucket with no `Zone` tile data. */
      renderTerrain?: boolean;
      /** Viewport origin. `"center"` (default) puts cell (0,0) at the panel
       *  centre and pans around it — the world view. `"topleft"` puts cell
       *  (0,0)'s top-left near the panel's top-left so a fixed grid fills
       *  down-and-right — the inventory view. */
      origin?: "center" | "topleft";
      /** Owner band of this viewport's zones (default `0` = world). */
      owner?: number;
      /** Render as a single-chunk bounded board `(0,0)` (inventory). */
      singleChunk?: boolean;
    } = {},
  ) {
    super();
    this.grid = grid;
    this.renderTerrain = opts.renderTerrain ?? true;
    this.originTopLeft = (opts.origin ?? "center") === "topleft";
    this.owner = opts.owner ?? 0;
    this.singleChunk = opts.singleChunk ?? false;
    // Seed our own context immediately. The constructor builds the
    // `ZoneTileCache` (which reads `ctx.data`) before this node is attached to
    // a parent, so the parent-chain `ctx` getter has nothing to resolve
    // against yet. Setting `_localCtx` here makes `this.ctx` available
    // during construction; descendants still inherit it once attached.
    this.setContext(ctx);
    this.viewportAnchorName = viewportAnchorName;
    this.surface = surface;

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
    // Object decoration is a hex-grid (world) concern — a rect
    // inventory has no terrain objects. Build a decorator only for hex
    // viewports that render terrain; it owns the object container.
    this.decorator =
      grid.shape === "hex" && this.renderTerrain
        ? new HexObjectDecorator(ctx, (q, r) => this.tileViewAt(q, r), (q, r) => this.cellToPixel(q, r))
        : null;
    // bg is a fixed full-rect backdrop (does NOT pan). tileLayer, the
    // decorator's object container, and debugOverlay live inside panLayer in
    // stable world-pixel space; panLayer is repositioned to worldToLocal(0,0)
    // each pass so the whole grid pans by one transform write.
    this.panLayer.addChild(this.tileLayer);
    if (this.decorator) this.panLayer.addChild(this.decorator.container);
    this.container.addChild(this.bg);
    this.container.addChild(this.panLayer);

    // Wire worldCardSurface into the LayoutNode tree manually — we
    // want its PIXI container to sit on top of tileLayer for z-order,
    // but the surface is also a logical child for hit-testing /
    // layout-tree walks.
    this.worldCardSurface.parent = this;
    this.children.push(this.worldCardSurface);
    this.container.addChild(this.worldCardSurface.container);

    // Debug overlay rides inside panLayer (world-pixel space) so its
    // tile rings pan with the grid. Repainted from the retained set
    // whenever tiles change. Stays hit-transparent — it's a raw
    // Graphics, not a LayoutNode, so hit-test ignores it entirely.
    this.panLayer.addChild(this.debugOverlay);

    // Register the card surface for every zone on THIS view's
    // surface that the ZoneManager tracks now and as zones enter /
    // leave "active" tier. Hex cards landing on these zones resolve
    // their parent surface via `LayoutManager.surfaceFor(zoneId)`.
    // The match is on the full `(owner, surface)` zone identity — the
    // single shared `zones.current` / `cardsLocal` mirror holds every
    // open viewport's rows, so two viewports on the SAME surface but
    // different owners (e.g. two souls' inventories) must not steal
    // each other's zone registrations.
    const ownsZone = (zoneId: ZoneId): boolean => {
      const mz = decodeMacroZone(zoneId);
      return mz.surface === this.surface && mz.owner === this.owner;
    };
    const registerZone = (zoneId: ZoneId): void => {
      if (ownsZone(zoneId)) {
        layoutManager.register(zoneId, this.worldCardSurface);
      }
    };
    const unregisterZone = (zoneId: ZoneId): void => {
      if (ownsZone(zoneId)) {
        layoutManager.unregister(zoneId, this.worldCardSurface);
      }
    };
    // Render registration tracks the `active` tier only. `hot` (full sub) and
    // `cold` (zones-only skeleton) zones are subscribed but deliberately not
    // rendered — their card surface registers when they re-enter `active`
    // (onAdded fires on the →active transition) and unregisters on active→hot
    // (onRemoved). Tile data still hydrates for hot/cold zones, but they sit
    // outside the visible rect so nothing draws until promoted.
    for (const zoneId of ctx.zones.zonesIn("active")) registerZone(zoneId);
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
    // A LOD pack landed. Don't rebuild the grid — flag a coalesced
    // texture re-resolve for the active tiles, handled once on the
    // next pass however many loads fired between frames.
    this.unsubObjectLoad = ctx.lodTextures.onLoad(() => {
      this.texturesDirty = true;
      this.invalidate();
    });

    // Repaint the debug rings the instant the global toggle flips (rather than
    // waiting for the next pan / tile change). `repaintDebugOverlay` reads
    // `debug.showInfo` itself, so this both draws and clears.
    this.unsubShowInfo = debug.onShowInfoChange(() => this.repaintDebugOverlay());


    // The tile data model — an `(owner, surface)`-scoped cache that hydrates
    // from Zone rows + promoted tile-cards and owns those subscriptions. Built
    // only for terrain views (a terrain-less inventory has no Zone tile data).
    // On any tile change it re-renders the affected active tiles and notifies
    // cards so they re-bake their object-occlusion overlay.
    this.cache = this.renderTerrain ? new ZoneTileCache(ctx, surface, this.owner) : null;
    this.cache?.onChange(() => {
      this.reconcileActiveTileData();
      for (const cb of this.tileChangeListeners) cb();
    });

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
  }

  /** Pixel offset of cell (0,0)'s frame within this node. `"center"` origin
   *  puts it at the node midpoint (pannable world); `"topleft"` puts cell
   *  (0,0)'s centre half a cell in from the top-left (fixed grid / inventory). */
  private originPixel(): { x: number; y: number } {
    if (this.originTopLeft) {
      return { x: this.grid.cellWidth / 2, y: this.grid.cellHeight / 2 };
    }
    return { x: this.width / 2, y: this.height / 2 };
  }

  /** World cell `(q, r)` → pixel position in this node's local frame. */
  worldToLocal(q: number, r: number): { x: number; y: number } {
    const o = this.originPixel();
    const p = this.grid.cellToPixel(q - this.viewQ, r - this.viewR);
    return { x: o.x + p.x, y: o.y + p.y };
  }

  /** Inverse of `worldToLocal`. Snaps to the nearest cell via the grid's
   *  rounding (hex: cube-coord; rect: plain round). */
  localToWorld(localX: number, localY: number): { q: number; r: number } {
    const o = this.originPixel();
    const f = this.grid.pixelToCellFractional(localX - o.x, localY - o.y);
    return this.grid.roundCell(f.q + this.viewQ, f.r + this.viewR);
  }

  /** Cell `(q, r)` → centre pixel in `panLayer` / `worldCardSurface`-local
   *  (world-pixel) space — independent of the viewport. The surface carries
   *  the view offset, so a sprite placed here pans for free. Exposed via
   *  `WorldViewServices.cellToPixel` so cards on this view position themselves
   *  by cell without re-deriving the grid math. */
  cellToPixel(q: number, r: number): { x: number; y: number } {
    return this.grid.cellToPixel(q, r);
  }

  /** @deprecated internal alias kept for call sites; use `cellToPixel`. */
  private worldPixel(q: number, r: number): { x: number; y: number } {
    return this.cellToPixel(q, r);
  }

  /** A pixel delta `(dx, dy)` → the cell delta `(dq, dr)` it represents on this
   *  view's grid — origin-independent (a delta, not a position). Used by
   *  `PanController` to convert a drag's pixel movement into an anchor shift,
   *  grid-agnostically (hex or rect). */
  pixelDeltaToCell(dx: number, dy: number): { q: number; r: number } {
    return this.grid.pixelToCellFractional(dx, dy);
  }


  /** Take a tile (hex-body) sprite from the pool (or make one) and
   *  attach it to `tileLayer`. Size is applied in `buildTile` *after*
   *  the real texture is assigned — setting size against the EMPTY
   *  texture's 1×1 frame would pin scale to literal pixels. */
  private acquireTileSprite(): Sprite {
    const s = this.spritePool.pop() ?? new Sprite();
    s.visible = true;
    this.tileLayer.addChild(s);
    return s;
  }

  protected override layout(): boolean | void {
    const w = this.width;
    const h = this.height;

    if (w !== this.lastW || h !== this.lastH) {
      this.bg.clear();
      this.bg.rect(0, 0, w, h).fill({ color: BG_COLOR });
      this.lastW = w;
      this.lastH = h;
    }

    // The pan itself: move the layers that carry tiles / objects /
    // cards in world-pixel space. One transform write per frame, no
    // sprite repositioning. `worldCardSurface` tracks the same origin
    // so cards stay aligned with the grid.
    const origin = this.worldToLocal(0, 0);
    this.panLayer.position.set(origin.x, origin.y);
    this.worldCardSurface.setBounds(origin.x, origin.y, w, h);

    // A terrain-less view (`renderTerrain: false`) has no tiles to hydrate /
    // diff / build — bg + card surface are positioned above, so we're done.
    if (!this.renderTerrain) return;

    // Local-player faction resolving (login) changes every baked
    // centre/body texture choice — rebuild the retained set so tiles
    // re-resolve into the right palette.
    const tileFaction = localPlayerFactionFolder(this.ctx) ?? undefined;
    if (tileFaction !== this.lastTileFaction) {
      this.lastTileFaction = tileFaction;
      this.rebuildPending = true;
    }

    if (this.rebuildPending) {
      this.rebuildPending = false;
      this.dropAllTiles();
      this.lastBaseQ = NaN; // force the active-rect re-diff below
    }

    const baseQ = Math.round(this.viewQ);
    const baseR = Math.round(this.viewR);

    let structureChanged = false;
    // Only re-diff the active rect when the integer hex anchor crossed
    // a boundary or the viewport resized. A smooth sub-hex pan leaves
    // base unchanged → no diff, no rebuild — just the transform above.
    if (
      baseQ !== this.lastBaseQ || baseR !== this.lastBaseR ||
      w !== this.diffW || h !== this.diffH
    ) {
      this.reconcileActiveRect(baseQ, baseR, w, h);
      this.lastBaseQ = baseQ;
      this.lastBaseR = baseR;
      this.diffW = w;
      this.diffH = h;
      structureChanged = true;
    }

    // Coalesced texture-load refresh: a LOD pack landed since last
    // pass, so re-resolve textures for the (bounded) active tiles.
    if (this.texturesDirty) {
      this.texturesDirty = false;
      for (const e of [...this.retained.values()]) this.buildTile(e.q, e.r);
      structureChanged = true;
    }

    // Drain the build queue with a per-frame budget — spreads a big
    // fill or a fresh margin edge across frames.
    let built = 0;
    while (this.buildQueue.length > 0 && built < BUILD_BUDGET) {
      const next = this.buildQueue.shift()!;
      if (!this.activeKeys.has(next.key)) continue; // left the rect first
      if (this.retained.has(next.key)) continue;    // already built
      this.buildTile(next.q, next.r);
      built++;
    }
    if (built > 0) structureChanged = true;

    if (structureChanged) this.repaintDebugOverlay();

    // Stay dirty while tiles remain to build so `layout()` re-runs.
    return this.buildQueue.length > 0 ? true : undefined;
  }

  /** Diff the active rect (visible + `marginRings`) against the
   *  retained set: drop tiles that left, queue tiles that entered
   *  (closest-to-centre first so a big fill paints inside-out). */
  private reconcileActiveRect(baseQ: number, baseR: number, w: number, h: number): void {
    const keys = this.activeRectKeys(baseQ, baseR, w, h);
    const next = new Set<string>();
    for (const k of keys) next.add(k.key);
    for (const key of [...this.retained.keys()]) {
      if (!next.has(key)) this.dropTile(key);
    }
    this.activeKeys = next;
    this.buildQueue = keys.filter(k => !this.retained.has(k.key));
  }

  /** Tile keys inside the active rect, sorted closest-to-centre first.
   *  Computes a tight per-row `q` span from the actual viewport bounds
   *  (not a `max(w, h)` square), padded by `marginRings` on every
   *  side. */
  private activeRectKeys(
    baseQ: number,
    baseR: number,
    w: number,
    h: number,
  ): { q: number; r: number; key: string }[] {
    // A single-chunk bucket (inventory) is a small bounded board —
    // 8×8 = 64 cells. Build the WHOLE chunk regardless of pan or visible rect:
    // panning only slides `panLayer` over an already-built board, so cells that
    // scroll past the window edge stay built instead of being dropped +
    // rebuilt. Intersecting with `cellsInViewport` (correct for the UNBOUNDED
    // world) would drop the off-window cells of the board — tiles vanishing on
    // pan. The chunk is cheap enough to keep fully built.
    if (this.singleChunk) {
      const cells: { q: number; r: number; key: string }[] = [];
      for (let r = 0; r < 8; r++) {
        for (let q = 0; q < 8; q++) {
          cells.push({ q, r, key: `${q},${r}` });
        }
      }
      return cells;
    }
    const cells = this.grid.cellsInViewport(
      this.viewQ, this.viewR, baseQ, baseR, w, h, this.marginRings,
    );
    return cells.map(({ q, r }) => ({ q, r, key: `${q},${r}` }));
  }

  /** Build (or rebuild in place) one tile's hex body + object sprites
   *  and record its render signature. Reuses the tile's pooled sprite
   *  when it's already retained (texture refresh / data change). */
  private buildTile(q: number, r: number): void {
    const key = `${q},${r}`;
    const entry = this.tileViewAt(q, r);
    const def = entry !== null ? (this.ctx.definitions.decode(entry.packed) ?? null) : null;
    const tileFaction = localPlayerFactionFolder(this.ctx) ?? undefined;

    const sprite = this.retained.get(key)?.tileSprite ?? this.acquireTileSprite();

    // Hex body. `def.texture` (when set) fills the body via the LOD
    // pipeline; faction recursion to neutral happens inside
    // `lodTextures.get`. A null def keys the colour-only fallback hex.
    let bodyTex: Texture | null = null;
    const texRef = def?.texture;
    if (texRef) {
      bodyTex = this.ctx.lodTextures.get(
        texRef.name,
        Math.max(this.grid.cellWidth, this.grid.cellHeight),
        tileSeed(q, r),
        texRef.index,
        tileFaction,
      );
    }
    // Tile body shape follows the viewport's grid: hex polygon for a hex grid
    // (world), rectangle for a rect grid (inventory). Same tile
    // data either way — only the baked silhouette differs.
    sprite.texture =
      this.grid.shape === "rect"
        ? this.ctx.cardTextures.getRectTile(def, bodyTex)
        : this.ctx.cardTextures.getHex(def, bodyTex);
    // Size AFTER the real texture is set. Oversize by 2px past the
    // ceiled bbox so adjacent hexes' AA fringes overlap (the bake's
    // hex edge is anti-aliased; ≥2px overlap absorbs it on every
    // neighbour-spacing beat). Positions are rounded once in
    // world-pixel space and never re-rounded per frame, so seams no
    // longer migrate with the pan.
    sprite.setSize(Math.ceil(this.grid.cellWidth) + 2, Math.ceil(this.grid.cellHeight) + 2);
    const c = this.worldPixel(q, r);
    sprite.position.set(
      Math.round(c.x - this.grid.cellWidth / 2),
      Math.round(c.y - this.grid.cellHeight / 2),
    );

    // Object sprites for this tile (centre + ring) — only hex viewports carry
    // a decorator (a rect inventory has no terrain objects). Keyed so the
    // ObjectManager replaces just this tile's group.
    this.decorator?.syncTile(key, q, r, entry, def, tileFaction);

    this.retained.set(key, {
      q,
      r,
      tileSprite: sprite,
      sig: tileSig(entry),
      cardSourced: entry?.source === "card",
    });
  }

  /** Release one built tile: pool its hex sprite, drop its object
   *  group, forget the key. */
  private dropTile(key: string): void {
    const e = this.retained.get(key);
    if (!e) return;
    e.tileSprite.visible = false;
    this.tileLayer.removeChild(e.tileSprite);
    this.spritePool.push(e.tileSprite);
    this.decorator?.dropTile(key);
    this.retained.delete(key);
  }

  /** Tear down the whole retained set (surface swap, faction change).
   *  The next `layout()` re-diffs the active rect and rebuilds. */
  private dropAllTiles(): void {
    for (const key of [...this.retained.keys()]) this.dropTile(key);
    this.buildQueue = [];
    this.activeKeys = new Set();
  }

  /** Re-render the active tiles whose underlying data changed. Called
   *  from the zone / tile-card subscriptions; O(active tiles), each an
   *  O(1) signature compare. */
  private reconcileActiveTileData(): void {
    let changed = false;
    for (const e of [...this.retained.values()]) {
      if (tileSig(this.tileViewAt(e.q, e.r)) !== e.sig) {
        this.buildTile(e.q, e.r);
        changed = true;
      }
    }
    if (changed) this.repaintDebugOverlay();
  }

  /** Repaint the debug overlay from the retained set — rings tiles
   *  whose data came from a `cardsLocal` tile-card rather than the
   *  zone snapshot. Drawn in world-pixel space (rides `panLayer`).
   *  Gated on the global `debug.showInfo` toggle — off clears the rings. */
  private repaintDebugOverlay(): void {
    this.debugOverlay.clear();
    if (!debug.showInfo) return;
    for (const e of this.retained.values()) {
      if (!e.cardSourced) continue;
      const c = this.worldPixel(e.q, e.r);
      this.debugOverlay
        .circle(c.x, c.y, this.grid.cellHeight / 2)
        .stroke({ color: 0xff0000, width: 2, alpha: 0.9 });
    }
  }

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

  /** Card-priority `(packed, stock0, stock1, source)` at world cell `(q, r)`
   *  via the tile-data cache — `null` for a terrain-less view or an unloaded
   *  zone. `source` (`"card"` vs `"zone"`) is part of a tile's render
   *  signature and drives the debug ring. */
  private tileViewAt(q: number, r: number): TileView | null {
    return this.cache?.tileViewAt(q, r) ?? null;
  }

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
  worldHexAt(
    globalX: number,
    globalY: number,
  ): { q: number; r: number; offsetX: number; offsetY: number } {
    const sg = this.worldCardSurface.container.getGlobalPosition();
    const px = globalX - sg.x;
    const py = globalY - sg.y;
    const f = this.grid.pixelToCellFractional(px, py);
    const c = this.grid.roundCell(f.q, f.r);
    const centre = this.grid.cellToPixel(c.q, c.r);
    return { q: c.q, r: c.r, offsetX: centre.x - px, offsetY: centre.y - py };
  }

  /** WorldViewServices: subscribe to this view's tile-data changes (fires
   *  from the `data.zones.subscribe` / tile-card callbacks). Returns an
   *  unsubscribe fn. Cards re-bake their in-front-objects overlay on change. */
  onTilesChanged(cb: () => void): () => void {
    this.tileChangeListeners.add(cb);
    return () => this.tileChangeListeners.delete(cb);
  }

  /** WorldViewServices: bake the objects in front of cell `(q, r)` into
   *  `target`. Delegates to the hex object decorator — a terrain-less / rect
   *  viewport has no decorator, so nothing is drawn (returns false). */
  makeObjectOverlayForTile(
    q: number,
    r: number,
    target: RenderTexture,
    width: number,
    height: number,
    offsetX: number = 0,
    offsetY: number = 0,
  ): boolean {
    return this.decorator?.makeObjectOverlayForTile(q, r, target, width, height, offsetX, offsetY) ?? false;
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
    this.unsubZoneAdded();
    this.unsubZoneRemoved();
    this.unsubObjectLoad();
    this.unsubShowInfo();
    this.tileChangeListeners.clear();
    this.cache?.dispose();
    this.decorator?.destroy();
    // Destroy retained tile sprites + the pool. ObjectManager already
    // destroyed every object sprite via the decorator's destroy above.
    for (const e of this.retained.values()) e.tileSprite.destroy();
    this.retained.clear();
    for (const s of this.spritePool) s.destroy();
    this.spritePool.length = 0;
    super.destroy();
  }
}
