import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { GameContext } from "../GameContext";
import { LayoutNode } from "../layout/LayoutNode";
import type { LayoutManager } from "../layout/LayoutManager";
import { debug } from "../debug";
import { HEX_RADIUS, HEX_WIDTH, HEX_HEIGHT } from "../cards/views/HexCardVisual";
import { EMPTY_TILE_PACKED } from "../assets/TextureManager";
import { decodeZoneTiles, unpackMacroZone, WORLD_LAYER } from "./worldCoords";
import { unpackZoneId } from "../zones/zoneId";

const BG_COLOR = "#0d1218";

/**
 * Hit-passthrough panning layer for world cards.
 *
 * _x/_y tracks worldToLocal(0,0) — the viewport offset — so hitTestLayout
 * translates LayoutWorld-local pointer coords into raw world-space before
 * recursing into card children. Cards store raw world-space positions via
 * setTarget; the PIXI container transform handles the viewport pan.
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
 * Renders the world as a pointy-top hex tile grid.
 *
 * The "viewport" anchor from ZoneManager maps to the center of this node.
 * All tiles are rendered as sprites from the shared TextureManager atlas.
 * Empty tiles (definition_id 0 / unknown zones) use the EMPTY_TILE_PACKED
 * texture and show a coordinate label for debugging.
 */
