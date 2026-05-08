import { Graphics, Text } from "pixi.js";
import { GRID_W, GRID_H } from "./InventoryGame";
import { LayoutNode } from "../layout/LayoutNode";
import type { LayoutManager } from "../layout/LayoutManager";
import type { ZoneId } from "../../server/data/packing";

const MIN_WIDTH = 360;
const PREFERRED_FRACTION = 0.35;
const MAX_WIDTH = 600;

const GRID_COLOR = 0x2a3a4a;
const GRID_ALPHA_MAX = 0.8;
const GRID_FADE_LERP = 0.18;
const GRID_FADE_SNAP = 0.01;

export class LayoutInventory extends LayoutNode {
  static widthFor(screenWidth: number): number {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, screenWidth * PREFERRED_FRACTION));
  }

  private readonly bg = new Graphics();
  private readonly grid = new Graphics();
  private readonly label: Text;
  private readonly layoutManager: LayoutManager;
  private readonly zoneId: ZoneId;

  private gridTarget = 0;
  private gridAlpha = 0;

  constructor(layoutManager: LayoutManager, zoneId: ZoneId) {
    super();
    this.layoutManager = layoutManager;
    this.zoneId = zoneId;

    this.label = new Text({
      text: "Inventory",
      style: {
        fill: 0xcccccc,
        fontFamily: "sans-serif",
        fontSize: 24,
      },
    });
    this.label.anchor.set(0.5);

    this.container.addChild(this.bg);
    this.container.addChild(this.grid);
    this.container.addChild(this.label);

    layoutManager.register(zoneId, this);
  }

  showGrid(show: boolean): void {
    this.gridTarget = show ? GRID_ALPHA_MAX : 0;
    this.invalidate();
  }

  override destroy(): void {
    this.layoutManager.unregister(this.zoneId);
    super.destroy();
  }

  protected override layout(): boolean | void {
    this.container.sortableChildren = true;
    this.bg.clear();
    this.bg.rect(0, 0, this.width, this.height).fill({ color: 0x121922 });
    this.label.visible = this.children.length === 0;
    this.label.position.set(this.width / 2, this.height / 2);

    // Tween grid alpha toward target.
    const da = this.gridTarget - this.gridAlpha;
    if (Math.abs(da) < GRID_FADE_SNAP) {
      this.gridAlpha = this.gridTarget;
    } else {
      this.gridAlpha += da * GRID_FADE_LERP;
    }

    this.grid.clear();
    if (this.gridAlpha > 0) {
      this.grid.alpha = this.gridAlpha;
      const ox = (this.width % GRID_W) / 2;
      const oy = (this.height % GRID_H) / 2;
      for (let x = ox; x <= this.width; x += GRID_W) {
        this.grid.moveTo(x, 0).lineTo(x, this.height);
      }
      for (let y = oy; y <= this.height; y += GRID_H) {
        this.grid.moveTo(0, y).lineTo(this.width, y);
      }
      this.grid.stroke({ color: GRID_COLOR, width: 1 });
    }

    // Keep running while fading.
    return this.gridAlpha !== this.gridTarget;
  }
}
