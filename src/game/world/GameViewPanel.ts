import type { GameContext } from "../../GameContext";
import type { LayoutNode } from "../layout/LayoutNode";
import { LayoutWorld } from "./LayoutWorld";
import type { ManagedPanel } from "../../ui/panels/PanelManager";
import { PanelTaskbar } from "../../ui/dom/PanelTaskbar";
import { PixiPanel } from "../../ui/dom/PixiPanel";
import { unpackMicroZone, WORLD_LAYER } from "../../server/data/packing";
import { WorldPanManager } from "./WorldPanManager";

/** Default world-panel width when no saved rect exists. */
const DEFAULT_GAMEVIEW_WIDTH = 800;

/**
 * Game-view panel — a windowed `LayoutWorld` with drag-pan and
 * optional soul-follow. Keyed in `PanelManager` by
 * `gameview:<panelId>`; multiple panels can coexist (one per
 * viewed soul or one per dimension).
 *
 * Owns:
 *
 *  - A `PixiPanel` chrome (left-of-screen by default, taskbar-tabbed).
 *  - A `LayoutWorld` bound to a namespaced viewport anchor
 *    (`"viewport:<panelId>"`) on the chosen `surface`, so each open
 *    panel anchors zone subscriptions around its own viewport.
 *  - A `WorldPanManager` wired to the same anchor + surface, driving
 *    drag-pan and Space-key recenter for this panel.
 *  - **Soul mode (`surface == WORLD_LAYER`, `soulId != null`).** Per-
 *    soul subscriptions install (`subscribeSoul` / `subscribeCard` /
 *    `subscribeSoulPrivate`) and the viewport recenters on the soul
 *    once its row lands. From then on the `viewport:<panelId>` anchor
 *    drives zone subscription; the player's own cards stay loaded via
 *    the scene-wide `subscribeOwnedCards`. `assignSoul(newSoulId)`
 *    retargets.
 *  - **Soulless mode (`soulId == null`).** No soul subscriptions,
 *    no soul-follow anchor. The viewport starts at the supplied
 *    `(initialQ, initialR)` (default `(0, 0)`) and pans freely
 *    within whatever ZoneManager activates on this surface.
 */
export class GameViewPanel implements ManagedPanel {
  readonly panel: PixiPanel;
  readonly layoutWorld: LayoutWorld;
  readonly worldPanManager: WorldPanManager;
  readonly panelId: string;
  readonly surface: number;
  private soulId: number | null;
  private readonly ctx: GameContext;
  /** Stack of cleanup fns for the currently-assigned soul (subscriptions,
   *  row listener, anchor clear). Replaced wholesale on `assignSoul`.
   *  Empty in soulless mode. */
  private soulCleanup: Array<() => void> = [];
  private destroyed = false;
  private readonly unsubRect: () => void;

