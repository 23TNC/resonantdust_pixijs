import type { GameContext } from "../../GameContext";
import type { LayoutNode } from "../layout/LayoutNode";
import type { CellGrid } from "./CellGrid";
import { LayoutWorld } from "./LayoutWorld";
import { PanController } from "./PanController";
import { GridInventory } from "./rect/GridInventory";
import type { ManagedPanel } from "../../ui/panels/PanelManager";
import { PixiPanel } from "../../ui/dom/PixiPanel";
import type { DomPanelRect, TitleSuffix, TitleSuffixResolver } from "../../ui/dom/DomPanel";
import type { PanelTaskbar } from "../../ui/dom/PanelTaskbar";
import { decodeMicro, makeMacroZone, microIsCard, microLooseCell, WORLD_LAYER } from "../../server/data/packing";
import { tryActivateSoul } from "../permissions";

/**
 * The one viewport panel. A viewport is `(surface, owner)` shown on a
 * `CellGrid`, viewed by a `viewer` soul — the world, a mini-zone, and an
 * inventory are all the same panel, differing only by these flags:
 *
 *  - **grid**: `HexGrid` (world) vs `RectGrid` (inventory) — pure render shape.
 *  - **pan**: wire a `PanController` (drag-pan + Space-recenter) or stay fixed.
 *  - **occupancy**: wire `GridInventory` (one-card-per-cell snap) or leave
 *    placement loose (world).
 *  - **viewer**: the perspective soul (`card_id`), distinct from the zone
 *    `owner`. Drives focus-activation, soul-data subscription, and (with
 *    `follow`) camera-recenter on the viewer's world position. The
 *    permission-gated visibility of a non-owned `owner`'s zone is a future
 *    layer keyed on viewer↔owner; `viewer` is the field it'll read.
 *
 * Zone subscription is uniform: the panel sets an owner-aware anchor
 * (`setAnchor(name, q, r, surface, owner)`), so `recomputeAnchorZones`
 * subscribes the chunks around it for THIS `(owner, surface)`. (The panel-less
 * background subscription — recipes ticking on owned souls with no window open
 * — stays with `SoulManager.ensureInventory`.)
 */
export interface ViewportOpts {
  id: string;
  grid: CellGrid;
  surface: number;
  owner: number;
  /** Perspective soul card_id, or null (soulless world). */
  viewer: number | null;
  pan: boolean;
  /** One-card-per-cell snap placement (inventory) vs loose (world). */
  occupancy: boolean;
  /** Recenter the viewport on the viewer's world position (world camera). */
  follow: boolean;
  origin: "center" | "topleft";
  singleChunk: boolean;
  initialQ: number;
  initialR: number;
  // --- PixiPanel chrome ---
  title: string;
  titleSuffix?: TitleSuffix;
  titleSuffixResolvers?: Partial<Record<TitleSuffix, TitleSuffixResolver>>;
  storageKey: string;
  defaultsKey: string;
  defaultRect: DomPanelRect;
  minWidth: number;
  minHeight: number;
  /** Taskbar to register a tab with; omit for ephemeral popovers. */
  taskbar?: PanelTaskbar;
}

export class ViewportPanel implements ManagedPanel {
  readonly panel: PixiPanel;
  readonly layoutWorld: LayoutWorld;
  readonly panController: PanController | null;
  readonly gridInventory: GridInventory | null;
  readonly id: string;
  readonly surface: number;
  readonly owner: number;
  private viewer: number | null;
  private readonly follow: boolean;
  private readonly ctx: GameContext;
  private readonly anchorName: string;
  /** Cleanup fns for the current viewer's soul subscriptions + recenter wait.
   *  Replaced wholesale on `assignViewer`. Empty when `viewer == null`. */
  private viewerCleanup: Array<() => void> = [];
  private readonly unsubRect: () => void;
  private destroyed = false;

