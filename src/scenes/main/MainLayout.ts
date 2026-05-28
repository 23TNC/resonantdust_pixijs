import type { GameContext } from "../../GameContext";
import { InventoryPanel } from "../../game/inventory/InventoryPanel";
import type { LayoutManager } from "../../game/layout/LayoutManager";
import { LayoutNode } from "../../game/layout/LayoutNode";
import { GameViewPanel } from "../../game/world/GameViewPanel";
import { DetailsPanel } from "../../game/details/DetailsPanel";
import {
  BLUEPRINTS_DEFAULT_WIDTH,
  BlueprintsPanel,
} from "../../game/blueprints/BlueprintsPanel";
import { getSoulBlueprintCapacity } from "../../game/blueprints/blueprintCapacity";
import { PanelTaskbar } from "../../ui/dom/PanelTaskbar";
import { PixiPanel } from "../../ui/dom/PixiPanel";
import type { DomZBand } from "../../ui/dom/DomPanel";
import { PLAYER_INVENTORY_LAYER } from "../../server/data/packing";

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
 *   - `blueprints` (taskbar-pinned `blueprintsHostPanel`).
 *
 * MainLayout's job is reduced to: hosting the always-on panels
 * (details, blueprints) as direct children, plus providing
 * `openInventoryPanel(soulId)` / `openGameViewPanel(soulId)` helpers
 * that route through PanelManager.
 */
export class MainLayout extends LayoutNode {
  // ── Always-on surfaces (built once at construction) ──────────────
  /** Blueprint grid for the active soul — drag a slot to craft.
   *  Lives inside `blueprintsHostPanel`'s content; visibility tracks
   *  the host's open / close state. Toolbar + wrench-toggle are
   *  retired; the taskbar entry on `blueprintsHostPanel` is the
   *  open / focus affordance now. */
  readonly blueprintsPanel: BlueprintsPanel;
  readonly blueprintsHostPanel: PixiPanel;
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
  /** Cleanup for the `blueprintsHostPanel.onRectChange` subscription
   *  — pushes body-rect changes into the inner `BlueprintsPanel`'s
   *  bounds so the grid re-flows when the user resizes the host. */
  private readonly unsubBlueprintsRect: () => void;
  /** Active-soul listener — refreshes the blueprints host panel's
   *  title bar (`Blueprints (active/max)`) when the player switches
   *  characters. */
  private readonly unsubBlueprintsSoul: () => void;
  /** `soul_privates` side-channel handler — refreshes the title
   *  whenever the active soul's blueprint count changes (a
   *  `request_blueprint` succeeds, or a blueprint dies and frees a
   *  slot via the `on_card_write` hook). */
  private readonly unsubBlueprintsSoulPrivate: () => void;


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
    // blueprints panel lives inside `blueprintsHostPanel`; details
    // panel inside `detailsHostPanel`. Only the drag overlay still
    // parents directly under MainLayout.
    this.blueprintsPanel = new BlueprintsPanel();
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
      title: "Details",
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

    // Blueprints PixiPanel — replaces the old left-edge `WrenchPanel`
    // + toolbar wrench button. Pinned to the bottom-left taskbar so
    // the user opens it from there (closing the panel keeps the
    // taskbar entry). Min/closable on so it minimizes to the bar
    // and can be dismissed entirely.
    this.blueprintsHostPanel = new PixiPanel({
      title: "Blueprints",
      parent: this.chooserLayer,
      storageKey: "gameBlueprintsPanel",
      defaultRect: {
        left:   "0",
        top:    `${PanelTaskbar.HEIGHT + 60}px`,
        width:  `${BLUEPRINTS_DEFAULT_WIDTH}px`,
        height: "400px",
      },
      minWidth:    200,
      minHeight:   200,
      pin:         "bottom-left",
      taskbarIcon: "🔧",
      pinned:      true,
      uiEditMode:  ctx.uiEditMode,
    });
    this.blueprintsHostPanel.content.addChild(this.blueprintsPanel);
    this.unsubBlueprintsRect = this.blueprintsHostPanel.onRectChange(() => {
      this.blueprintsPanel.setBounds(
        0, 0,
        this.blueprintsHostPanel.content.width,
        this.blueprintsHostPanel.content.height,
      );
    });

