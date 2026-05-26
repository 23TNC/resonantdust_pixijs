import { ActionManager } from "../../game/actions/ActionManager";
import { ParticleManager } from "../../assets/ParticleManager";
import { CardManager } from "../../game/cards/CardManager";
import { ChatPanel } from "../../game/chat/ChatPanel";
import { LogManager } from "../../game/chat/LogManager";
import { debug } from "../../debug";
import { MainManager } from "./MainManager";
import type { GameContext } from "../../GameContext";
import type { StarterPack } from "../../game/definitions/DefinitionManager";
import { DragManager } from "../../game/input/DragManager";
import { InputManager } from "../../game/input/InputManager";
import { InventoryPanel } from "../../game/inventory/InventoryPanel";
import { LayoutManager } from "../../game/layout/LayoutManager";
import { LayoutWorld } from "../../game/world/LayoutWorld";
import { GameViewPanel } from "../../game/world/GameViewPanel";
import { PanelManager } from "../../ui/panels/PanelManager";
import { unpackMacroZone, unpackMicroZone } from "../../server/data/packing";
import { LayoutCard } from "../../game/cards/layout/CardLayout";
import type { LayoutNode } from "../../game/layout/LayoutNode";
import { owningSoul, tryActivateSoul } from "../../game/permissions";
import { MainLayout } from "./MainLayout";
import { Scene } from "../Scene";

// `is_owned_by_player` is bit 4 of `cards_state` post unified-hold-counts rework.
const FLAG_OWNED_BY_PLAYER = 1 << 4;

/**
 * Single post-login scene. There are no browse/play modes — every
 * UI surface is a PanelManager-tracked panel that the user opens,
 * closes, moves, and focuses independently.
 *
 * Construction order in `onEnter`:
 *
 *   - `PanelManager` (registry of open panels — set on ctx first).
 *   - `LayoutManager`, `CardManager` — surfaces + card spawning.
 *   - `MainLayout` — chooser + details + blueprints panels.
 *     Per-soul `InventoryPanel` / `GameViewPanel` are opened on
 *     demand via PanelManager.
 *   - `InputManager`, `DragManager`, `ActionManager`.
 *   - `MainManager` (30Hz tick), `ParticleManager`, `LogManager`,
 *     `ChatPanel`.
 *
 * Always-on key handlers (installed once in `onEnter`):
 *
 *   - KeyE down/up → focused inventory panel's snapToGrid / showGrid.
 *   - Space → focused game-view panel's `recenter()`.
 *   - left_click → details panel + open-inventory-on-soul-card.
 *
 * Subscriptions: player row + owned cards arrive in `onEnter` and
 * stay subscribed for the scene's lifetime; SoulManager's player-wide
 * inventory refcount tracker is also enabled here.
 *
 * Scene flow: `LoginScene → MainScene`. The chooser is the entry
 * point. Single-clicking a soul card activates that soul and opens
 * (or focuses) its inventory; clicking the 👁 icon on a soul card
 * snaps the gameview to the soul's tile. Clicking the `+` create-
 * character tile opens `packCreate` → `createCharacter` reducer →
 * new soul row arrives → panels open for it automatically.
 */
export class MainScene extends Scene {
  // ── Always-on managers ───────────────────────────────────────────
  private mainLayout!: MainLayout;
  private cardManager!: CardManager;
  private layoutManager!: LayoutManager;
  private mainManager!: MainManager;
  private inputManager!: InputManager;
  private dragManager!: DragManager;
  private actionManager!: ActionManager;
  private particleManager!: ParticleManager;
  private logManager!: LogManager;
  private chatPanel!: ChatPanel;
  private ctxRef: GameContext | null = null;
  private playerId = 0;

  /** Cleanup for the always-on KeyE / Space / left-click handlers.
   *  Installed in `onEnter`, released in `onExit`. */
  private releaseInputHandlers: (() => void) | null = null;

  // ── Create-character flow (one-shot) ─────────────────────────────
  /** Set while we're waiting for the server to deliver the newly-
   *  created soul row. Cleaned up if we leave the scene before it
   *  arrives. */
  private pendingCreateUnsub: (() => void) | null = null;