export class LayoutWorld extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly tileLayer = new Container();
  private readonly worldCardSurface = new WorldCardSurface();
  private readonly labelPool: Text[] = [];
  private readonly clipMask = new Graphics();
  private readonly spritePool: Sprite[] = [];
  private readonly activeSprites: Sprite[] = [];

  /** Flat tile cache keyed by "${q},${r}". Stores packed definition id. */
  private readonly tileData = new Map<string, number>();

  private viewQ = 0;
  private viewR = 0;

  private readonly unsubAnchor: () => void;
  private readonly unsubZones: () => void;
  private readonly unsubZoneAdded: () => void;
  private readonly unsubZoneRemoved: () => void;

  constructor(ctx: GameContext, layoutManager: LayoutManager) {
    super();
    this.container.addChild(this.bg);
    this.container.addChild(this.tileLayer);
    // Wire worldCardSurface into the LayoutNode tree and PIXI tree manually so
    // we control z-order (cards must sit between tileLayer and the clip mask).
    this.worldCardSurface.parent = this;
    this.children.push(this.worldCardSurface);
    this.container.addChild(this.worldCardSurface.container);
    this.container.addChild(this.clipMask);
    this.container.mask = this.clipMask;

    // Register the surface (not LayoutWorld itself) for every active world zone
    // so cards attach to worldCardSurface via the standard LayoutNode.addChild path.
    const registerZone = (zoneId: number) => {
      if (unpackZoneId(zoneId).layer >= WORLD_LAYER) layoutManager.register(zoneId, this.worldCardSurface);
    };
    const unregisterZone = (zoneId: number) => {
      if (unpackZoneId(zoneId).layer >= WORLD_LAYER) layoutManager.unregister(zoneId);
    };
    for (const zoneId of ctx.zones.zonesIn("active")) registerZone(zoneId);
    for (const zoneId of ctx.zones.zonesIn("hot"))    registerZone(zoneId);
    this.unsubZoneAdded   = ctx.zones.onAdded("active", registerZone);
    this.unsubZoneRemoved = ctx.zones.onRemoved("active", unregisterZone);

    this.unsubAnchor = ctx.zones.onAnchorChange((name: string, q: number, r: number) => {
      if (name !== "viewport") return;
      this.viewQ = q;
      this.viewR = r;
      this.invalidate();
    });

    this.unsubZones = ctx.data.subscribe("zones", (change) => {
      debug.log(["zone"], `[LayoutWorld] zone change kind=${change.kind} key=${change.key}`);
      const zone = change.kind === "delete" ? change.oldValue : change.newValue;
      if (!zone) { this.invalidate(); return; }

      const { zoneQ, zoneR } = unpackMacroZone(zone.macroZone);
      for (let t = 0; t < 8; t++) {
        for (let b = 0; b < 8; b++) {
          this.tileData.delete(`${zoneQ + t},${zoneR + b}`);
        }
      }

      if (change.kind !== "delete") {
        for (const tile of decodeZoneTiles(zone, ctx.definitions)) {
          this.tileData.set(`${tile.q},${tile.r}`, tile.definition.packed);
        }
      }

      this.invalidate();
    });

    // Hydrate from zones already in the store.
    for (const zone of ctx.data.values("zones")) {
      for (const tile of decodeZoneTiles(zone, ctx.definitions)) {
        this.tileData.set(`${tile.q},${tile.r}`, tile.definition.packed);
      }
    }
  }

  /** World hex (q, r) → pixel position local to this node's top-left. */
  worldToLocal(q: number, r: number): { x: number; y: number } {
    const dq = q - this.viewQ;
    const dr = r - this.viewR;
    return {
      x: this.width  / 2 + HEX_RADIUS * (Math.sqrt(3) * dq + Math.sqrt(3) / 2 * dr),
      y: this.height / 2 + HEX_RADIUS * (3 / 2 * dr),
    };
  }

  /** Pixel position local to this node → nearest world hex (q, r). */
  localToWorld(localX: number, localY: number): { q: number; r: number } {
    const dx = localX - this.width  / 2;
    const dy = localY - this.height / 2;
    const fq = this.viewQ + dx / (HEX_RADIUS * Math.sqrt(3)) - dy / (3 * HEX_RADIUS);
    const fr = this.viewR + (2 * dy) / (3 * HEX_RADIUS);
    // Cube-coordinate rounding for correct nearest-hex snap.
    const fx = fq, fz = fr, fy = -fq - fr;
    let rx = Math.round(fx), ry = Math.round(fy), rz = Math.round(fz);
    const ddx = Math.abs(rx - fx), ddy = Math.abs(ry - fy), ddz = Math.abs(rz - fz);
    if (ddx > ddy && ddx > ddz) rx = -ry - rz;
    else if (ddy > ddz)         ry = -rx - rz;
    else                         rz = -rx - ry;
    return { q: rx, r: rz };
  }

  private _acquireSprite(): Sprite {
    const s = this.spritePool.pop() ?? new Sprite(Texture.EMPTY);
    s.visible = true;
    this.tileLayer.addChild(s);
    this.activeSprites.push(s);
    return s;
  }

  private _releaseActiveSprites(): void {
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

    this.clipMask.clear();
    this.clipMask.rect(0, 0, w, h).fill(0xffffff);

    this.bg.clear();
    this.bg.rect(0, 0, w, h).fill({ color: BG_COLOR });

    for (const t of this.labelPool) {
      this.container.removeChild(t);
      t.destroy();
    }
    this.labelPool.length = 0;

    this._releaseActiveSprites();

    const range = Math.ceil(Math.max(w, h) / (HEX_RADIUS * Math.sqrt(3))) + 2;

    // Round to nearest integer tile so lookups always hit integer keys,
    // while the float viewQ/viewR is still used inside toScreen() for
    // smooth sub-tile pan movement.
    const baseQ = Math.round(this.viewQ);
    const baseR = Math.round(this.viewR);

    for (let dq = -range; dq <= range; dq++) {
      for (let dr = -range; dr <= range; dr++) {
        const q = baseQ + dq;
        const r = baseR + dr;
        const { x, y } = this.worldToLocal(q, r);

        if (x + HEX_WIDTH  / 2 < 0 || x - HEX_WIDTH  / 2 > w) continue;
        if (y + HEX_HEIGHT / 2 < 0 || y - HEX_HEIGHT / 2 > h) continue;

        const packed = this.tileData.get(`${q},${r}`);

        const sprite = this._acquireSprite();
        if (packed !== undefined) {
          const def = this.ctx.definitions.decode(packed) ?? null;
          sprite.texture = this.ctx.textures.getHexTexture(def, packed);
        } else {
          sprite.texture = this.ctx.textures.getHexTexture(null, EMPTY_TILE_PACKED);
        }
        sprite.position.set(x - HEX_WIDTH / 2, y - HEX_HEIGHT / 2);
      }
    }

    // Update the card surface's position to worldToLocal(0,0). This sets both
    // the PIXI container offset (cards pan with the viewport) and _x/_y (so
    // hitTestLayout translates LayoutWorld-local coords into raw world-space).
    const origin = this.worldToLocal(0, 0);
    this.worldCardSurface.setBounds(origin.x, origin.y, w, h);
  }

  override destroy(): void {
    // Detach card nodes without destroying them — CardManager owns their lifecycle.
    for (const card of [...this.worldCardSurface.children]) {
      this.worldCardSurface.removeChild(card);
    }
    this.unsubAnchor();
    this.unsubZones();
    this.unsubZoneAdded();
    this.unsubZoneRemoved();
    for (const t of this.labelPool) t.destroy();
    this.labelPool.length = 0;
    for (const s of this.activeSprites) s.destroy();
    this.activeSprites.length = 0;
    for (const s of this.spritePool) s.destroy();
    this.spritePool.length = 0;
    super.destroy();
  }
}