    // Title-bar capacity readout: `Blueprints (active/max)` where
    // both numbers reflect the currently-active soul. Refresh
    // hooks fire on three signals:
    //  1. Active soul changes (player switches characters).
    //  2. A `soul_privates` row update for the active soul (the
    //     server's `on_card_write` hook bumped or decremented
    //     `active_blueprints`).
    //  3. The active soul's *card* row updates — the cap derives
    //     from the soul def's `aspects.builder`, which is constant
    //     per def today, but the def changes if a soul is ever
    //     re-keyed; cheap to re-read either way.
    const refreshBlueprintsTitle = (): void => {
      const soulId = ctx.souls.getSoulId();
      if (soulId === null) {
        this.blueprintsHostPanel.setTitle("Blueprints");
        return;
      }
      const cap = getSoulBlueprintCapacity(ctx, soulId);
      this.blueprintsHostPanel.setTitle(`Blueprints (${cap.active}/${cap.max})`);
    };
    refreshBlueprintsTitle();
    this.unsubBlueprintsSoul = ctx.souls.on(() => refreshBlueprintsTitle());
    this.unsubBlueprintsSoulPrivate = ctx.data.subscriptions.registerTableHandlers(
      "soul_privates",
      {
        onInsert:  (row)            => { if (row.cardId    === ctx.souls.getSoulId()) refreshBlueprintsTitle(); },
        onUpdate:  (_oldRow, newRow) => { if (newRow.cardId === ctx.souls.getSoulId()) refreshBlueprintsTitle(); },
        onDelete:  (row)            => { if (row.cardId    === ctx.souls.getSoulId()) refreshBlueprintsTitle(); },
      },
    );

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
  }

  // ── PanelManager-routed open helpers ─────────────────────────────

  /** Open (or focus) the per-soul inventory panel for `soulCardId`.
   *  Routes through PanelManager so multiple souls can have their
   *  inventories open simultaneously. */
  openInventoryPanel(soulCardId: number): InventoryPanel {
    if (!this.gameContext.panels) {
      throw new Error("[MainLayout] ctx.panels must be set before opening inventory panels");
    }
    return this.gameContext.panels.ensure(
      `inventory:${soulCardId}`,
      () => new InventoryPanel(this.gameContext, this.inventoryLayer, soulCardId),
    );
  }

  /** Open (or focus) a chest-style mini inventory panel for
   *  `cardId`. Used when a card's `inventory` feature value is in
   *  `1..=9` — small caps render as a compact popover anchored near
   *  the click rather than the right-edge soul-style panel. The
   *  panel keys under `inventory:mini:${cardId}` so it coexists
   *  with the soul-mode panel for the same id and is still picked
   *  up by `panels.focused("inventory")` for the KeyE handler.
   *
   *  `anchorX` / `anchorY` are the viewport-pixel position to hang
   *  the panel above (the click coordinates passed in from the
   *  click handler). `capacity` is the max number of cards the
   *  inventory accepts — passed through to the panel for UI hints;
   *  server-side enforcement comes separately. */
  openMiniInventoryPanel(
    cardId: number,
    anchorX: number,
    anchorY: number,
    capacity: number,
  ): InventoryPanel {
    if (!this.gameContext.panels) {
      throw new Error("[MainLayout] ctx.panels must be set before opening inventory panels");
    }
    return this.gameContext.panels.ensure(
      `inventory:mini:${cardId}`,
      () => new InventoryPanel(this.gameContext, this.inventoryLayer, cardId, {
        mode: "mini",
        capacity,
        anchorX,
        anchorY,
      }),
    );
  }

  /** Open (or focus) the player-wide inventory panel — the account-
   *  scoped bucket shared across all of the player's souls. Mirror
   *  of `openInventoryPanel(soulCardId)` but keyed on
   *  `PLAYER_INVENTORY_LAYER (2)` instead of `INVENTORY_LAYER (1)`,
   *  with `macro_zone = player_id`. Single-instance per player. */
  openPlayerInventoryPanel(playerId: number): InventoryPanel {
    if (!this.gameContext.panels) {
      throw new Error("[MainLayout] ctx.panels must be set before opening player-inventory panel");
    }
    return this.gameContext.panels.ensure(
      `inventory:player:${playerId}`,
      () =>
        // Title composes in DomPanel — "Inventory" base + the
        // resolver registered by `InventoryPanel`'s constructor
        // (defaults to the "player" suffix in player-inventory
        // mode, matching the old pre-baked "Inventory - <name>"
        // shape and tracking name changes live).
        new InventoryPanel(this.gameContext, this.inventoryLayer, playerId, {
          surface: PLAYER_INVENTORY_LAYER,
        }),
    );
  }

  /** Open (or retarget) the game-view panel. Single-instance for
   *  now: clicking Play on a soul reuses whichever game-view panel
   *  is currently focused / most-recently-accessed and retargets
   *  its viewport + soul subscriptions to the new soul, instead of
   *  spawning a parallel panel. Multi-view ships once cards hold
   *  per-view visual copies; today cards register a single surface
   *  per zone with `LayoutManager`, so a second game-view panel
   *  can't render its own soul. */
  openGameViewPanel(soulCardId: number): GameViewPanel {
    if (!this.gameContext.panels) {
      throw new Error("[MainLayout] ctx.panels must be set before opening game-view panels");
    }
    // Reuse the currently-focused game-view (last-accessed = top
    // of the layer's stack) if one exists. `assignSoul` tears down
    // the old soul's subscriptions / anchor and installs the new
    // soul's, then recenters the viewport on the new soul's hex
    // once its row lands.
    const focused = this.gameContext.panels.focused("gameview");
    if (focused instanceof GameViewPanel) {
      focused.assignSoul(soulCardId);
      focused.focus();
      return focused;
    }
    return this.gameContext.panels.ensure(
      "gameview",
      () => new GameViewPanel(this.gameContext, this.gameviewLayer, "gameview", soulCardId),
    );
  }

  /** Open a soulless game-view anchored at world origin — surface 64,
   *  q/r (0, 0). `GameViewPanel`'s soulless mode defaults `surface` to
   *  `WORLD_LAYER` and the anchor to `(0, 0)`, so no options are
   *  needed. Used as a fixed testing entry point until soul-follow is
   *  rewired (see `MainScene.openDefaultSoulView`). */
  openWorldView(): GameViewPanel {
    if (!this.gameContext.panels) {
      throw new Error("[MainLayout] ctx.panels must be set before opening game-view panels");
    }
    return this.gameContext.panels.ensure(
      "gameview",
      () => new GameViewPanel(this.gameContext, this.gameviewLayer, "gameview", null),
    );
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

    // Blueprints host — same shape; destroy walks the inner
    // BlueprintsPanel via the host's content destruction.
    this.unsubBlueprintsRect();
    this.unsubBlueprintsSoul();
    this.unsubBlueprintsSoulPrivate();
    this.blueprintsHostPanel.destroy();

    super.destroy();
  }
}