  onEnter(ctx: GameContext): void {
    const player = ctx.playerSession.getPlayer();
    if (!player) {
      throw new Error("MainScene entered without a logged-in player");
    }
    this.ctxRef = ctx;
    this.playerId = player.playerId;

    // PanelManager owns the open-panel registry for this scene. Must
    // exist before any panel factories run (MainLayout's constructor
    // builds several panels), since those factories will eventually
    // self-register here.
    ctx.panels = new PanelManager();

    // LayoutManager comes first so MainLayout can register surfaces
    // during its constructor.
    this.layoutManager = new LayoutManager();
    ctx.layout = this.layoutManager;

    this.mainLayout = new MainLayout(
      ctx,
      player.playerId,
      (pack) => this.handleCreateCharacter(pack),
    );
    this.mainLayout.setContext(ctx);
    this.layoutManager.overlay = this.mainLayout.overlay;
    // ctx.layout.worldView is now set by each `GameViewPanel`'s
    // constructor (last-write-wins for the singleton pointer used by
    // ad-hoc consumers like dropResolver / DragManager). No singleton
    // to publish here.
    this.root.addChild(this.mainLayout.container);

    this.cardManager = new CardManager(ctx);
    ctx.cards = this.cardManager;
    // DataManager's mirrorCard splice path needs a CardManager
    // reference to invoke insertIntoSlotChain / evictCard on
    // pos_need / pos_want conflicts. Inject here once both managers
    // exist (CardManager depends on DataManager via ctx.data, so
    // constructor wiring stays one-way).
    ctx.data.setCardManager(this.cardManager);

    this.mainManager = new MainManager(ctx);
    ctx.game = this.mainManager;

    this.inputManager = new InputManager(ctx.app.canvas, this.mainLayout);
    ctx.input = this.inputManager;

    this.dragManager = new DragManager(ctx);

    // ActionManager subscribes to CardManager's stack-change events,
    // so must come after `cards` is wired into ctx.
    this.actionManager = new ActionManager(ctx);
    ctx.actions = this.actionManager;

    this.logManager = new LogManager();
    ctx.logs = this.logManager;

    this.chatPanel = new ChatPanel(ctx);
    this.chatPanel.open();

    this.particleManager = new ParticleManager();
    void this.particleManager.init();

    // Subscribe to the player's owned cards so the chooser sees the
    // soul list (and any new soul we create during this session
    // shows up). Stays subscribed for the entire scene lifetime —
    // browse↔play transitions don't touch this.
    void ctx.data.subscriptions.subscribeOwnedCards(player.playerId);

    // Once owned-cards is in flight, ask SoulManager to hold an
    // inventory-zone refcount for every owned soul so recipes keep
    // ticking for souls whose inventory panel isn't open. Per-panel
    // `ensureInventory` calls stack on the same refs.
    ctx.souls.startTrackingOwnedSoulInventories();

    // Auto-open the player's pocket-dimension view immediately on
    // scene entry. The dim is the player-wide "home" surface where
    // all of their characters live; surfacing it on login gives the
    // player somewhere to look at while they pick a soul. The
    // chooser's 👁 button retargets this panel (or any open
    // game-view panel) to a soul's current location on demand.
    this.mainLayout.openPlayerDimensionPanel();

    // Same idea for the player-wide inventory bucket — the account-
    // scoped permanent-items bag. Soul-specific inventories open
    // when the user clicks a soul card in the chooser.
    this.mainLayout.openPlayerInventoryPanel(player.playerId);

    // Location switcher — buttons for the pocket dim plus every
    // world-layer surface the player's souls currently occupy. Opens
    // alongside the dim panel so the player has the means to jump
    // between surfaces visible from the moment they log in.
    this.mainLayout.openLocationPanel();

    this.installInputHandlers(ctx);
  }