  constructor(
    ctx: GameContext,
    parent: LayoutNode,
    panelId: string,
    soulId: number | null,
    options: {
      surface?: number;
      initialQ?: number;
      initialR?: number;
      /** Panel title override. Defaults to `"Game View - <soulId>"`
       *  in soul mode, `"Game View"` in soulless mode. */
      title?: string;
    } = {},
  ) {
    if (!ctx.layout) throw new Error("[GameViewPanel] ctx.layout must be set");
    if (!ctx.input) throw new Error("[GameViewPanel] ctx.input must be set");

    this.ctx = ctx;
    this.panelId = panelId;
    this.soulId = soulId;
    this.surface = options.surface ?? WORLD_LAYER;

    const viewportAnchorName = `viewport:${panelId}`;

    this.layoutWorld = new LayoutWorld(ctx, ctx.layout, viewportAnchorName, this.surface);
    // Last-write-wins singleton pointer for ad-hoc consumers
    // (`dropResolver`, `DragManager`, drop-target hex lookups). With
    // multiple game-view panels open the pointer tracks whichever was
    // constructed most recently; drag hit-testing dispatches via
    // `up.hit instanceof LayoutWorld` so the correct world view is
    // resolvable regardless.
    ctx.layout.worldView = this.layoutWorld;

    // Title composes from `"Game View" + suffix resolver`. Default
    // suffix is "soul" in soul mode (preserves the prior "Game
    // View - <soulId>" but with the soul's name instead of the
    // raw id) and "player" in soulless mode. User can flip / disable
    // via the popup.
    this.panel = new PixiPanel({
      title: options.title ?? "Game View",
      parent,
      titleSuffix: soulId !== null ? "soul" : "player",
      titleSuffixResolvers: {
        player: () => ctx.playerSession.getPlayer()?.name ?? null,
        // Soul-name lookup from card id (`null` when the soul
        // row hasn't landed yet). Only registered when soulId is
        // non-null — soulless game views don't have a soul to
        // name.
        ...(soulId !== null ? {
          soul: () => {
            const row = ctx.data.cardsLocal.get(soulId);
            if (!row) return null;
            return ctx.definitions.label(row.packedDefinition);
          },
        } : {}),
      },
      storageKey: `gameViewPanel:${panelId}`,
      // Per-instance storageKey, shared content-defaults entry.
      // Every GameViewPanel reads from the same `gameViewPanel`
      // block in `content/panels/defaults.json`.
      defaultsKey: "gameViewPanel",
      defaultRect: {
        left:   "0",
        top:    `${PanelTaskbar.HEIGHT}px`,
        width:  `${DEFAULT_GAMEVIEW_WIDTH}px`,
        height: `calc(100vh - ${PanelTaskbar.HEIGHT * 2}px)`,
      },
      minWidth:    400,
      minHeight:   400,
      minimizable: true,
      closable:    true,
      taskbar:     ctx.taskbar,
      uiEditMode:  ctx.uiEditMode,
    });
    this.panel.content.addChild(this.layoutWorld);

    this.unsubRect = this.panel.onRectChange(() => {
      this.layoutWorld.setBounds(
        0, 0,
        this.panel.content.width,
        this.panel.content.height,
      );
    });

    this.worldPanManager = new WorldPanManager(ctx, this.layoutWorld, viewportAnchorName, this.surface);

    // Register the interior LayoutWorld so PanelManager can route
    // Pixi-side body clicks (world tiles, world cards, empty world
    // space for pan starts) back to this panel for focus.
    // Unregistered in `cleanup()`.
    ctx.panels?.registerNode(this.layoutWorld, this);

    if (soulId !== null) {
      // World mode — wire up soul subscriptions + soul-follow anchor.
      this.installSoul(soulId);
    } else {
      // Dimension mode — no soul to track. Seed the viewport anchor
      // at `(initialQ, initialR)` (default `(0, 0)`) on this panel's
      // surface so ZoneManager starts pulling the dim's Zones in.
      // Without an initial setAnchor the active set on this surface
      // would stay empty until the user manually pans.
      const q = options.initialQ ?? 0;
      const r = options.initialR ?? 0;
      ctx.zones.setAnchor(viewportAnchorName, q, r, this.surface);
    }

    this.panel.onDestroy(() => this.cleanup());
  }

  focus(): void { this.panel.focus(); }

  destroy(): void {
    this.panel.destroy();
  }

  onFocus(cb: () => void): () => void {
    return this.panel.onFocus(cb);
  }

  onDestroy(cb: () => void): () => void {
    return this.panel.onDestroy(cb);
  }

  /** Retarget this panel to view `newSoulId` — tears down the current
   *  soul's subscriptions + anchor, installs the new soul's. The
   *  viewport tweens to the new soul's hex once its row arrives. */
  assignSoul(newSoulId: number): void {
    if (this.destroyed || this.soulId === newSoulId) return;
    this.tearDownSoul();
    this.soulId = newSoulId;
    // PixiPanel doesn't expose a runtime setTitle today — the panel's
    // title stays as the originally-assigned soul id. Phase 5 / a
    // dedicated setTitle on PixiPanel can update this if needed.
    this.installSoul(newSoulId);
  }

  /** Per-frame tick driver. Forwards to the pan controller which
   *  reads the drag state and pushes anchor updates. `MainScene.update`
   *  routes here for every open game-view panel. */
  update(): void {
    if (this.destroyed) return;
    this.worldPanManager.update();
  }

