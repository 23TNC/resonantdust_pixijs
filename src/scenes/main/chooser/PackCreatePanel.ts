import type { GameContext } from "../../../GameContext";
import type { LayoutNode } from "../../../game/layout/LayoutNode";
import type { ManagedPanel } from "../../../ui/panels/PanelManager";
import { PackChooserPanel } from "./PackChooserPanel";
import { PanelTaskbar } from "../../../ui/dom/PanelTaskbar";
import { PixiPanel } from "../../../ui/dom/PixiPanel";
import type { StarterPack } from "../../../game/definitions/DefinitionManager";

/** Souls offered in the character-create flow. Today only `"human"`
 *  ships starter packs; the chooser renders one section per entry so
 *  adding more is data-only. */
const CREATE_SOULS: readonly string[] = ["human"];

/** Initial width for the create-character chooser panel. */
const DEFAULT_PACK_CREATE_WIDTH = 480;

/**
 * Character-create panel. Replaces the legacy browse-mode `"create"`
 * sub-mode that swapped content inside the chooser PixiPanel: with
 * PanelManager driving every panel as an independent window, the
 * create flow becomes its own panel.
 *
 * Hosts a `PackChooserPanel` content node. Its `onSelect(pack)`
 * callback opens (or focuses) the paired `packPreview` panel for the
 * selected pack; `onCreate(pack)` fires the `createCharacter`
 * reducer and bridges into the new soul's inventory + game-view
 * panels when the row arrives. `onBack` closes this panel and
 * focuses the `chooser` (the user's home base).
 *
 * Singleton — keyed `"packCreate"` in PanelManager.
 */
export class PackCreatePanel implements ManagedPanel {
  readonly panel: PixiPanel;
  private readonly chooserContent: PackChooserPanel;
  private readonly unsubRect: () => void;
  private readonly ctx: GameContext;

  constructor(
    ctx: GameContext,
    parent: LayoutNode,
    onPackSelected: (pack: StarterPack) => void,
    onCreateRequested: (pack: StarterPack) => void,
  ) {
    this.ctx = ctx;
    this.chooserContent = new PackChooserPanel(
      ctx,
      CREATE_SOULS,
      (pack) => onPackSelected(pack),
      (pack) => onCreateRequested(pack),
      () => {
        // "Back" from the pack chooser closes this panel and lets
        // the always-pinned `chooser` panel take focus again.
        this.destroy();
        ctx.panels?.get("chooser")?.focus();
      },
    );

    this.panel = new PixiPanel({
      title: "Create Character",
      parent,
      storageKey: "packCreatePanel",
      defaultRect: {
        right:  "0",
        top:    `${PanelTaskbar.HEIGHT}px`,
        width:  `${DEFAULT_PACK_CREATE_WIDTH}px`,
        height: `calc(100vh - ${PanelTaskbar.HEIGHT * 2}px)`,
      },
      minWidth:   360,
      minHeight:  400,
      minimizable: true,
      closable:    true,
      taskbar:     ctx.taskbar,
      uiEditMode:  ctx.uiEditMode,
    });
    this.panel.content.addChild(this.chooserContent);

    this.unsubRect = this.panel.onRectChange(() => {
      this.chooserContent.setBounds(
        0, 0,
        this.panel.content.width,
        this.panel.content.height,
      );
    });

    // Register the interior PackChooserPanel so a body click on
    // the pack list routes back to this panel for focus.
    ctx.panels?.registerNode(this.chooserContent, this);
    this.panel.onDestroy(() => this.cleanup());
  }

  focus(): void { this.panel.focus(); }
  destroy(): void { this.panel.destroy(); }
  onFocus(cb: () => void): () => void { return this.panel.onFocus(cb); }
  onDestroy(cb: () => void): () => void { return this.panel.onDestroy(cb); }

  /** Reflect a pack selection from the paired preview panel back to
   *  the chooser highlight. */
  setSelectedPackId(id: number | null): void {
    this.chooserContent.setSelectedPackId(id);
  }

  private cleanup(): void {
    this.unsubRect();
    this.ctx.panels?.unregisterNode(this.chooserContent);
  }
}
