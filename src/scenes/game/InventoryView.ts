import { Graphics, Text } from "pixi.js";
import { LayoutNode } from "../../layout/LayoutNode";
import type { LayoutManager } from "../../layout/LayoutManager";
import type { ZoneId } from "../../zones/zoneId";

const MIN_WIDTH = 360;
const PREFERRED_FRACTION = 0.35;
const MAX_WIDTH = 600;

export class LayoutInventory extends LayoutNode {
  static widthFor(screenWidth: number): number {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, screenWidth * PREFERRED_FRACTION));
  }

  private readonly bg = new Graphics();
  private readonly label: Text;
  private readonly layoutManager: LayoutManager;
  private readonly zoneId: ZoneId;

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
    this.container.addChild(this.label);

    layoutManager.register(zoneId, this);
  }

  override destroy(): void {
    this.layoutManager.unregister(this.zoneId);
    super.destroy();
  }

  protected override layout(): void {
    this.bg.clear();
    this.bg.rect(0, 0, this.width, this.height).fill({ color: 0x121922 });
    this.label.visible = this.children.length === 0;
    this.label.position.set(this.width / 2, this.height / 2);
    // Cards self-position from game state; this surface just provides the host.
  }
}
