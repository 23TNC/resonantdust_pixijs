import { LayoutNode } from "../../game/layout/LayoutNode";
import type { LayoutManager } from "../../game/layout/LayoutManager";
import type { GameContext } from "../../GameContext";
import type { ZoneId } from "../../server/data/packing";
import { LayoutInventory } from "../../game/inventory/InventoryLayout";
import { LayoutWorld } from "../../game/world/LayoutWorld";
import { TitleBar } from "../../game/titlebar/TitleBar";
import { ToolBar } from "../../game/toolbar/ToolBar";
import { ChatPanel } from "../../game/chat/ChatPanel";
import { DetailsPanel } from "../../game/details/DetailsPanel";

/**
 * Hit-transparent host for in-flight UI (drag previews, tooltips). Sits on
 * top of every other child of GameLayout, so it draws above them, but
 * hit-testing skips it entirely — clicks fall through to the surfaces
 * underneath. Cards parented here while dragging don't catch their own
 * drop-time hit-test either (the up-event needs to find the drop target
 * beneath the card, not the card itself).
 */
class OverlayNode extends LayoutNode {
  protected override intersects(): boolean {
    return false;
  }
}

export class GameLayout extends LayoutNode {
  readonly titleBar: TitleBar;
  readonly toolBar: ToolBar;
  readonly detailsPanel: DetailsPanel;
  readonly chatPanel: ChatPanel;
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
    ctx: GameContext,
    playerName: string,
    layoutManager: LayoutManager,
    inventoryZoneId: ZoneId,
  ) {
    super();
    this.titleBar = new TitleBar(playerName);
    this.toolBar = new ToolBar();
    this.detailsPanel = new DetailsPanel();
    this.chatPanel = new ChatPanel(ctx);
    this.worldView = new LayoutWorld(ctx, layoutManager);
    this.inventoryView = new LayoutInventory(layoutManager, inventoryZoneId);
    this.overlay = new OverlayNode();
    // Render order matters here. LayoutWorld has no clip mask — anything
    // inside it that bleeds outside the world's rect (e.g. a world card
    // whose Pixi-pan position drifts past the world edge) relies on the
    // adjacent views drawing afterward to cover the bleed. So:
    //   1. worldView     — draws first (any bleed lands underneath).
    //   2. titleBar      — covers bleed above the world.
    //   3. toolBar       — top-left strip, sits on top of the world.
    //   4. detailsPanel  — below toolbar, overlays the world.
    //   5. chatPanel     — bottom-left chat / logs, sits on top of the world.
    //   6. inventoryView — covers bleed to the right of the world.
    //   7. overlay       — drag previews / tooltips, always on top.
    this.addChild(this.worldView);
    this.addChild(this.titleBar);
    this.addChild(this.toolBar);
    this.addChild(this.detailsPanel);
    this.addChild(this.chatPanel);
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
    this.toolBar.setBounds(0, bodyTop, ToolBar.WIDTH, ToolBar.HEIGHT);
    // Details panel floats over the world, flush against the left edge of
    // the inventory. Height varies with compact/expanded state and is zero
    // when no subject is selected (panel hidden).
    const detailsX = worldW - DetailsPanel.WIDTH;
    const detailsH = this.detailsPanel.currentHeight;
    this.detailsPanel.setBounds(detailsX, bodyTop, DetailsPanel.WIDTH, detailsH);
    // Chat panel pinned to the bottom-left of the world area.
    const chatW = Math.min(this.chatPanel.preferredWidth, worldW);
    const chatH = Math.min(this.chatPanel.preferredHeight, bodyH);
    this.chatPanel.setBounds(0, this.height - chatH, chatW, chatH);
    this.inventoryView.setBounds(worldW, bodyTop, inventoryW, bodyH);
    this.overlay.setBounds(0, 0, this.width, this.height);
  }
}
