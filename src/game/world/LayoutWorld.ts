import { Container, Graphics, Sprite, Texture } from "pixi.js";
import type { GameContext } from "../../GameContext";
import { LayoutNode } from "../layout/LayoutNode";
import type { LayoutManager } from "../layout/LayoutManager";
import { debug } from "../../debug";
import {
  HEX_HEIGHT,
  HEX_RADIUS,
  HEX_WIDTH,
} from "../cards/layout/hexagon/HexVisual";
import { EMPTY_TILE_PACKED } from "../../assets/TextureManager";
import { decodeZoneTiles, unpackMacroZone, WORLD_LAYER } from "./worldCoords";
import { unpackZoneId } from "../../server/data/packing";

const BG_COLOR = "#0d1218";

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
  private readonly worldCardSurface = new WorldCardSurface();
  private readonly spritePool: Sprite[] = [];
  private readonly activeSprites: Sprite[] = [];

  /** Flat tile cache keyed by `"${q},${r}"` — packed definition id of
   *  the tile at world hex (q, r). Missing entries render as
   *  `EMPTY_TILE_PACKED`. */
  private readonly tileData = new Map<string, number>();

  private viewQ = 0;
  private viewR = 0;

  private readonly unsubAnchor: () => void;
  private readonly unsubZones: () => void;
  private readonly unsubZoneAdded: () => void;
  private readonly unsubZoneRemoved: () => void;

  constructor(ctx: GameContext, layoutManager: LayoutManager) {
    super();

    // Container z-order: bg < tileLayer < worldCardSurface. bg is the
    // dark backdrop; tileLayer holds tile sprites; cards live in
    // worldCardSurface so they draw on top of tiles.
    //
    // No clip mask: GameLayout draws the world view first and the
    // title bar / inventory views after, so any world content that
    // bleeds outside the world's rect (e.g. a world card whose
    // viewport-pan position drifts past the edge) gets covered by
    // the adjacent views. The masked-clip path costs ~2 extra draw
    // calls; the over-draw cost of letting world bleed get painted
    // and then overwritten is cheaper.
    this.container.addChild(this.bg);
    this.container.addChild(this.tileLayer);

    // Wire worldCardSurface into the LayoutNode tree manually — we
    // want its PIXI container to sit on top of tileLayer for z-order,
    // but the surface is also a logical child for hit-testing /
    // layout-tree walks.
    this.worldCardSurface.parent = this;
    this.children.push(this.worldCardSurface);
    this.container.addChild(this.worldCardSurface.container);

    // Register the card surface for every world-layer zone the
    // ZoneManager tracks now and as zones enter / leave "active" tier.
    // Hex cards landing on these zones resolve their parent surface
    // via `LayoutManager.surfaceFor(zoneId)`.
    const registerZone = (zoneId: number): void => {
      if (unpackZoneId(zoneId).layer >= WORLD_LAYER) {
        layoutManager.register(zoneId, this.worldCardSurface);
      }
    };
    const unregisterZone = (zoneId: number): void => {
      if (unpackZoneId(zoneId).layer >= WORLD_LAYER) {
        layoutManager.unregister(zoneId);
      }
    };
    for (const zoneId of ctx.zones.zonesIn("active")) registerZone(zoneId);
    for (const zoneId of ctx.zones.zonesIn("hot")) registerZone(zoneId);
    this.unsubZoneAdded = ctx.zones.onAdded("active", registerZone);
    this.unsubZoneRemoved = ctx.zones.onRemoved("active", unregisterZone);

    this.unsubAnchor = ctx.zones.onAnchorChange((name, q, r) => {
      if (name !== "viewport") return;
      this.viewQ = q;
      this.viewR = r;
      this.invalidate();
    });

    // Hydrate tile cache from zones already in `data.zones.current`.
    for (const zone of ctx.data.zones.current.values()) {
      for (const tile of decodeZoneTiles(zone, ctx.definitions)) {
        this.tileData.set(`${tile.q},${tile.r}`, tile.packed);
      }
    }

    // Live updates: on every zone insert / update / remove, evict the
    // zone's 8×8 block from `tileData` and re-decode if the row still
    // exists. Cheaper than a full rescan; per-zone diffing isn't worth
    // it for the 64-tile window.
    this.unsubZones = ctx.data.zones.subscribe((change) => {
      debug.log(
        ["zone"],
        `[LayoutWorld] zone change kind=${change.kind} key=${change.key}`,
      );
      const zone =
        change.kind === "removed" ? change.oldRow
        : change.kind === "added" ? change.row
        : change.newRow;
      const { zoneQ, zoneR } = unpackMacroZone(zone.macroZone);
      for (let t = 0; t < 8; t++) {
        for (let b = 0; b < 8; b++) {
          this.tileData.delete(`${zoneQ + b},${zoneR + t}`);
        }
      }
      if (change.kind !== "removed") {
        const newRow = change.kind === "added" ? change.row : change.newRow;
        for (const tile of decodeZoneTiles(newRow, ctx.definitions)) {
          this.tileData.set(`${tile.q},${tile.r}`, tile.packed);
        }
      }
      this.invalidate();
    });
  }

  /** World hex `(q, r)` → pixel position in this node's local frame.
   *  Centers the viewport anchor on the node's midpoint; off-axis hexes
   *  fan out from there in pointy-top axial layout. */
  worldToLocal(q: number, r: number): { x: number; y: number } {
    const dq = q - this.viewQ;
    const dr = r - this.viewR;
    return {
      x: this.width / 2 + HEX_RADIUS * (Math.sqrt(3) * dq + Math.sqrt(3) / 2 * dr),
      y: this.height / 2 + HEX_RADIUS * (3 / 2 * dr),
    };
  }

  /** Inverse of `worldToLocal`. Snaps to the nearest hex via cube-coord
   *  rounding (the naive axial round-then-pick-the-larger-residual
   *  picks the wrong hex on triangle boundaries). */
  localToWorld(localX: number, localY: number): { q: number; r: number } {
    const dx = localX - this.width / 2;
    const dy = localY - this.height / 2;
    const fq = this.viewQ + dx / (HEX_RADIUS * Math.sqrt(3)) - dy / (3 * HEX_RADIUS);
    const fr = this.viewR + (2 * dy) / (3 * HEX_RADIUS);
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

    // Conservative ring radius: enough hex columns to cover the larger
    // of width / height plus a margin for half-tiles peeking in at the
    // edges. The +2 is a safety margin against rounding.
    const range = Math.ceil(Math.max(w, h) / (HEX_RADIUS * Math.sqrt(3))) + 2;
    const baseQ = Math.round(this.viewQ);
    const baseR = Math.round(this.viewR);

    for (let dq = -range; dq <= range; dq++) {
      for (let dr = -range; dr <= range; dr++) {
        const q = baseQ + dq;
        const r = baseR + dr;
        const { x, y } = this.worldToLocal(q, r);

        // Cull off-screen hexes by their bounding box. A more precise
        // hex-vs-rect cull would be cheaper per-tile but more code; the
        // bounding box is fine at typical viewport sizes.
        if (x + HEX_WIDTH / 2 < 0 || x - HEX_WIDTH / 2 > w) continue;
        if (y + HEX_HEIGHT / 2 < 0 || y - HEX_HEIGHT / 2 > h) continue;

        const packed = this.tileData.get(`${q},${r}`);
        const sprite = this.acquireSprite();
        if (packed !== undefined) {
          const def = this.ctx.definitions.decode(packed) ?? null;
          sprite.texture = this.ctx.textures.getHexTexture(def, packed);
        } else {
          sprite.texture = this.ctx.textures.getHexTexture(
            null,
            EMPTY_TILE_PACKED,
          );
        }
        sprite.position.set(x - HEX_WIDTH / 2, y - HEX_HEIGHT / 2);
      }
    }

    // Anchor the card surface at the origin hex's pixel position so a
    // card whose `setTarget` carries raw world-relative pixel offsets
    // ends up in the right spot after the surface's PIXI translation.
    const origin = this.worldToLocal(0, 0);
    this.worldCardSurface.setBounds(origin.x, origin.y, w, h);
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
    this.unsubZoneAdded();
    this.unsubZoneRemoved();
    for (const s of this.activeSprites) s.destroy();
    this.activeSprites.length = 0;
    for (const s of this.spritePool) s.destroy();
    this.spritePool.length = 0;
    super.destroy();
  }
}