  constructor(ctx: GameContext, parent: LayoutNode, opts: ViewportOpts) {
    if (!ctx.layout) throw new Error("[ViewportPanel] ctx.layout must be set");
    if (!ctx.input) throw new Error("[ViewportPanel] ctx.input must be set");

    this.ctx = ctx;
    this.id = opts.id;
    this.surface = opts.surface;
    this.owner = opts.owner;
    this.viewer = opts.viewer;
    this.follow = opts.follow;
    this.anchorName = `viewport:${opts.id}`;

    this.layoutWorld = new LayoutWorld(
      ctx,
      ctx.layout,
      this.anchorName,
      opts.surface,
      opts.grid,
      {
        origin: opts.origin,
        owner: opts.owner,
        singleChunk: opts.singleChunk,
        // Terrain renders for any viewport whose zone carries tiles (world
        // hexes, inventory "empty" tiles). No flag needed — a tile-less zone
        // simply has nothing to draw.
        renderTerrain: true,
      },
    );

    this.panel = new PixiPanel({
      title: opts.title,
      parent,
      titleSuffix: opts.titleSuffix,
      titleSuffixResolvers: opts.titleSuffixResolvers,
      storageKey: opts.storageKey,
      defaultsKey: opts.defaultsKey,
      defaultRect: opts.defaultRect,
      minWidth: opts.minWidth,
      minHeight: opts.minHeight,
      minimizable: true,
      closable: true,
      taskbar: opts.taskbar,
      uiEditMode: ctx.uiEditMode,
    });
    this.panel.content.addChild(this.layoutWorld);
    this.layoutWorld.setBounds(0, 0, this.panel.content.width, this.panel.content.height);
    this.unsubRect = this.panel.onRectChange(() => {
      this.layoutWorld.setBounds(0, 0, this.panel.content.width, this.panel.content.height);
    });

    // Route Pixi-side body clicks back to this panel for focus.
    ctx.panels?.registerNode(this.layoutWorld, this);

    // Drag-pan controller (owner-aware anchor), if pannable.
    this.panController = opts.pan
      ? new PanController(ctx, this.layoutWorld, this.anchorName, opts.surface, opts.owner)
      : null;

    // One-card-per-cell occupancy, if a snap grid.
    if (opts.occupancy) {
      const zoneId = makeMacroZone(opts.owner, opts.surface, 0, 0).packed;
      this.gridInventory = new GridInventory(ctx, zoneId, opts.grid.cellWidth, opts.grid.cellHeight);
      ctx.game?.add(this.gridInventory);
    } else {
      this.gridInventory = null;
    }

    // Seed the anchor so ZoneManager starts pulling this `(owner, surface)`
    // region's chunks in. In follow mode the viewer's row will recenter it.
    ctx.zones.setAnchor(this.anchorName, opts.initialQ, opts.initialR, opts.surface, opts.owner);

    if (this.viewer !== null) this.installViewer(this.viewer);

    // Focusing activates the viewer soul so drag-pickup gates downstream read
    // the right active soul.
    if (this.viewer !== null) {
      const v = this.viewer;
      this.panel.onFocus(() => tryActivateSoul(this.ctx, v));
    }

    this.panel.onDestroy(() => this.cleanup());
  }

  focus(): void { this.panel.focus(); }
  destroy(): void { this.panel.destroy(); }
  onFocus(cb: () => void): () => void { return this.panel.onFocus(cb); }
  onDestroy(cb: () => void): () => void { return this.panel.onDestroy(cb); }

  get currentViewer(): number | null { return this.viewer; }

  /** Per-frame tick — drives the pan controller (drag + recenter tween). */
  update(): void {
    if (this.destroyed) return;
    this.panController?.update();
  }

