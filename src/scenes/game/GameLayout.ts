import { LayoutNode } from "../../layout/LayoutNode";
import type { LayoutManager } from "../../layout/LayoutManager";
import type { ZoneId } from "../../zones/zoneId";
import { LayoutInventory } from "./InventoryView";
import { LayoutWorld } from "./WorldView";
import { TitleBar } from "./TitleBar";

export class GameLayout extends LayoutNode {
  readonly titleBar: TitleBar;
  readonly worldView: LayoutWorld;
  readonly inventoryView: LayoutInventory;
  /**
   * Top-most surface used for drag previews and other in-flight UI.
   * Last child so it draws above the title bar / world / inventory.
   * `LayoutManager.overlay` points at this; cards re-parent here while
   * dragging.
   */
  readonly overlay: LayoutNode;

  constructor(
    playerName: string,
    layoutManager: LayoutManager,
    inventoryZoneId: ZoneId,
  ) {
    super();
    this.titleBar = new TitleBar(playerName);
    this.worldView = new LayoutWorld();
    this.inventoryView = new LayoutInventory(layoutManager, inventoryZoneId);
    this.overlay = new LayoutNode();
    this.addChild(this.titleBar);
    this.addChild(this.worldView);
    this.addChild(this.inventoryView);
    this.addChild(this.overlay);
  }

  protected override layout(): void {
    const titleH = TitleBar.HEIGHT;
    const inventoryW = LayoutInventory.widthFor(this.width);
    const bodyTop = titleH;
    const bodyH = Math.max(0, this.height - titleH);
    const worldW = Math.max(0, this.width - inventoryW);

    this.titleBar.setBounds(0, 0, this.width, titleH);
    this.worldView.setBounds(0, bodyTop, worldW, bodyH);
    this.inventoryView.setBounds(worldW, bodyTop, inventoryW, bodyH);
    this.overlay.setBounds(0, 0, this.width, this.height);
  }
}
