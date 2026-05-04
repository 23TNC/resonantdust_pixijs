import { Graphics, Text } from "pixi.js";
import type { CardDefinition } from "../definitions/DefinitionManager";
import type { GameContext } from "../GameContext";
import { LayoutNode } from "../layout/LayoutNode";
import { decodeZoneTiles, TILE_SIZE, unpackMacroZone } from "./worldCoords";

const BG_COLOR    = "#0d1218";
const TILE_FILL   = "#141e28";
const TILE_STROKE = "#243040";
const TILE_STROKE_WIDTH = 1;
const LABEL_COLOR = "#3a4a5a";

function hexCorners(cx: number, cy: number, size: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6; // pointy-top
    pts.push(cx + size * Math.cos(a), cy + size * Math.sin(a));
  }
  return pts;
}

/**
 * Renders the world as a pointy-top hex tile grid.
 *
 * The "viewport" anchor from ZoneManager maps to the center of this node.
 * Tiles are drawn empty by default; when zone data arrives from DataManager
 * they are coloured using their CardDefinition's style palette.
 */
export class LayoutWorld extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly tiles = new Graphics();
  private readonly labelPool: Text[] = [];
  private readonly clipMask = new Graphics();

  /** Flat tile cache keyed by "${q},${r}". Populated from zone insert/update. */
  private readonly tileData = new Map<string, CardDefinition>();

  private viewQ = 0;
  private viewR = 0;

  private readonly unsubAnchor: () => void;
  private readonly unsubZones: () => void;

  constructor(ctx: GameContext) {
    super();
    this.container.addChild(this.bg);
    this.container.addChild(this.tiles);
    this.container.addChild(this.clipMask);
    this.container.mask = this.clipMask;

    this.unsubAnchor = ctx.zones.onAnchorChange((name: string, q: number, r: number) => {
      if (name !== "viewport") return;
      this.viewQ = q;
      this.viewR = r;
      this.invalidate();
    });

    this.unsubZones = ctx.data.subscribe("zones", (change) => {
      console.log(`[LayoutWorld] zone change kind=${change.kind} key=${change.key}`);
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
          this.tileData.set(`${tile.q},${tile.r}`, tile.definition);
        }
      }

      this.invalidate();
    });

    // Hydrate from zones already in the store.
    for (const zone of ctx.data.values("zones")) {
      for (const tile of decodeZoneTiles(zone, ctx.definitions)) {
        this.tileData.set(`${tile.q},${tile.r}`, tile.definition);
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
      x: this.width  / 2 + TILE_SIZE * (Math.sqrt(3) * dq + Math.sqrt(3) / 2 * dr),
      y: this.height / 2 + TILE_SIZE * (3 / 2 * dr),
    };
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

    this.tiles.clear();
    const range = Math.ceil(Math.max(w, h) / (TILE_SIZE * Math.sqrt(3))) + 2;

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

        if (x + TILE_SIZE < 0 || x - TILE_SIZE > w) continue;
        if (y + TILE_SIZE < 0 || y - TILE_SIZE > h) continue;

        const def = this.tileData.get(`${q},${r}`);
        const fill   = def ? def.style[0] : TILE_FILL;
        const stroke = def ? def.style[2] : TILE_STROKE;

        const pts = hexCorners(x, y, TILE_SIZE - 1);
        this.tiles
          .poly(pts).fill({ color: fill })
          .poly(pts).stroke({ color: stroke, width: TILE_STROKE_WIDTH });

        const labelText = def ? def.name : `${q},${r}`;
        const labelFill = def ? def.style[1] : LABEL_COLOR;
        const label = new Text({
          text: labelText,
          style: {
            fill: labelFill,
            fontFamily: "Segoe UI",
            fontSize: def ? 12 : 10,
            fontWeight: def ? "700" : "400",
            align: "center",
            wordWrap: true,
            wordWrapWidth: TILE_SIZE * Math.sqrt(3) - 8,
          },
        });
        label.anchor.set(0.5);
        // Defined tiles: title sits in the upper shoulder of the hex.
        // Empty tiles: coordinate label stays centered.
        label.position.set(x, def ? y - TILE_SIZE * 0.45 : y);
        this.container.addChild(label);
        this.labelPool.push(label);
      }
    }
  }

  override destroy(): void {
    this.unsubAnchor();
    this.unsubZones();
    for (const t of this.labelPool) t.destroy();
    this.labelPool.length = 0;
    super.destroy();
  }
}
