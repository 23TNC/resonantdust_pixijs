import { ActionManager } from "../../game/actions/ActionManager";
import { CardManager } from "../../game/cards/CardManager";
import { ChatPanel } from "../../game/panels/chat/ChatPanel";
import { LogManager } from "../../game/panels/chat/LogManager";
import { debug } from "../../debug";
import { MainManager } from "./MainManager";
import type { GameContext } from "../../GameContext";
import { DragManager } from "../../game/input/DragManager";
import { InputManager } from "../../game/input/InputManager";
import { LayoutManager } from "../../game/layout/LayoutManager";
import { LayoutWorld } from "../../game/viewport/LayoutWorld";
import { ViewportPanel } from "../../game/viewport/ViewportPanel";
import { PanelManager } from "../../ui/panels/PanelManager";
import { LayoutCard } from "../../game/cards/layout/CardLayout";
import type { LayoutNode } from "../../game/layout/LayoutNode";
import { tryActivateSoul } from "../../game/permissions";
import { MainLayout } from "./MainLayout";
import { Scene } from "../Scene";

// `is_owned_by_player` is bit 4 of `cards_state` post unified-hold-counts rework.
const FLAG_OWNED_BY_PLAYER = 1 << 4;
// `card_type` nibble (bits 12-15 of packed_definition) for soul cards.
const SOUL_CARD_TYPE = 6;

