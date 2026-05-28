import { Container, Graphics, type RenderTexture, Sprite, Texture } from "pixi.js";
import type { GameContext } from "../../GameContext";
import { LayoutNode } from "../layout/LayoutNode";
import type { LayoutManager } from "../layout/LayoutManager";
import { debug } from "../../debug";
import { WORLD_HEX_HEIGHT, WORLD_HEX_RADIUS, WORLD_HEX_WIDTH } from "./hexSize";
import { getTextureRegistry, type TextureDefinition } from "../definitions/TextureRegistry";
import type { CardDefinition } from "../definitions/DefinitionManager";
import { decodeZoneTiles, macroOrigin, WORLD_LAYER } from "./worldCoords";
import { unpackZoneId } from "../../server/data/packing";
import { getStackedState, STACKED_LOOSE } from "../cards/cardData";
import { localPlayerFactionFolder } from "../../server/player/playerFlags";
import type { LocalCard } from "../../server/data/DataManager";
import type { ObjectSpriteRequest } from "../../assets/ObjectManager";

/** `card_type` value reserved for tile-cards (promoted zone tiles).
 *  Mirrors the constant in `gc.rs` / `world_gen.rs` /
 *  `movement.rs::TILE_CARD_TYPE`. Source of truth lives in
 *  `content/cards/types.json` (`tile` = 7). See
 *  `docs/TILE_AS_CARD.md`. */
