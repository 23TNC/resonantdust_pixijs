import type { GameContext } from "../../GameContext";
import { ViewportPanel, type ViewportOpts } from "../../game/viewport/ViewportPanel";
import { HexGrid } from "../../game/viewport/hex/HexGrid";
import { RectGrid } from "../../game/viewport/rect/RectGrid";
import { WORLD_HEX_RADIUS } from "../../game/viewport/hex/hexSize";
import { GRID_W, GRID_H } from "../../game/viewport/rect/GridInventory";
import type { LayoutManager } from "../../game/layout/LayoutManager";
import { LayoutNode } from "../../game/layout/LayoutNode";
import { DetailsPanel } from "../../game/panels/details/DetailsPanel";
import { panelTitle, panelText } from "../../game/panels/panelStrings";
import { PanelTaskbar } from "../../ui/dom/PanelTaskbar";
import { PixiPanel } from "../../ui/dom/PixiPanel";
import type { DomZBand } from "../../ui/dom/DomPanel";
import { INVENTORY_LAYER, WORLD_LAYER, ZONE_SIZE } from "../../server/data/packing";

/** Midpoint cell of a single-chunk board (cells `0..ZONE_SIZE-1`). Used as the
 *  inventory viewport's anchor so a `"center"` origin centres the whole board
 *  in the panel rather than pinning cell (0,0) to the top-left. */
const BOARD_CENTER = (ZONE_SIZE - 1) / 2;

/** Right-edge offset (in px) used for default rects of panels that
 *  want to sit inset from the right edge — a layout baseline. */
const DEFAULT_RIGHT_PANEL_OFFSET = 460;

/** Default width / height for the details PixiPanel. Matches the
 *  inner `DetailsPanel` LayoutNode's intrinsic width (320) plus
 *  enough room for the expanded description. */
const DEFAULT_DETAILS_WIDTH  = 320;
const DEFAULT_DETAILS_HEIGHT = 260;

/**
 * Hit-transparent host for in-flight UI (drag previews, tooltips). Sits
 * on top of every other child, so it draws above them, but hit-testing
 * skips it entirely — clicks fall through to the surfaces underneath.
 * Cards parented here while dragging don't catch their own drop-time
 * hit-test either.
 */
class OverlayNode extends LayoutNode {
  protected override intersects(): boolean {
    return false;
  }
}

/**
 * Z-ordering pass-through container. Holds panels at a particular
 * z-tier (game-view / inventory / chooser); doesn't set its own
 * bounds (would force a layout pass on every resize). Hit-testing
 * descends into children directly without checking this node's own
 * `intersects`, and never returns `this` as the hit — so empty
 * spots within the layer fall through to siblings (or to the world
 * underneath if everything misses).
 */