  /** Install the always-on KeyE / Space / left-click handlers. They
   *  route through PanelManager.focused so the right per-type panel
   *  receives the input — KeyE to the focused inventory, Space to
   *  the focused game-view, left-click handles details + soul-card
   *  open-inventory globally. */
  private installInputHandlers(ctx: GameContext): void {
    const focusedInventory = (): InventoryPanel | null => {
      const p = ctx.panels?.focused("inventory");
      return p instanceof InventoryPanel ? p : null;
    };
    const focusedGameView = (): GameViewPanel | null => {
      const p = ctx.panels?.focused("gameview");
      return p instanceof GameViewPanel ? p : null;
    };

    // Pixi-side panel focus: clicks / drag-starts on a panel's
    // body don't bubble to the DOM panel (`pointer-events: none`)
    // so the DOM-level `bringToFront` chain never fires. Walk the
    // hit's LayoutNode parent chain to find the panel that owns
    // it (registered via `PanelManager.registerNode` from each
    // wrapper panel's constructor) and `focus()` it. The focus
    // event chain then handles Z-order + per-panel onFocus
    // listeners (e.g. `tryActivateSoul` on inventory + game-view
    // panels). Hits outside any panel (overlay, MainLayout root)
    // resolve to null and no-op.
    const focusPanelUnder = (hit: LayoutNode | null): void => {
      const p = ctx.panels?.findPanelByDescendant(hit);
      if (p) p.focus();
    };
    const releaseFocusClick = this.inputManager.on("left_click", (data) => {
      focusPanelUnder(data.up.hit);
    });
    const releaseFocusDrag = this.inputManager.on("left_drag_start", (data) => {
      focusPanelUnder(data.hit);
      // Drag-start on a card also activates the card's owning soul.
      // Walking `owning_id` to find the soul covers both soul-card
      // drags (movement) and item drags (the item's chain-root soul
      // becomes active so subsequent drag-out behaviors target the
      // right soul). `tryActivateSoul` no-ops for cards the local
      // player doesn't own (other players' souls / world tile cards).
      if (data.hit instanceof LayoutCard) {
        const owned = owningSoul(ctx, data.hit.cardId);
        if (owned) tryActivateSoul(ctx, owned.soulCardId);
      }
    });

    const releaseKeyDown = this.inputManager.onKey("key_down", ({ code }) => {
      if (code === "KeyE") {
        const inv = focusedInventory();
        inv?.snapToGrid();
        inv?.showGrid(true);
      } else if (code === "Space") {
        focusedGameView()?.recenter();
      }
    });
    const releaseKeyUp = this.inputManager.onKey("key_up", ({ code }) => {
      if (code === "KeyE") focusedInventory()?.showGrid(false);
    });
    const releaseClick = this.inputManager.on("left_click", (data) => {
      const hit = data.up.hit;
      if (hit instanceof LayoutCard) {
        // Every click shows details (details are for everyone, not
        // gated on ownership). Soul activation is a separate side
        // effect: `tryActivateSoul` is a no-op for cards that
        // aren't player-owned souls. Inventory opens for any card
        // whose def *carries* the `inventory` feature at all (the
        // value gates capacity + presentation, not the open trigger):
        //   - `null`   → no feature, no inventory.
        //   - `0`      → infinite capacity, large right-anchored panel.
        //   - `1..=9`  → small chest-style cap, mini popover anchored
        //                above / near the clicked card.
        //   - `> 9`    → finite cap but still large panel.
        tryActivateSoul(ctx, hit.cardId);
        const row = ctx.data.cardsLocal.get(hit.cardId);
        if (row) {
          const invValue = ctx.definitions.aspectValue(row.packedDefinition, "inventory");
          if (invValue !== null) {
            const cap = invValue === 0 ? Infinity : invValue;
            if (cap !== Infinity && cap <= 9) {
              this.mainLayout.openMiniInventoryPanel(hit.cardId, data.up.x, data.up.y, cap);
            } else {
              this.mainLayout.openInventoryPanel(hit.cardId);
            }
          }
        }
        this.mainLayout.detailsPanel.show(hit.cardId, ctx);
        return;
      }
      if (hit instanceof LayoutWorld) {
        const hex = ctx.worldHexAt?.(data.up.x, data.up.y);
        if (hex) {
          const tile = hit.tileAt(hex.q, hex.r);
          if (tile) {
            this.mainLayout.detailsPanel.showByPackedDefinition(
              tile.packed,
              ctx,
              [tile.stock0, tile.stock1],
              { q: hex.q, r: hex.r },
            );
            return;
          }
        }
      }
      if (!this.mainLayout.detailsPanel.handleClick(hit)) {
        this.mainLayout.detailsPanel.hide();
      }
    });

    this.releaseInputHandlers = () => {
      releaseFocusClick();
      releaseFocusDrag();
      releaseKeyDown();
      releaseKeyUp();
      releaseClick();
    };
  }

  onExit(): void {
    this.releaseInputHandlers?.();
    this.releaseInputHandlers = null;

    this.pendingCreateUnsub?.();
    this.pendingCreateUnsub = null;

    if (this.ctxRef) {
      this.ctxRef.souls.stopTrackingOwnedSoulInventories();
      this.ctxRef.data.subscriptions.unsubscribeOwnedCards(this.playerId);
    }

    // Tear down every PanelManager-registered panel first — each
    // `InventoryPanel` / `GameViewPanel` / `PackCreatePanel` /
    // `PackPreviewPanel` releases its own zone refcounts, soul
    // subs, and tick registrations on destroy. Order matters: panel
    // destructors call into CardManager / MainManager / ZoneManager,
    // so this has to run while those are still alive.
    this.ctxRef?.panels?.closeAll();

    this.chatPanel.destroy();
    this.particleManager.destroy();
    this.actionManager.dispose();
    this.dragManager.dispose();
    this.inputManager.dispose();
    this.mainLayout.destroy();
    this.mainManager.dispose();
    this.cardManager.dispose();
    this.logManager.dispose();
    this.layoutManager.dispose();

    if (this.ctxRef) {
      this.ctxRef.panels = null;
      this.ctxRef.cards = null;
      this.ctxRef.layout = null;
      this.ctxRef.game = null;
      this.ctxRef.input = null;
      this.ctxRef.actions = null;
      this.ctxRef.logs = null;
      this.ctxRef = null;
    }
  }