/**
 * Single post-login scene. There are no browse/play modes — every
 * UI surface is a PanelManager-tracked panel that the user opens,
 * closes, moves, and focuses independently.
 *
 * Construction order in `onEnter`:
 *
 *   - `PanelManager` (registry of open panels — set on ctx first).
 *   - `LayoutManager`, `CardManager` — surfaces + card spawning.
 *   - `MainLayout` — details + blueprints panels. Per-soul
 *     `InventoryPanel` / `GameViewPanel` are opened on demand via
 *     PanelManager.
 *   - `InputManager`, `DragManager`, `ActionManager`.
 *   - `MainManager` (30Hz tick), `LogManager`, `ChatPanel`.
 *
 * Always-on key handlers (installed once in `onEnter`):
 *
 *   - KeyE down → focused viewport's `nudgeToGrid()` (snap loose offsets to centres in non-snap viewports).
 *   - Space → focused game-view panel's `recenter()`.
 *   - left_click → details panel + open-inventory-on-soul-card.
 *
 * Subscriptions: player row + owned cards arrive in `onEnter` and
 * stay subscribed for the scene's lifetime; SoulManager's player-wide
 * inventory refcount tracker is also enabled here.
 *
 * Scene flow: `LoginScene → MainScene`. A player's single soul is
 * auto-spawned at signup, so on login `openDefaultSoulView` picks it
 * up and opens its game-view automatically. Clicking a soul card in
 * the world activates that soul and opens (or focuses) its inventory.
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
  private logManager!: LogManager;
  private chatPanel!: ChatPanel;
  private ctxRef: GameContext | null = null;
  private playerId = 0;

  /** Cleanup for the always-on KeyE / Space / left-click handlers.
   *  Installed in `onEnter`, released in `onExit`. */
  private releaseInputHandlers: (() => void) | null = null;

  /** One-shot watcher that opens the default soul-mode game-view once
   *  the player's first owned soul arrives on login. Cleared once it
   *  fires, or in `onExit` if we leave before any soul lands. */
  private pendingDefaultViewUnsub: (() => void) | null = null;

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

    this.mainLayout = new MainLayout(ctx, player.playerId);
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

    // Subscribe to the player's owned cards (their soul rows) and, once
    // the initial set has synced, spawn a soul if they own none yet.
    // Client-driven signup: shard's `claim_or_login` no longer spawns the
    // soul. Stays subscribed for the entire scene lifetime.
    void this.ensureSoul(ctx);

    // Once owned-cards is in flight, ask SoulManager to hold an
    // inventory-zone refcount for every owned soul so recipes keep
    // ticking for souls whose inventory panel isn't open. Per-panel
    // `ensureInventory` calls stack on the same refs.
    ctx.souls.startTrackingOwnedSoulInventories();

    // TEMP (testing): land on a fixed world-origin view — surface 64,
    // q/r (0, 0) — instead of following the player's soul. The
    // soul-follow path (`openDefaultSoulView` + `firstOwnedSoul`) is
    // left intact below; swap this call back to `openDefaultSoulView`
    // once soul-follow is rewired for the player_soul model.
    this.mainLayout.openWorldView();

    // Inventory spawning is disabled — inventory is being replaced
    // soon. The `InventoryPanel` code + `MainLayout.openInventoryPanel`
    // helper are kept intact; re-enable by uncommenting this and the
    // click-handler block below. The player's inventory is the inventory
    // of their `player_soul` card — pass that card's id.
    // this.mainLayout.openInventoryPanel(playerSoulCardId);

    this.installInputHandlers(ctx);
  }

  /** Install the always-on KeyE / Space / left-click handlers. They
   *  route through PanelManager.focused so the right per-type panel
   *  receives the input — KeyE to the focused inventory, Space to
   *  the focused game-view, left-click handles details + soul-card
   *  open-inventory globally. */
  private installInputHandlers(ctx: GameContext): void {
    // One panel type now — the most-recently-focused viewport handles both
    // keys (recenter is a no-op without `follow`; nudgeToGrid only affects
    // cards whose `looseKind` is LOOSE — SNAP-kind cards already render
    // centred so there's nothing to nudge).
    const focusedViewport = (): ViewportPanel | null => {
      const p = ctx.panels?.focused("viewport");
      return p instanceof ViewportPanel ? p : null;
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
      // `tryActivateSoul` resolves the soul via `owningSoul` (the card
      // itself if it's a soul, else the nearest soul up its owner
      // chain), covering both soul-card drags and item drags. No-ops
      // when the chain reaches no soul (world-tile cards).
      if (data.hit instanceof LayoutCard) {
        tryActivateSoul(ctx, data.hit.cardId);
      }
    });

    const releaseKeyDown = this.inputManager.onKey("key_down", ({ code }) => {
      if (code === "KeyE") {
        // Snap every LOOSE-kind card in the focused viewport's bucket back to
        // its cell centre. SNAP-kind cards already render centred so they're
        // skipped. Local-only — same-bucket visual nudges don't fire
        // `placeCard` per `shouldSyncPlacement`.
        focusedViewport()?.nudgeToGrid();
      } else if (code === "Space") {
        focusedViewport()?.recenter();
      }
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
        // Open the clicked card's inventory as a second view, if its def
        // carries the `inventory` feature at all (value gates capacity, not
        // the open trigger). Clicking the seeded "human" soul at world (0,0)
        // opens its surface-1 inventory — the dust seeded there renders. Full
        // right-edge panel for now (the mini-popover cap branch is parked).
        const row = ctx.data.cardsLocal.get(hit.cardId);
        if (row) {
          const invValue = ctx.definitions.aspectValue(row.packedDefinition, "inventory");
          if (invValue !== null) {
            this.mainLayout.openInventoryPanel(hit.cardId);
          }
        }
        this.mainLayout.detailsPanel.show(hit.cardId, ctx);
        return;
      }
      if (hit instanceof LayoutWorld) {
        const hex = hit.worldHexAt(data.up.x, data.up.y);
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
      releaseClick();
    };
  }

  onExit(): void {
    this.releaseInputHandlers?.();
    this.releaseInputHandlers = null;

    this.pendingDefaultViewUnsub?.();
    this.pendingDefaultViewUnsub = null;

    if (this.ctxRef) {
      this.ctxRef.souls.stopTrackingOwnedSoulInventories();
      this.ctxRef.data.subscriptions.unsubscribeOwnedCards(this.playerId);
    }

    // Tear down every PanelManager-registered panel first — each
    // `InventoryPanel` / `GameViewPanel` releases its own zone
    // refcounts, soul subs, and tick registrations on destroy. Order
    // matters: panel destructors call into CardManager / MainManager /
    // ZoneManager, so this has to run while those are still alive.
    this.ctxRef?.panels?.closeAll();

    this.chatPanel.destroy();
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
    // Drive every open viewport's per-frame tick (drag-pan anchor updates,
    // recenter tweens). Each panel's `PanController` self-gates on
    // `data.hit !== this.worldView`, so iterating all of them is safe; a
    // non-pannable viewport's `update()` is a no-op.
    if (this.ctxRef?.panels) {
      for (const id of this.ctxRef.panels.panelIds()) {
        const p = this.ctxRef.panels.get(id);
        if (p instanceof ViewportPanel) p.update();
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

  /** Open a soul-mode game-view on the player's first owned soul so
   *  login lands on that soul's world location. Opens immediately if
   *  a soul is already present; otherwise watches `cardsLocal` and
   *  opens once the first owned soul arrives. One-shot — unsubscribes
   *  after the first open, and skips if a game-view is already open
   *  (so it never stomps a soul the user explicitly picked). */
  private openDefaultSoulView(ctx: GameContext): void {
    const tryOpen = (): boolean => {
      if (ctx.panels?.focused("viewport") instanceof ViewportPanel) return true;
      const soulId = this.firstOwnedSoul(ctx);
      if (soulId === null) return false;
      this.mainLayout.openGameViewPanel(soulId);
      return true;
    };
    if (tryOpen()) return;
    let unsub: (() => void) | null = null;
    unsub = ctx.data.subscribeLocalCard(() => {
      if (!tryOpen()) return;
      unsub?.();
      unsub = null;
      this.pendingDefaultViewUnsub = null;
    });
    this.pendingDefaultViewUnsub = unsub;
  }

  /** Open the owned-cards subscription, wait for its initial rows to apply,
   *  then spawn the player's soul if they own none yet. Client-driven signup:
   *  shard's `claim_or_login` no longer spawns the soul. The spawned soul
   *  streams in via this same subscription and is picked up by `firstOwnedSoul`
   *  / the default soul view. One-shot per scene.
   *
   *  Two waits, both required, or the count reads empty and we spawn a soul on
   *  every login (the bug this fixes):
   *   1. `subscribeOwnedCards` now resolves on the gate's `applied` — the
   *      initial rows are in the `cards` *server tier* when the await returns.
   *   2. `promote()` flushes that server tier through to `cardsLocal`, which is
   *      what `ownedSoulCount` reads (rows otherwise only reach `cardsLocal` on
   *      the next frame's promote tick). */
  private async ensureSoul(ctx: GameContext): Promise<void> {
    await ctx.data.subscriptions.subscribeOwnedCards(this.playerId);
    ctx.data.promote();
    // Count the player-owned soul cards and, if none, request the first one
    // (index `count + 1`). The `spawn_soul` reducer is the authority and
    // rejects a request for an index the player already owns, so even if this
    // count somehow still read low the worst case is one rejected round trip —
    // never a double-spawn.
    const owned = this.ownedSoulCount(ctx);
    if (owned > 0) return;
    try {
      await ctx.reducers.spawnSoul(this.playerId, owned + 1);
    } catch (err) {
      // Rejected when the request raced an existing soul — benign; the
      // soul we already own streams in via the same subscription.
      debug.log(
        ["spacetime"],
        `[spacetime] spawnSoul(player=${this.playerId}, index=${owned + 1}) rejected: ${String(err)}`,
        4,
      );
    }
  }

  /** Count the player-owned soul cards currently visible in `cardsLocal`
   *  (owned-by-player flag + soul card_type). Same predicate as
   *  `firstOwnedSoul`. Callers that need an accurate count right after
   *  subscribing must `await` the subscription (now resolves on `applied`)
   *  and `promote()` first — see `ensureSoul`. */
  private ownedSoulCount(ctx: GameContext): number {
    let n = 0;
    for (const row of ctx.data.cardsLocal.values()) {
      if (row.ownerId !== this.playerId) continue;
      if ((row.flagsState & FLAG_OWNED_BY_PLAYER) === 0) continue;
      if (((row.packedDefinition >> 12) & 0xf) !== SOUL_CARD_TYPE) continue;
      n++;
    }
    return n;
  }

  /** First card the local player owns that is a soul (owned-by-player
   *  flag + soul card_type). `null` when none have synced yet. */
  private firstOwnedSoul(ctx: GameContext): number | null {
    for (const row of ctx.data.cardsLocal.values()) {
      if (row.ownerId !== this.playerId) continue;
      if ((row.flagsState & FLAG_OWNED_BY_PLAYER) === 0) continue;
      if (((row.packedDefinition >> 12) & 0xf) !== SOUL_CARD_TYPE) continue;
      return row.cardId;
    }
    return null;
  }
}