class LayerNode extends LayoutNode {
  /** DOM z-band tag — read duck-typed by `PixiPanel` to derive
   *  its `domZBand` so DOM panel z-indices respect the same
   *  game-view / inventory / overlay ordering as the Pixi-side
   *  layers. */
  readonly band: DomZBand;
  constructor(band: DomZBand) {
    super();
    this.band = band;
  }
  override hitTestLayout(parentX: number, parentY: number): LayoutNode | null {
    if (!this.container.visible) return null;
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
 * Scene layout for the unified post-login surface. There are no
 * browse/play modes — every panel is independent and managed by
 * `ctx.panels` (PanelManager):
 *
 *   - `inventory:<soulId>` (per-soul, multiple) — independent panels
 *     for each soul's inventory.
 *   - `gameview:<soulId>` (per-soul, multiple) — each holds its own
 *     LayoutWorld + viewport + soul subscriptions.
 *   - `details` (singleton, wrapped in `detailsHostPanel`) — opens
 *     on card click via `detailsPanel.show(...)`.
 *
 * MainLayout's job is reduced to: hosting the always-on details panel
 * as a direct child, plus providing `openInventoryPanel(soulId)` /
 * `openGameViewPanel(soulId)` helpers that route through PanelManager.
 */
export class MainLayout extends LayoutNode {
  // ── Always-on surfaces (built once at construction) ──────────────
  /** The actual details renderer — a `LayoutNode` that draws the
   *  card-info Pixi visuals. `MainScene` calls `show()` / `hide()` /
   *  `handleClick()` on it directly; the PixiPanel wrapper
   *  (`detailsHostPanel`) follows its `onVisibilityChange` event. */
  readonly detailsPanel: DetailsPanel;
  /** PixiPanel wrapping `detailsPanel`. Auto-opens on
   *  `detailsPanel.show(...)` and auto-closes on `hide()` via the
   *  visibility subscription wired in the constructor. User can
   *  drag / resize / anchor it like every other PixiPanel. */
  readonly detailsHostPanel: PixiPanel;
  readonly overlay: LayoutNode;

  // ── Z-ordered layer containers ───────────────────────────────────
  // Panels parent themselves to one of these layers (via `parent:`
  // in their PixiPanel options) so categories stack predictably:
  //
  //   gameviewLayer   (zIndex 0)   — game-view panels
  //   inventoryLayer  (zIndex 1)   — inventory panels
  //   chooserLayer    (zIndex 2)   — chooser, details, blueprints
  //   overlay         (zIndex 1000) — drag previews (frontmost)
  //
  // Children added to a layer inherit the layer's zIndex relative to
  // siblings of MainLayout; within a layer, children stack in their
  // own add order (default zIndex 0 each). PixiPanel adds 3-4
  // children per panel (content, chrome, resizeIndicator, optional
  // mask) — all go to the panel's chosen layer so the whole panel
  // moves as a unit.
  readonly gameviewLayer:  LayoutNode;
  readonly inventoryLayer: LayoutNode;
  readonly chooserLayer:   LayoutNode;

  /** Cleanup for the `detailsHostPanel.onRectChange` subscription —
   *  same shape as the world / inventory rect listeners, but for
   *  the details host. The inner `DetailsPanel` draws at its own
   *  fixed `WIDTH`×`currentHeight` so we just push the panel's body
   *  rect into `detailsPanel.setBounds` for container positioning;
   *  the panel's intrinsic content size doesn't change with the
   *  host's outer size. */
  private readonly unsubDetailsRect: () => void;
  /** Cleanup for the `detailsPanel.onVisibilityChange` subscription
   *  that drives `detailsHostPanel.open()` / `close()`. */
  private readonly unsubDetailsVisibility: () => void;
  /** Cleanup for the reverse subscription: when the user closes
   *  the host panel (X button), mirror that into the inner
   *  panel's `hide()` so its `_isVisible` flag clears. Without
   *  this, the inner stays visible-but-orphaned and the next
   *  `show()` call short-circuits at the `_isVisible === true`
   *  early-return in `setVisible`, leaving the host stuck
   *  closed. */
  private readonly unsubDetailsHostOpen: () => void;
  /** Cleanup for the `detailsPanel.onSizeChange` subscription that
   *  feeds `currentHeight` into `detailsHostPanel.setContentNaturalHeight`,
   *  so the host (when in `"auto"` heightMode) tracks the inner
   *  panel's compact ↔ expanded toggles. */
  private readonly unsubDetailsSize: () => void;


  // ── External wiring ──────────────────────────────────────────────
  private readonly gameContext: GameContext;
  private readonly layoutManager: LayoutManager;
  private readonly playerId: number;

  constructor(ctx: GameContext, playerId: number) {
    super();
    if (!ctx.layout) {
      throw new Error("[MainLayout] ctx.layout must be set before constructing MainLayout");
    }
    this.gameContext = ctx;
    this.layoutManager = ctx.layout;
    this.playerId = playerId;

    // Always-on Pixi surfaces. World views live inside individual
    // `GameViewPanel` instances now (created on demand via
    // `openGameViewPanel(soulId)` and tracked by PanelManager);
    // details panel inside `detailsHostPanel`. Only the drag overlay
    // still parents directly under MainLayout.
    this.detailsPanel = new DetailsPanel();
    this.overlay = new OverlayNode();

    // Z-ordered layer containers. Built before any panel constructor
    // runs so panels parent into the right layer from the start.
    // We rely on insertion order — gameview added first (back),
    // overlay last (front). `sortableChildren` is intentionally NOT
    // set on the layer containers: panels manage their own
    // within-layer Z order via `LayoutNode.bringToFront` (triggered
    // by `PixiPanel.onFocus`), and Pixi's sortable-children would
    // override the explicit `setChildIndex` call.
    this.gameviewLayer  = new LayerNode("gameview");
    this.inventoryLayer = new LayerNode("inventory");
    this.chooserLayer   = new LayerNode("overlay");
    this.addChild(this.gameviewLayer);
    this.addChild(this.inventoryLayer);
    this.addChild(this.chooserLayer);
    this.addChild(this.overlay);

    // Details PixiPanel — wraps the existing `DetailsPanel` LayoutNode
    // (now lives as content). Defaults to a 320×260 surface tucked
    // just left of the inventory panel. Stays closed until something
    // is selected; `detailsPanel.show(...)` fires `onVisibilityChange`
    // which opens this host. Closable so the user can dismiss it.
    this.detailsHostPanel = new PixiPanel({
      title: panelTitle("gameDetailsPanel"),
      parent: this.chooserLayer,
      storageKey: "gameDetailsPanel",
      defaultRect: {
        right:  `${DEFAULT_RIGHT_PANEL_OFFSET}px`,
        top:    `${PanelTaskbar.HEIGHT + 60}px`,
        width:  `${DEFAULT_DETAILS_WIDTH}px`,
        height: `${DEFAULT_DETAILS_HEIGHT}px`,
      },
      minWidth:    260,
      minHeight:   140,
      minimizable: true,
      closable:    true,
      uiEditMode:  ctx.uiEditMode,
      // First-launch default — the inner DetailsPanel toggles
      // between compact and expanded, so we want the host to grow
      // and shrink with it. User can override from the popup; the
      // choice persists.
      heightMode:  "auto",
    });
    this.detailsHostPanel.content.addChild(this.detailsPanel);
    // Seed the host's natural height with whatever the inner panel
    // reports now (typically 0 — hidden — until a card click fires
    // `show`). The `onSizeChange` subscription below keeps it
    // updated.
    this.detailsHostPanel.setContentNaturalHeight(this.detailsPanel.currentHeight);

    // Bounds sync — `DetailsPanel.layout()` uses fixed 320 × variable
    // height regardless of the host's size, so this just parks the
    // node at the host body's origin. If a future refactor makes
    // DetailsPanel responsive, this is where the size flows in.
    this.unsubDetailsRect = this.detailsHostPanel.onRectChange(() => {
      this.detailsPanel.setBounds(
        0, 0,
        this.detailsHostPanel.content.width,
        this.detailsHostPanel.content.height,
      );
    });

    // Open / close the host in lockstep with the inner panel's
    // visibility. `show()`/`hide()` are the canonical control
    // surface (MainScene calls them on card / tile clicks); this
    // subscription means callers don't have to know the host
    // exists.
    this.unsubDetailsVisibility = this.detailsPanel.onVisibilityChange((visible) => {
      if (visible && !this.detailsHostPanel.isOpen) this.detailsHostPanel.open();
      else if (!visible && this.detailsHostPanel.isOpen) this.detailsHostPanel.close();
    });
    // Reverse-sync: user-driven host close (X button) clears the
    // inner panel's visibility so the next `show()` is a real
    // false→true transition that the visibility listener above
    // can act on. Without this, clicking a card after closing
    // the panel does nothing — `setVisible(true)` early-returns
    // and never re-opens the host.
    this.unsubDetailsHostOpen = this.detailsHostPanel.onOpenChange((open) => {
      if (!open && this.detailsPanel.isVisible) this.detailsPanel.hide();
    });

    // Push natural-height updates into the host so `"auto"`
    // heightMode can resize the outer panel on compact ↔ expanded
    // flips. No-op when the user has set heightMode to a fixed
    // mode in the settings popup.
    this.unsubDetailsSize = this.detailsPanel.onSizeChange((height) => {
      this.detailsHostPanel.setContentNaturalHeight(height);
    });

    // The inventory PixiPanels are constructed *after* this point (via
    // the `open*` panel helpers) and each one's `parent:` option
    // appends its Pixi `content`
    // to *this* layout's container — which would land them *after*
    // `overlay` in child order and draw drag previews behind the
    // inventory cards. Use Pixi's `sortableChildren` + an explicit
    // high `zIndex` on `overlay` so it always renders last regardless
    // of when other panels get added. Default `zIndex` is 0 so
    // every panel's content / chrome / indicator naturally tile
    // beneath.
    this.container.sortableChildren = true;
    this.overlay.zIndex = 1000;
    // Carried stack runs reparent here during a drag; sort them by the same
    // signed stack-z the resting stack hosts use so a bottom-carry keeps the
    // inner card in front mid-drag. Only one drag gesture populates the overlay
    // at a time (a carried run or a single soul ghost), so this never reorders
    // unrelated previews.
    this.overlay.container.sortableChildren = true;
  }

  // ── PanelManager-routed open helpers ─────────────────────────────

  /** Title-suffix resolvers shared by every viewport — player name always,
   *  plus the viewer soul's card name when `soulId` is set. */
  private titleResolvers(soulId: number | null) {
    const ctx = this.gameContext;
    return {
      player: () => ctx.playerSession.getPlayer()?.name ?? null,
      ...(soulId !== null
        ? {
            soul: () => {
              const row = ctx.data.cardsLocal.get(soulId);
              return row ? ctx.definitions.label(row.packedDefinition) : null;
            },
          }
        : {}),
    };
  }

  /** Get-or-create a viewport panel keyed `viewport:<surface>:<owner>`. On
   *  reuse, retargets the viewer (e.g. playing a different soul in the world
   *  view) instead of spawning a parallel panel. `PanelManager.ensure` focuses. */
  private openViewport(layer: LayoutNode, opts: ViewportOpts): ViewportPanel {
    const panels = this.gameContext.panels;
    if (!panels) throw new Error("[MainLayout] ctx.panels must be set before opening viewports");
    const panel = panels.ensure(
      `viewport:${opts.id}`,
      () => new ViewportPanel(this.gameContext, layer, opts),
    );
    if (opts.viewer !== null && panel.currentViewer !== opts.viewer) {
      panel.assignViewer(opts.viewer);
    }
    return panel;
  }

  /** Open the world viewport (hex, pannable, owner 0). `viewer` is the soul the
   *  camera follows + activates on focus; `null` = a soulless fixed view. */
  openWorldView(viewer: number | null = null): ViewportPanel {
    return this.openViewport(this.gameviewLayer, {
      id: `${WORLD_LAYER}:0`,
      grid: new HexGrid(WORLD_HEX_RADIUS),
      surface: WORLD_LAYER,
      owner: 0,
      viewer,
      pan: true,
      occupancy: false,
      follow: viewer !== null,
      origin: "center",
      singleChunk: false,
      initialQ: 0,
      initialR: 0,
      title: panelTitle("gameViewPanel"),
      titleSuffix: viewer !== null ? "soul" : "player",
      titleSuffixResolvers: this.titleResolvers(viewer),
      storageKey: `gameViewPanel:${WORLD_LAYER}:0`,
      defaultsKey: "gameViewPanel",
      defaultRect: {
        left: "0",
        top: `${PanelTaskbar.HEIGHT}px`,
        width: "800px",
        height: `calc(100vh - ${PanelTaskbar.HEIGHT * 2}px)`,
      },
      minWidth: 400,
      minHeight: 400,
      taskbar: this.gameContext.taskbar,
    });
  }

  /** Backwards-compat alias: open the world view following `soulCardId`. */
  openGameViewPanel(soulCardId: number): ViewportPanel {
    return this.openWorldView(soulCardId);
  }

  /** Open the inventory viewport for soul `owner` (rect, pannable, single-chunk
   *  occupancy). The viewer is the owner for now (viewing your own bucket);
   *  ally-viewing will pass the player's active soul instead. A player's own
   *  inventory is just the inventory of their `player_soul` card — there's no
   *  separate player-inventory bucket. */
  openInventoryPanel(owner: number): ViewportPanel {
    return this.openViewport(this.inventoryLayer, {
      id: `${INVENTORY_LAYER}:${owner}`,
      grid: new RectGrid(GRID_W, GRID_H),
      surface: INVENTORY_LAYER,
      owner,
      viewer: owner,
      pan: true,
      occupancy: true,
      follow: false,
      // Centre the 8×8 board in the panel (matches the world view's centred
      // origin). The anchor sits at the board's midpoint cell so a `"center"`
      // origin puts the board centre at the panel centre; resizing the panel
      // larger keeps the board centred instead of top-left-pinned.
      origin: "center",
      singleChunk: true,
      initialQ: BOARD_CENTER,
      initialR: BOARD_CENTER,
      title: panelTitle("gameInventoryPanel"),
      titleSuffix: "soul",
      titleSuffixResolvers: this.titleResolvers(owner),
      storageKey: `gameInventoryPanel:${INVENTORY_LAYER}:${owner}`,
      defaultsKey: "gameInventoryPanel",
      defaultRect: {
        right: "0",
        top: `${PanelTaskbar.HEIGHT}px`,
        width: "440px",
        height: `calc(100vh - ${PanelTaskbar.HEIGHT * 2}px)`,
      },
      minWidth: 320,
      minHeight: 400,
      taskbar: this.gameContext.taskbar,
    });
  }

  // ── Layout pass ──────────────────────────────────────────────────

  protected override layout(): void {
    // Overlay always covers the full viewport — drag previews work
    // in either mode and span the whole canvas regardless of where
    // the world / inventory / details / blueprints panels sit. Every
    // other surface owns its own bounds via its wrapping PixiPanel.
    this.overlay.setBounds(0, 0, this.width, this.height);
  }

  override destroy(): void {
    // Per-soul inventory + game-view panels are owned by
    // `ctx.panels` now — `MainScene.onExit` calls `panels.closeAll()`
    // before this method runs, so each panel's own teardown has
    // already disposed its `GameInventory` / zone refs / soul subs.
    // Nothing for MainLayout to do for them here.

    // Details host — same shape. The visibility + size
    // subscriptions have to come down before the host so the
    // close() / setContentNaturalHeight() they'd fire can't trigger
    // a no-op on a destroyed host.
    this.unsubDetailsVisibility();
    this.unsubDetailsHostOpen();
    this.unsubDetailsSize();
    this.unsubDetailsRect();
    this.detailsHostPanel.destroy();

    super.destroy();
  }
}
