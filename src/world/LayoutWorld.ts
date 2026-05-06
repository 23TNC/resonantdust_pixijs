import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { GameContext } from "../GameContext";
import { LayoutNode } from "../layout/LayoutNode";
import type { LayoutManager } from "../layout/LayoutManager";
import { debug } from "../debug";
import { HEX_RADIUS, HEX_WIDTH, HEX_HEIGHT } from "../cards/HexCardVisual";
import { EMPTY_TILE_PACKED } from "../assets/TextureManager";
import {
  HEIGHT_UNIT_PX,
  LightingManager,
  type Light,
  type Point3,
  type TriangleKind,
} from "../lighting/LightingManager";
import { decodeZoneTiles, unpackMacroZone, WORLD_LAYER } from "./worldCoords";
import { unpackZoneId } from "../zones/zoneId";

const BG_COLOR = "#0d1218";

/** Master toggle for the lighting-debug overlays: triangle outlines, the sun
 *  glyph + label, and the per-triangle normal-indicator lines. The shaded
 *  fill and the back-face-black effect are not gated on this — they're
 *  rendering, not debug. */
const LIGHTING_DEBUG = false;

/** Triangle layer alpha. Lets the tile sprites read through faintly while
 *  keeping the shading dominant. */
const TRIANGLE_ALPHA = 1.0;

/** Hex `u3` height of the dynamic point light, used both to position it
 *  in the LightingManager world frame and to label its glyph. */
const POINT_LIGHT_HEIGHT = 3;

/** Single grid-flood light seeded at world hex (0, 0). `x` / `y` are pixel
 *  coords in the LightingManager world frame; `z` is in raw `u3` units to
 *  match the propagation formula. */
const POINT_LIGHT: Light = {
  x: 0,
  y: 0,
  z: POINT_LIGHT_HEIGHT,
  power: 3,
  range: 12,
  falloff: 0.85,
};

/** Pixel length of a unit-magnitude triangle-normal indicator. The xy
 *  components of the unit normal scale into pixels by this — flat
 *  triangles draw a zero-length line, fully sideways normals (90° tilt)
 *  draw the full length. */
const NORMAL_INDICATOR_SCALE = HEX_RADIUS / 2;

/** Pixel radius of the on-screen debug glyph for the point light. */
const LIGHT_GLYPH_RADIUS = 18;

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
 *
 * On top of the sprites a triangle mesh from `LightingManager` is drawn —
 * one inscribed UP triangle and one south-pointing DOWN triangle per hex.
 * Each triangle's three world-space points are projected to local pixels
 * with `+z` pulling vertically upward on screen, and the fill colour comes
 * from the lit `HexLighting` so terrain relief is visible as shading.
 */