  /** Re-center the viewport on this panel's current soul. No-op if
   *  the soul row hasn't landed yet, or in soulless mode (no soul to
   *  follow — caller should `tweenTo` an explicit hex). Called by
   *  the Space-key handler while this panel has focus. */
  recenter(): void {
    if (this.destroyed) return;
    if (this.soulId === null) return;
    const soul = this.ctx.data.soulsLocal.get(this.soulId);
    if (!soul) return;
    if (soul.macro.kind !== "world") return;
    const { localQ, localR } = unpackMicroZone(soul.microZone);
    this.worldPanManager.tweenTo(soul.macro.q + localQ, soul.macro.r + localR);
  }

  /** Snap the viewport to `(q, r)` on `surface`. Switches the
   *  view + pan controller to the new surface if needed (re-
   *  registering `worldCardSurface` and re-hydrating tile data),
   *  then re-anchors so `ZoneManager.recomputeAnchorZones` swaps
   *  the subscribed zones. One-shot — does not attach a
   *  soul-follow; the user pans freely from the new position.
   *
   *  Used by soul-jump affordances to snap this viewport to
   *  wherever a selected soul currently lives. */
  focusAt(q: number, r: number, surface: number): void {
    if (this.destroyed) return;
    if (this.layoutWorld.surface !== surface) {
      this.layoutWorld.setSurface(surface);
      this.worldPanManager.setSurface(surface);
    }
    this.ctx.zones.setAnchor(
      `viewport:${this.panelId}`,
      q,
      r,
      surface,
    );
  }

  get currentSoulId(): number | null { return this.soulId; }

  /** Wire up subscriptions + initial recenter for a freshly-assigned
   *  soul. There's no soul-follow anchor — once the initial recenter
   *  lands the viewport on the soul, the viewport anchor (driven by
   *  `WorldPanManager`) is what keeps the surrounding zones
   *  subscribed. The local player's own cards stay loaded via the
   *  scene-wide `subscribeOwnedCards`, independent of the camera. */
  private installSoul(soulId: number): void {
    const subs = this.ctx.data.subscriptions;

    void subs.subscribeSoul(soulId);
    void subs.subscribeCard(soulId);
    void subs.subscribeSoulPrivate(soulId);

    // Recenter once the soul's world-surface row is available. It may
    // already be in `soulsLocal` (arrived via the world-zone or
    // owned-cards subscription before our per-soul sub installed);
    // otherwise wait for it — `subscribeLocalSoulKey` only fires on
    // diffs, not initial state.
    let unsubSoul: (() => void) | null = null;
    const recenterOnce = (): boolean => {
      const soul = this.ctx.data.soulsLocal.get(soulId);
      if (!soul || soul.surface < WORLD_LAYER) return false;
      this.recenter();
      return true;
    };
    if (!recenterOnce()) {
      unsubSoul = this.ctx.data.subscribeLocalSoulKey(soulId, () => {
        if (recenterOnce()) {
          unsubSoul?.();
          unsubSoul = null;
        }
      });
    }

    this.soulCleanup = [
      () => unsubSoul?.(),
      () => subs.unsubscribeSoul(soulId),
      () => subs.unsubscribeCard(soulId),
      () => subs.unsubscribeSoulPrivate(soulId),
    ];
  }

  private tearDownSoul(): void {
    for (const fn of this.soulCleanup) {
      try { fn(); } catch (err) { console.error("[GameViewPanel] soul cleanup threw", err); }
    }
    this.soulCleanup = [];
  }

  private cleanup(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ctx.panels?.unregisterNode(this.layoutWorld);
    this.unsubRect();
    this.worldPanManager.dispose();
    this.tearDownSoul();
    this.ctx.zones.clearAnchor(`viewport:${this.panelId}`);
    // If we set the singleton pointer to our own world view, clear
    // it. A later-constructed panel may have already overwritten it
    // — only null out when it still points at us.
    if (this.ctx.layout && this.ctx.layout.worldView === this.layoutWorld) {
      this.ctx.layout.worldView = null;
    }
  }
}