const TILE_CARD_TYPE = 7;

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
function tileSig(
  entry: { packed: number; stock0: number; stock1: number; source: "card" | "zone" } | null,
): string {
  if (entry === null) return "none";
  return `${entry.source}:${entry.packed}:${entry.stock0}:${entry.stock1}`;
}

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
  /** Holds the tile + object + debug layers in stable world-pixel
   *  space and is itself positioned at `worldToLocal(0, 0)` every
   *  pass — so a pan is a single transform write on this container,
   *  not a per-sprite reposition. Mirrors how `worldCardSurface`
   *  already carries cards. */
  private readonly panLayer = new Container();
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

  /** `(q,r)` → tile-card row index. Replaces the per-tile full
   *  `cardsLocal` scan in `tileViewAt`; rebuilt from the cards
   *  subscription whenever a tile-card row changes. */
  private readonly tileCardIndex = new Map<string, LocalCard>();

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
   *  (the default); non-world panels pass their own surface. Mutable
   *  via [`setSurface`] so a single panel can be re-pointed at a
   *  different surface (e.g. a soul-jump affordance). Used to
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
    // Seed our own context immediately. The constructor runs tile-cache
    // hydration (`rebuildTileCardIndex`) before this node is attached to
    // a parent, so the parent-chain `ctx` getter has nothing to resolve
    // against yet. Setting `_localCtx` here makes `this.ctx` available
    // during construction; descendants still inherit it once attached.
    this.setContext(ctx);
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
    // bg is a fixed full-rect backdrop (does NOT pan). tileLayer,
    // objectContainer and debugOverlay live inside panLayer in stable
    // world-pixel space; panLayer is repositioned to worldToLocal(0,0)
    // each pass so the whole grid pans by one transform write.
    this.panLayer.addChild(this.tileLayer);
    this.panLayer.addChild(this.objectContainer);
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
    // The `=== this.surface` check means a world LayoutWorld and a
    // mini-zone LayoutWorld can coexist without stealing each
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
    // A LOD pack landed. Don't rebuild the grid — flag a coalesced
    // texture re-resolve for the active tiles, handled once on the
    // next pass however many loads fired between frames.
    this.unsubObjectLoad = ctx.lodTextures.onLoad(() => {
      this.texturesDirty = true;
      this.invalidate();
    });

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
    // Filter by surface so a mini-zone LayoutWorld doesn't ingest
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
    // Build the `(q,r)` → tile-card index from cards already present so
    // the first `tileViewAt` resolves card-sourced tiles without a
    // full `cardsLocal` scan.
    this.rebuildTileCardIndex();

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
      // A tile-card landed / moved / was reaped — its hex (and any hex
      // it vacated) may now resolve differently. Rebuild the index,
      // then re-render only the active tiles whose signature changed.
      this.rebuildTileCardIndex();
      this.reconcileActiveTileData();
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
      // doesn't react to mini-zone zone changes (and vice versa).
      if (zone.surface !== this.surface) return;
      const { zoneQ, zoneR } = macroOrigin(zone.macro);
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
      // Re-render only the active tiles whose signature changed; tiles
      // outside the active rect pick up the new data when they enter.
      this.reconcileActiveTileData();
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
    this.rebuildTileCardIndex();
    // Every retained tile's data came from the old surface — tear the
    // set down and rebuild on the next pass.
    this.rebuildPending = true;
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

  /** Hex `(q, r)` → centre pixel in `panLayer`-local (world-pixel)
   *  space — independent of the viewport. `panLayer` carries the view
   *  offset, so a sprite placed here pans for free. Equivalent to
   *  `worldToLocal(q, r)` minus the per-frame `(viewQ, viewR)` term. */
  private worldPixel(q: number, r: number): { x: number; y: number } {
    return {
      x: WORLD_HEX_RADIUS * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r),
      y: WORLD_HEX_RADIUS * ((3 / 2) * r),
    };
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
    const R = WORLD_HEX_RADIUS;
    const colW = Math.sqrt(3) * R; // horizontal step per dq (and per dr/2)
    const rowH = 1.5 * R;          // vertical step per dr
    const margin = this.marginRings;

    // Row span: a hex centre is on-screen when its y ± R overlaps
    // [0, h]; solve for (r - viewR).
    const rSpan = (h / 2 + R) / rowH;
    const rMin = Math.floor(this.viewR - rSpan) - margin;
    const rMax = Math.ceil(this.viewR + rSpan) + margin;

    const qSpan = w / (2 * colW) + 0.5;
    const ranked: { q: number; r: number; key: string; d: number }[] = [];
    for (let r = rMin; r <= rMax; r++) {
      const qCentre = this.viewQ - (r - this.viewR) / 2;
      const qMin = Math.floor(qCentre - qSpan) - margin;
      const qMax = Math.ceil(qCentre + qSpan) + margin;
      for (let q = qMin; q <= qMax; q++) {
        const dq = q - baseQ;
        const dr = r - baseR;
        // Axial hex distance from the anchor, for inside-out ordering.
        const d = (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
        ranked.push({ q, r, key: `${q},${r}`, d });
      }
    }
    ranked.sort((a, b) => a.d - b.d);
    return ranked;
  }

  /** Build (or rebuild in place) one tile's hex body + object sprites
   *  and record its render signature. Reuses the tile's pooled sprite
   *  when it's already retained (texture refresh / data change). */
  private buildTile(q: number, r: number): void {
    const key = `${q},${r}`;
    const entry = this.tileViewAt(q, r);
    const def = entry !== null ? (this.ctx.definitions.decode(entry.packed) ?? null) : null;
    const tileFaction = localPlayerFactionFolder(this.ctx) ?? undefined;
    const reg = getTextureRegistry();

    const sprite = this.retained.get(key)?.tileSprite ?? this.acquireTileSprite();

    // Hex body. `def.texture` (when set) fills the body via the LOD
    // pipeline; faction recursion to neutral happens inside
    // `lodTextures.get`. A null def keys the colour-only fallback hex.
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
    // Size AFTER the real texture is set. Oversize by 2px past the
    // ceiled bbox so adjacent hexes' AA fringes overlap (the bake's
    // hex edge is anti-aliased; ≥2px overlap absorbs it on every
    // neighbour-spacing beat). Positions are rounded once in
    // world-pixel space and never re-rounded per frame, so seams no
    // longer migrate with the pan.
    sprite.setSize(Math.ceil(WORLD_HEX_WIDTH) + 2, Math.ceil(WORLD_HEX_HEIGHT) + 2);
    const c = this.worldPixel(q, r);
    sprite.position.set(
      Math.round(c.x - WORLD_HEX_WIDTH / 2),
      Math.round(c.y - WORLD_HEX_HEIGHT / 2),
    );

    // Object sprites for this tile (centre + ring), keyed so the
    // ObjectManager can replace just this tile's group.
    const reqs = (entry !== null && def !== null)
      ? this.collectTileObjectReqs(q, r, entry, def, reg, tileFaction)
      : [];
    this.ctx.objects.syncTile(this.objectContainer, key, reqs);

    this.retained.set(key, {
      q,
      r,
      tileSprite: sprite,
      sig: tileSig(entry),
      cardSourced: entry?.source === "card",
    });
  }

  /** Build the object-sprite requests for one tile — centre instance
   *  (the def's `object` slot) plus ring instances sourced from the
   *  def's `stock` slots (or the legacy `aspects` fallback), placed in
   *  the fixed 7-slot layout. Positions are in `panLayer`-local
   *  (world-pixel) space. Ported verbatim from the old per-tile sync
   *  loop minus the off-screen cull (the active rect bounds it). */
  private collectTileObjectReqs(
    q: number,
    r: number,
    entry: { stock0: number; stock1: number },
    def: CardDefinition,
    reg: ReturnType<typeof getTextureRegistry>,
    tileFaction: string | undefined,
  ): ObjectSpriteRequest[] {
    const reqs: ObjectSpriteRequest[] = [];

    // Instance roster: one entry per *potential* object regardless of
    // current stock, so slot assignment stays stable as stock changes.
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
          // Index mode: one sprite pinned to `_<cur>.png`; cur 0 → none.
          instances.push({ tex, present: cur > 0, index: cur });
        } else {
          // Count mode: N copies for stock = N; roster reserves
          // MAX_STOCK_PER_SLOT positions so the visible/hidden mix is
          // stable per (q, r).
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

    // Centre instance — pinned to slot 0 when the def declares an
    // `object`.
    let centre: { tex: TextureDefinition; index?: number } | null = null;
    if (def.object) {
      const cTex = reg.find(def.object.name);
      if (cTex) centre = { tex: cTex, index: def.object.index };
    }

    if (instances.length === 0 && !centre) return reqs;
    let presentCount = centre ? 1 : 0;
    for (const inst of instances) if (inst.present) presentCount++;
    if (presentCount === 0) return reqs;

    const ringRadius = WORLD_HEX_RADIUS / 2;
    const { x: cx, y: cy } = this.worldPixel(q, r);

    // Fixed 7-slot layout (1 centre + 6 ring). Centre reserves slot 0
    // when present; ring instances skip it.
    const slotOrder = centre
      ? slotPermutation(q, r).filter(s => s !== 0)
      : slotPermutation(q, r);
    const startAngle = tileAngleOffset(q, r);

    if (centre) {
      const t = hash(q, r, INSTANCE_SCALE_SEED_BASE) / 0x1_0000_0000;
      const scaleEnv = def.object?.scale ?? centre.tex.scale;
      const scale = scaleEnv.min + t * (scaleEnv.max - scaleEnv.min);
      const centreFaction =
        this.ctx.definitions.cardFactionOverride(def) ?? tileFaction;
      reqs.push({
        name: centre.tex.name,
        desiredSize: centre.tex.size,
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
      reqs.push({
        name: inst.tex.name,
        desiredSize: inst.tex.size,
        seed: hash(q, r, INSTANCE_TEX_SEED_BASE + i + 1),
        index: inst.index,
        x,
        y,
        scale,
        sortKey: y,
        anchorX: inst.tex.anchor.x,
        anchorY: inst.tex.anchor.y,
      });
    }
    return reqs;
  }

  /** Release one built tile: pool its hex sprite, drop its object
   *  group, forget the key. */
  private dropTile(key: string): void {
    const e = this.retained.get(key);
    if (!e) return;
    e.tileSprite.visible = false;
    this.tileLayer.removeChild(e.tileSprite);
    this.spritePool.push(e.tileSprite);
    this.ctx.objects.dropTile(this.objectContainer, key);
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

  /** Rebuild the `(q,r)` → tile-card index from `cardsLocal`. Cheap
   *  enough to redo wholesale on each tile-card change (infrequent
   *  vs. frames); replaces the per-tile `cardsLocal` scan. */
  private rebuildTileCardIndex(): void {
    this.tileCardIndex.clear();
    for (const row of this.ctx.data.cardsLocal.values()) {
      if (row.surface !== this.surface) continue;
      const cardType = (row.packedDefinition >> 12) & 0xf;
      if (cardType !== TILE_CARD_TYPE) continue;
      const hex = this.resolveTileCardHex(row);
      if (hex === null) continue;
      const { zoneQ, zoneR } = macroOrigin(row.macro);
      this.tileCardIndex.set(`${zoneQ + hex.q},${zoneR + hex.r}`, row);
    }
  }

  /** Repaint the debug overlay from the retained set — rings tiles
   *  whose data came from a `cardsLocal` tile-card rather than the
   *  zone snapshot. Drawn in world-pixel space (rides `panLayer`). */
  private repaintDebugOverlay(): void {
    this.debugOverlay.clear();
    for (const e of this.retained.values()) {
      if (!e.cardSourced) continue;
      const c = this.worldPixel(e.q, e.r);
      this.debugOverlay
        .circle(c.x, c.y, WORLD_HEX_RADIUS)
        .stroke({ color: 0xff0000, width: 2, alpha: 0.9 });
    }
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

  /** Tile-card (`card_type == 7`) whose hex resolves to world `(q, r)`,
   *  or `null`. O(1) lookup into `tileCardIndex`, which is rebuilt from
   *  `cardsLocal` on every tile-card change via `rebuildTileCardIndex`
   *  — replacing the old per-call full-`cardsLocal` scan that ran once
   *  per tile per relayout. The index resolves each tile-card's hex
   *  the same way (`resolveTileCardHex`: Free state reads `microZone`
   *  directly; OnRoot / Slot chases the parent chain to the first Free
   *  ancestor), and is surface-scoped so a tile-card on another layer
   *  belongs to a different LayoutWorld instance. */
  private findFreeTileCardAt(q: number, r: number): LocalCard | null {
    return this.tileCardIndex.get(`${q},${r}`) ?? null;
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
    // Destroy retained tile sprites + the pool. ObjectManager already
    // destroyed every object sprite via destroyContainer above.
    for (const e of this.retained.values()) e.tileSprite.destroy();
    this.retained.clear();
    this.tileCardIndex.clear();
    for (const s of this.spritePool) s.destroy();
    this.spritePool.length = 0;
    super.destroy();
  }
}
