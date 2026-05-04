import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { GameContext } from "../GameContext";
import { LayoutNode } from "../layout/LayoutNode";
import { debug } from "../debug";
import { HEX_RADIUS, HEX_WIDTH, HEX_HEIGHT } from "../cards/HexCardVisual";
import { EMPTY_TILE_PACKED } from "../assets/TextureManager";
import { decodeZoneTiles, unpackMacroZone } from "./worldCoords";

const BG_COLOR    = "#0d1218";
const LABEL_COLOR = "#3a4a5a";

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

  constructor(ctx: GameContext) {
    super();
    this.container.addChild(this.bg);
    this.container.addChild(this.tileLayer);
    this.container.addChild(this.clipMask);
    this.container.mask = this.clipMask;

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

  /**
   * World q,r → screen x,y relative to this node's top-left.
   * The viewport anchor (viewQ, viewR) maps to the node's center.
   */
  private toScreen(q: number, r: number): { x: number; y: number } {
    const dq = q - this.viewQ;
    const dr = r - this.viewR;
    return {
      x: this.width  / 2 + HEX_RADIUS * (Math.sqrt(3) * dq + Math.sqrt(3) / 2 * dr),
      y: this.height / 2 + HEX_RADIUS * (3 / 2 * dr),
    };
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
        const { x, y } = this.toScreen(q, r);

        if (x + HEX_WIDTH  / 2 < 0 || x - HEX_WIDTH  / 2 > w) continue;
        if (y + HEX_HEIGHT / 2 < 0 || y - HEX_HEIGHT / 2 > h) continue;

        const packed = this.tileData.get(`${q},${r}`);

        const sprite = this._acquireSprite();
        if (packed !== undefined) {
          const def = this.ctx.definitions.decode(packed) ?? null;
          sprite.texture = this.ctx.textures.getHexTexture(def, packed);
        } else {
          sprite.texture = this.ctx.textures.getHexTexture(null, EMPTY_TILE_PACKED);
          /*
          const label = new Text({
            text: `${q},${r}`,
            style: {
              fill: LABEL_COLOR,
              fontFamily: "Segoe UI",
              fontSize: 10,
              fontWeight: "400",
              align: "center",
              wordWrap: true,
              wordWrapWidth: HEX_WIDTH - 8,
            },
          });
          label.anchor.set(0.5);
          label.position.set(x, y);
          this.container.addChild(label);
          this.labelPool.push(label);*/
        }
        sprite.position.set(x - HEX_WIDTH / 2, y - HEX_HEIGHT / 2);
      }
    }
  }

  override destroy(): void {
    this.unsubAnchor();
    this.unsubZones();
    for (const t of this.labelPool) t.destroy();
    this.labelPool.length = 0;
    for (const s of this.activeSprites) s.destroy();
    this.activeSprites.length = 0;
    for (const s of this.spritePool) s.destroy();
    this.spritePool.length = 0;
    super.destroy();
  }
}