  /** Recenter on the viewer's world position (Space key). No-op without a
   *  viewer / `follow`, or before the viewer's row lands. */
  recenter(): void {
    if (this.destroyed || !this.follow || this.viewer === null || !this.panController) return;
    const soul = this.ctx.data.soulsLocal.get(this.viewer);
    if (!soul) return;
    const { localQ, localR } = microLooseCell(soul.microLocation);
    this.panController.tweenTo(soul.macroZone.zoneQ + localQ, soul.macroZone.zoneR + localR);
  }

  /** Nudge every free-placed card in this viewport's `(owner, surface)` bucket
   *  back to its cell centre — resets the within-cell `(x, y)` offset to 0.
   *  Only loose-kind cards (`LOOSE_HEX`/`LOOSE_RECT`) use the offset in
   *  rendering; snap-kind cards (`SNAP_HEX`/`SNAP_RECT`) already render
   *  centred regardless, so the nudge skips them. Local-only: same-bucket
   *  position changes don't fire `placeCard` (see
   *  `dropResolver.shouldSyncPlacement`), matching the "visual nudges stay
   *  client-local" policy. Bound to `KeyE` in `MainScene`. */
  nudgeToGrid(): void {
    if (this.destroyed) return;
    const cards = this.ctx.cards;
    if (!cards) return;
    for (const [cardId, row] of this.ctx.data.cardsLocal) {
      if (row.macroZone.surface !== this.surface || row.macroZone.owner !== this.owner) continue;
      if (microIsCard(row.flagsBk)) continue;            // stacked — no free offset
      const micro = decodeMicro(row.microLocation, row.flagsBk);
      if (micro.kind !== "loose") continue;
      // Snap kinds (`& 0b10`) already render centred — nothing to nudge.
      if ((micro.looseKind & 0b10) !== 0) continue;
      if (micro.x === 0 && micro.y === 0) continue;      // already centred
      cards.setCardPosition(cardId, {
        kind: "world",
        q: row.macroZone.zoneQ + micro.localQ,
        r: row.macroZone.zoneR + micro.localR,
        surface: this.surface,
        owner: this.owner,
        offsetX: 0,
        offsetY: 0,
      });
    }
  }

  /** Retarget the perspective soul (subscriptions + recenter). */
  assignViewer(newViewer: number): void {
    if (this.destroyed || this.viewer === newViewer) return;
    this.tearDownViewer();
    this.viewer = newViewer;
    this.installViewer(newViewer);
  }

  private installViewer(viewer: number): void {
    const subs = this.ctx.data.subscriptions;
    void subs.subscribeSoul(viewer);
    void subs.subscribeCard(viewer);
    void subs.subscribeSoulPrivate(viewer);

    // In follow mode, recenter once the viewer's world row lands.
    let unsubSoul: (() => void) | null = null;
    if (this.follow) {
      const recenterOnce = (): boolean => {
        const soul = this.ctx.data.soulsLocal.get(viewer);
        if (!soul || soul.macroZone.surface < WORLD_LAYER) return false;
        this.recenter();
        return true;
      };
      if (!recenterOnce()) {
        unsubSoul = this.ctx.data.subscribeLocalSoulKey(viewer, () => {
          if (recenterOnce()) { unsubSoul?.(); unsubSoul = null; }
        });
      }
    }

    this.viewerCleanup = [
      () => unsubSoul?.(),
      () => subs.unsubscribeSoul(viewer),
      () => subs.unsubscribeCard(viewer),
      () => subs.unsubscribeSoulPrivate(viewer),
    ];
  }

  private tearDownViewer(): void {
    for (const fn of this.viewerCleanup) {
      try { fn(); } catch (err) { console.error("[ViewportPanel] viewer cleanup threw", err); }
    }
    this.viewerCleanup = [];
  }

  private cleanup(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ctx.panels?.unregisterNode(this.layoutWorld);
    this.unsubRect();
    this.panController?.dispose();
    if (this.gridInventory) {
      this.ctx.game?.remove(this.gridInventory);
      this.gridInventory.dispose();
    }
    this.tearDownViewer();
    this.ctx.zones.clearAnchor(this.anchorName);
  }
}