export class LayoutWorld extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly tileLayer = new Container();
  private readonly lightingLayer = new Graphics();
  private readonly sunCircle = new Graphics();
  private readonly sunLabel: Text;
  private readonly worldCardSurface = new WorldCardSurface();
  private readonly labelPool: Text[] = [];
  private readonly clipMask = new Graphics();
  private readonly spritePool: Sprite[] = [];
  private readonly activeSprites: Sprite[] = [];


  /** Flat tile cache keyed by "${q},${r}". Stores packed definition id and height. */
  private readonly tileData = new Map<string, { packed: number; height: number }>();

  private readonly lighting: LightingManager;

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
    // Lighting triangles draw above the tile sprites but below the card
    // surface so cards always remain on top.
    this.container.addChild(this.lightingLayer);
    // Wire worldCardSurface into the LayoutNode tree and PIXI tree manually so
    // we control z-order (cards must sit between the lighting layer and the
    // clip mask).
    this.worldCardSurface.parent = this;
    this.children.push(this.worldCardSurface);
    this.container.addChild(this.worldCardSurface.container);
    this.container.addChild(this.clipMask);
    this.container.mask = this.clipMask;

    this.lighting = new LightingManager(ctx);
    this.lighting.registerLight(POINT_LIGHT);

    // Light debug glyph lives inside lightingLayer's display tree so it
    // shares a layer with the lit triangles, but as persistent children —
    // `lightingLayer.clear()` only clears its own draw commands and leaves
    // these alone.
    this.lightingLayer.addChild(this.sunCircle);
    this.sunLabel = new Text({
      text: "",
      style: {
        fontSize: 13,
        fontWeight: "700",
        fill: 0x000000,
      },
    });
    this.sunLabel.anchor.set(0.5, 0.5);
    this.lightingLayer.addChild(this.sunLabel);

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
          this.tileData.set(`${tile.q},${tile.r}`, { packed: tile.definition.packed, height: tile.height });
        }
      }

      this.invalidate();
    });

    // Hydrate from zones already in the store.
    for (const zone of ctx.data.values("zones")) {
      for (const tile of decodeZoneTiles(zone, ctx.definitions)) {
        this.tileData.set(`${tile.q},${tile.r}`, { packed: tile.definition.packed, height: tile.height });
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

  /**
   * Project a `LightingManager` world-space point into LayoutWorld-local
   * pixel coords. The 3D `z` component is intentionally dropped so triangle
   * vertices land exactly on their hex corners on screen — heights still
   * shape the normal (and therefore the shading) inside LightingManager,
   * but the rendered geometry stays flat against the tile grid.
   */
  private _project(p: Point3, originX: number, originY: number): [number, number] {
    return [p[0] + originX, p[1] + originY];
  }

  private _drawLitTriangle(
    q: number,
    r: number,
    kind: TriangleKind,
    originX: number,
    originY: number,
  ): void {
    const tri = this.lighting.triangleAt(q, r, kind);
    const lit = this.lighting.lightingAt(q, r, kind);

    const [a, b, c] = tri.points;
    const [ax, ay] = this._project(a, originX, originY);
    const [bx, by] = this._project(b, originX, originY);
    const [cx, cy] = this._project(c, originX, originY);

    // LightingManager already folds ambient + upward bias + tone-mapped
    // propagated light into the colour, so just remap to 0..255 here.
    const r8 = Math.round(lit.color[0] * 255);
    const g8 = Math.round(lit.color[1] * 255);
    const b8 = Math.round(lit.color[2] * 255);
    const fill = (r8 << 16) | (g8 << 8) | b8;

    const polyChain = this.lightingLayer
      .poly([ax, ay, bx, by, cx, cy])
      .fill({ color: fill, alpha: TRIANGLE_ALPHA });

    if (LIGHTING_DEBUG) {
      polyChain.stroke({ width: 1, color: 0xffffff, alpha: 0.35 });

      // Normal indicator: a line from the triangle centroid pointing in
      // the direction of the normal's xy projection. Flat triangles draw
      // a zero-length stub; tilted triangles fan out toward the surface's
      // "downhill" direction (the way a ball would roll).
      const [nx, ny] = tri.normal;
      const centX = (ax + bx + cx) / 3;
      const centY = (ay + by + cy) / 3;
      this.lightingLayer
        .moveTo(centX, centY)
        .lineTo(
          centX + nx * NORMAL_INDICATOR_SCALE,
          centY + ny * NORMAL_INDICATOR_SCALE,
        )
        .stroke({ width: 2, color: 0xff2040, alpha: 0.95 });
    }
  }

  /**
   * Debug glyph for the dynamic point light. The light has a real world
   * position, so the glyph anchors to `worldToLocal(0,0)` plus the light's
   * xy offset and is lifted on screen by its z component — it pans with
   * the world and floats above its hex by its height. The label shows the
   * light's height in `u3` units.
   */
  private _drawLightDebug(originX: number, originY: number): void {
    if (!LIGHTING_DEBUG) {
      this.sunCircle.clear();
      this.sunLabel.text = "";
      return;
    }

    // POINT_LIGHT.z is in raw u3 units; multiply by HEIGHT_UNIT_PX to lift
    // the glyph on screen by its terrain-equivalent height.
    const cx = originX + POINT_LIGHT.x;
    const cy = originY + POINT_LIGHT.y - POINT_LIGHT.z * HEIGHT_UNIT_PX;

    this.sunCircle.clear();
    this.sunCircle
      .circle(cx, cy, LIGHT_GLYPH_RADIUS)
      .fill({ color: 0xffe680, alpha: 0.95 })
      .stroke({ width: 1, color: 0x000000, alpha: 0.6 });

    this.sunLabel.text = `h=${POINT_LIGHT.z.toFixed(0)}`;
    this.sunLabel.position.set(cx, cy);
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
    this.lightingLayer.clear();

    const range = Math.ceil(Math.max(w, h) / (HEX_RADIUS * Math.sqrt(3))) + 2;

    // Round to nearest integer tile so lookups always hit integer keys,
    // while the float viewQ/viewR is still used inside toScreen() for
    // smooth sub-tile pan movement.
    const baseQ = Math.round(this.viewQ);
    const baseR = Math.round(this.viewR);

    // LightingManager points are in absolute world space; adding `origin`
    // (the local pixel position of world hex 0,0) moves them into local
    // pixel space.
    const origin = this.worldToLocal(0, 0);

    for (let dq = -range; dq <= range; dq++) {
      for (let dr = -range; dr <= range; dr++) {
        const q = baseQ + dq;
        const r = baseR + dr;
        const { x, y } = this.worldToLocal(q, r);

        // Broadened y cull so DOWN triangles owned by hexes just above the
        // viewport (their south tip is 2R below the hex centre, which is
        // still on-screen) don't pop out at the edge.
        if (x + HEX_WIDTH  / 2 < 0 || x - HEX_WIDTH  / 2 > w) continue;
        if (y + HEX_HEIGHT     < 0 || y - HEX_RADIUS    > h) continue;

        const entry = this.tileData.get(`${q},${r}`);

        const sprite = this._acquireSprite();
        if (entry !== undefined) {
          const def = this.ctx.definitions.decode(entry.packed) ?? null;
          sprite.texture = this.ctx.textures.getHexTexture(def, entry.packed);

          const label = new Text({ text: String(entry.height), style: { fontSize: 16, fill: 0xffffff, dropShadow: { color: 0x000000, distance: 2, blur: 2 } } });
          label.anchor.set(0.5, 0);
          label.position.set(x, y + 8);
          this.container.addChild(label);
          this.labelPool.push(label);
        } else {
          sprite.texture = this.ctx.textures.getHexTexture(null, EMPTY_TILE_PACKED);
        }
        sprite.position.set(x - HEX_WIDTH / 2, y - HEX_HEIGHT / 2);

        const coordLabel = new Text({
          text: `${q},${r}`,
          style: {
            fontSize: 12,
            fill: 0xffffff,
            dropShadow: { color: 0x000000, distance: 2, blur: 2 },
          },
        });
        coordLabel.anchor.set(0.5, 1);
        coordLabel.position.set(x, y - 8);
        this.container.addChild(coordLabel);
        this.labelPool.push(coordLabel);

        this._drawLitTriangle(q, r, "up",   origin.x, origin.y);
        this._drawLitTriangle(q, r, "down", origin.x, origin.y);
      }
    }

    this._drawLightDebug(origin.x, origin.y);

    // Update the card surface's position to worldToLocal(0,0). This sets both
    // the PIXI container offset (cards pan with the viewport) and _x/_y (so
    // hitTestLayout translates LayoutWorld-local coords into raw world-space).
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
    this.lighting.dispose();
    this.sunCircle.destroy();
    this.sunLabel.destroy();
    for (const t of this.labelPool) t.destroy();
    this.labelPool.length = 0;
    for (const s of this.activeSprites) s.destroy();
    this.activeSprites.length = 0;
    for (const s of this.spritePool) s.destroy();
    this.spritePool.length = 0;
    super.destroy();
  }
}