  onResize(width: number, height: number): void {
    this.mainLayout.setBounds(0, 0, width, height);
    this.mainLayout.layoutIfDirty();
  }

  update(deltaMS: number): void {
    this.mainManager.tick(deltaMS);
    this.particleManager.tick(deltaMS);
    // Drive every open `GameViewPanel`'s per-frame tick (drag-pan
    // anchor updates, recenter tweens). The id prefix changed when
    // we collapsed game-views to a singleton (`"gameview"` instead
    // of `"gameview:<soulId>"`); test by instance instead of id so
    // a future per-soul renaming doesn't silently break the tick
    // again. Each panel's pan controller self-gates on
    // `data.hit !== this.worldView`, so iterating all of them is
    // safe.
    if (this.ctxRef?.panels) {
      for (const id of this.ctxRef.panels.panelIds()) {
        const p = this.ctxRef.panels.get(id);
        if (p instanceof GameViewPanel) p.update();
      }
    }
    if (this.ctxRef) {
      const drawCalls = this.ctxRef.drawCallCounter.readAndReset();
      this.ctxRef.debugPanel.setStats(
        deltaMS,
        drawCalls,
        this.ctxRef.textures.stats(),
        this.ctxRef.reducers.syncStats(),
      );
    }
    this.mainLayout.layoutIfDirty();
  }

  // ── Create-character flow ────────────────────────────────────────

  /** Create-character callback from the `packCreate` panel. Fires
   *  `createCharacter` and watches `cardsLocal` for the new soul row
   *  to arrive; on arrival, closes the create + preview panels and
   *  opens inventory + game-view panels for the new soul. The
   *  watcher is installed BEFORE the reducer call so the new soul
   *  can't arrive between submit and listener install. */
  private handleCreateCharacter(pack: StarterPack): void {
    if (!this.ctxRef) return;
    const ctx = this.ctxRef;

    // Snapshot existing soul card IDs so we can identify the new one.
    const priorSoulIds = new Set<number>();
    for (const card of ctx.data.cardsLocal.values()) {
      if (card.ownerId === this.playerId && (card.flagsState & FLAG_OWNED_BY_PLAYER) !== 0) {
        priorSoulIds.add(card.cardId);
      }
    }

    let transitioned = false;
    let unsubNewSoul: (() => void) | null = null;
    unsubNewSoul = ctx.data.subscribeLocalCard((change) => {
      if (transitioned || change.kind !== "added") return;
      const card = change.row;
      if (card.ownerId !== this.playerId) return;
      if ((card.flagsState & FLAG_OWNED_BY_PLAYER) === 0) return;
      if (priorSoulIds.has(card.cardId)) return;
      transitioned = true;
      unsubNewSoul?.();
      unsubNewSoul = null;
      this.pendingCreateUnsub = null;
      // Close the create / preview panels and open the new soul's
      // inventory + game-view. PanelManager.ensure dedupes if the
      // panels somehow already exist.
      ctx.panels?.close("packPreview");
      ctx.panels?.close("packCreate");
      ctx.souls.setActiveSoul(card.cardId);
      this.mainLayout.openInventoryPanel(card.cardId);
      this.mainLayout.openGameViewPanel(card.cardId);
    });
    this.pendingCreateUnsub = unsubNewSoul;

    debug.log(
      ["spacetime"],
      `[MainScene] create character: pack id=${pack.id} soul=${pack.soul} packId=${pack.packId} contents=[${pack.contents.map((c) => `${c.cardKey}×${c.count}`).join(", ")}]`,
      4,
    );

    void ctx.reducers.createCharacter({ starterPackId: pack.id })
      .catch((err) => {
        if (!transitioned) {
          unsubNewSoul?.();
          unsubNewSoul = null;
          this.pendingCreateUnsub = null;
        }
        debug.log(["spacetime"], `[MainScene] createCharacter reducer failed: ${err}`, 4);
      });
  }
}
