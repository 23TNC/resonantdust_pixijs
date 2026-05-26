import type { GameContext } from "../../../GameContext";
import type { LayoutNode } from "../../../game/layout/LayoutNode";
import type { ManagedPanel } from "../../../ui/panels/PanelManager";
import { PackContentsPanel } from "./PackContentsPanel";
import { PanelTaskbar } from "../../../ui/dom/PanelTaskbar";
import { PixiPanel } from "../../../ui/dom/PixiPanel";
import type { StarterPack } from "../../../game/definitions/DefinitionManager";

const DEFAULT_PACK_PREVIEW_WIDTH = 360;

/**
 * Pack-preview panel. Replaces the legacy "pack contents in the
 * inventory slot" hack with its own PanelManager-keyed window.
 *
 * Re-using the `packPreview` id with a different pack updates the
 * displayed pack in place (via `setPack`); PanelManager dedupes so
 * the second `ensure` returns the existing panel and we mutate
 * content rather than rebuilding.
 *
 * Singleton — keyed `"packPreview"` in PanelManager.
 */
export class PackPreviewPanel implements ManagedPanel {
  readonly panel: PixiPanel;
  private readonly contents: PackContentsPanel;
  private readonly unsubRect: () => void;
  private readonly ctx: GameContext;

  constructor(ctx: GameContext, parent: LayoutNode, pack: StarterPack) {
    this.ctx = ctx;
    this.contents = new PackContentsPanel(ctx);
    this.contents.setPack(pack);

    this.panel = new PixiPanel({
      title: "Pack Preview",
      parent,
      storageKey: "packPreviewPanel",
      defaultRect: {
        right:  `${DEFAULT_PACK_PREVIEW_WIDTH + 20}px`,
        top:    `${PanelTaskbar.HEIGHT + 60}px`,
        width:  `${DEFAULT_PACK_PREVIEW_WIDTH}px`,
        height: `calc(100vh - ${PanelTaskbar.HEIGHT * 2}px)`,
      },
      minWidth:    260,
      minHeight:   240,
      minimizable: true,
      closable:    true,
      taskbar:     ctx.taskbar,
      uiEditMode:  ctx.uiEditMode,
    });
    this.panel.content.addChild(this.contents);

    this.unsubRect = this.panel.onRectChange(() => {
      this.contents.setBounds(
        0, 0,
        this.panel.content.width,
        this.panel.content.height,
      );
    });

    // Register the interior PackContentsPanel so a body click on
    // the pack contents routes back to this panel for focus.
    ctx.panels?.registerNode(this.contents, this);
    this.panel.onDestroy(() => this.cleanup());
  }

  focus(): void { this.panel.focus(); }
  destroy(): void { this.panel.destroy(); }
  onFocus(cb: () => void): () => void { return this.panel.onFocus(cb); }
  onDestroy(cb: () => void): () => void { return this.panel.onDestroy(cb); }

  /** Update the previewed pack in place (no panel destroy/recreate). */
  setPack(pack: StarterPack): void {
    this.contents.setPack(pack);
  }

  private cleanup(): void {
    this.unsubRect();
    this.ctx.panels?.unregisterNode(this.contents);
  }
}
