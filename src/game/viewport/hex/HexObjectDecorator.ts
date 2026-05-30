import { Container, type RenderTexture, Sprite } from "pixi.js";
import type { GameContext } from "../../../GameContext";
import { getTextureRegistry, type TextureDefinition } from "../../definitions/TextureRegistry";
import type { CardDefinition } from "../../definitions/DefinitionManager";
import type { ObjectSpriteRequest } from "../../../assets/ObjectManager";
import { WORLD_HEX_RADIUS, WORLD_HEX_WIDTH } from "./hexSize";

/** Decoded tile slot the decorator reads — matches `LayoutWorld.tileViewAt`'s
 *  shape (the extra `source` field on that return is ignored here). */
export interface TileEntry {
  packed: number;
  stock0: number;
  stock1: number;
}

/** Number of decorative sprites placed per tile that has an object
 *  aspect. >1 fans them around the tile centre in a ring. */
const OBJECTS_PER_TILE = 3;

/** Fast integer hash → uint32. Used to seed per-tile texture picks and
 *  per-sprite scale variation. Stable across syncs since the inputs
 *  are world-hex coordinates that don't change as the camera pans. */
export function hash(a: number, b: number, c: number): number {
  let h = ((a * 92821) ^ (b * 31337) ^ (c * 7919)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  return h;
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

/** Per-tile body-texture variation seed — shared with `LayoutWorld`'s tile-body
 *  render so the world surface and this decorator's centre object pick matching
 *  variants for the same `(q, r)`. Exposed so the (grid-agnostic) tile-body
 *  build can reuse it without importing the decorator's seed constant. */
export function tileSeed(q: number, r: number): number {
  return hash(q, r, INSTANCE_TEX_SEED_BASE);
}

/** Deterministic starting angle (radians) for a tile's object ring, so
 *  every tile's three objects rotate uniformly together but different
 *  tiles get different orientations. Caller adds this to
 *  `2π * n / OBJECTS_PER_TILE` for each `n`. Hash seed is offset past
 *  the ones used for texture pick / scale so they don't correlate. */
function tileAngleOffset(q: number, r: number): number {
  return (hash(q, r, OBJECTS_PER_TILE * 2) / 0x1_0000_0000) * 2 * Math.PI;
}

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
 *  `(q, r)`. Returned as a fresh array, stable across syncs. Sprite `n`
 *  (`0 <= n < totalSprites`) occupies slot `slotPermutation(q, r)[n]`;
 *  trailing entries represent slots that would be filled if the tile
 *  had more stock. */
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
 * The world / hex tile-object decoration layer.
 *
 * Decorative sprites — the tile's centre object plus stock-driven ring
 * instances (trees, rocks, …) — fanned around each hex tile in a fixed
 * 7-slot layout, and the "in front of the card" occlusion snapshot a card
 * bakes for the tile it sits on. Hex-specific: the ring radius is
 * `WORLD_HEX_RADIUS / 2` and the overlay samples the five pointy-top hex
 * neighbours that can occlude a card.
 *
 * A rect viewport (inventory) has no terrain objects and so no decorator —
 * `LayoutWorld` simply returns `false` from `makeObjectOverlayForTile`. The
 * host wires this in only for hex grids, supplying tile reads (`tileAt`) and
 * the cell→world-pixel mapping (`cellToPixel`) so the decorator stays free of
 * any back-reference to `LayoutWorld`.
 */
export class HexObjectDecorator {
  /** Holds the object sprites. The host adds this to its `panLayer` so the
   *  objects pan with the grid and sit above tiles / below cards in z-order. */
  readonly container: Container;

  constructor(
    private readonly ctx: GameContext,
    /** Read a tile's decoded slot at world cell `(q, r)` — `LayoutWorld.tileViewAt`. */
    private readonly tileAt: (q: number, r: number) => TileEntry | null,
    /** World cell `(q, r)` → centre pixel in `panLayer`-local (world-pixel) space. */
    private readonly cellToPixel: (q: number, r: number) => { x: number; y: number },
  ) {
    this.container = ctx.objects.createContainer();
  }

  /** Sync one tile's object group (centre + ring) into the ObjectManager,
   *  keyed by `key` so just this tile's group is replaced. Pass `null`
   *  entry/def to clear the group (empty / unloaded tile). */
  syncTile(
    key: string,
    q: number,
    r: number,
    entry: TileEntry | null,
    def: CardDefinition | null,
    tileFaction: string | undefined,
  ): void {
    const reqs = entry !== null && def !== null
      ? this.collectTileObjectReqs(q, r, entry, def, tileFaction)
      : [];
    this.ctx.objects.syncTile(this.container, key, reqs);
  }

  /** Drop one tile's object group. */
  dropTile(key: string): void {
    this.ctx.objects.dropTile(this.container, key);
  }

  /** Build the object-sprite requests for one tile — centre instance
   *  (the def's `object` slot) plus ring instances sourced from the
   *  def's `stock` slots (or the legacy `aspects` fallback), placed in
   *  the fixed 7-slot layout. Positions are in `panLayer`-local
   *  (world-pixel) space. */
  private collectTileObjectReqs(
    q: number,
    r: number,
    entry: { stock0: number; stock1: number },
    def: CardDefinition,
    tileFaction: string | undefined,
  ): ObjectSpriteRequest[] {
    const reqs: ObjectSpriteRequest[] = [];
    const reg = getTextureRegistry();

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
    const { x: cx, y: cy } = this.cellToPixel(q, r);

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

  /** Bake the objects in front of cell `(q_c, r_c)` into `target`; returns
   *  true if anything was drawn. Samples the own tile + four hex neighbours
   *  whose objects can poke in front of a card on this tile. */
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
    const entry = this.tileAt(q, r);
    if (entry === null) return;
    const def = this.ctx.definitions.decode(entry.packed);
    if (!def) return;

    // Build the same fixed-length "instance roster" the main sync
    // uses — one entry per *potential* object, tagged with `present`
    // based on the current stock counter. Identical inputs → identical
    // roster → identical slot assignment, so the overlay lines up with
    // the world surface.
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
        // Mirror the main-sync branch so the overlay roster matches the
        // world surface exactly: same (q, r) + same stock-slot index
        // always produces identical `present` / `index` markings.
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
    // model). Mirrors the main render path so the overlay roster
    // carries the same centre the world surface drew. Without this,
    // tile-card objects wouldn't occlude cards visually — a soul
    // placed on the alter's tile would render in front of the alter
    // sprite instead of behind it.
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

      // Ring-instance seeds use `BASE + i + 1` — the `+1` reserves `BASE + 0`
      // for the centre (see `collectTileObjectReqs`'s identical computation).
      // Without the `+1` here the overlay's first ring instance would collide
      // with the centre's seed band AND every ring instance would pick a
      // different LOD variant / scale variance than the world surface drew,
      // so the overlay sprites visibly wouldn't match the world sprites at
      // the same (q, r).
      const t = hash(q, r, INSTANCE_SCALE_SEED_BASE + i + 1) / 0x1_0000_0000;
      const variance = tex.scale.min + t * (tex.scale.max - tex.scale.min);
      const seed = hash(q, r, INSTANCE_TEX_SEED_BASE + i + 1);
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

  /** Destroy the object container (and every sprite the ObjectManager
   *  placed in it). */
  destroy(): void {
    this.ctx.objects.destroyContainer(this.container);
  }
}
