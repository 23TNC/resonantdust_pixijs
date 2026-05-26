import type { GameContext } from "../../GameContext";
import { GameInventory } from "./InventoryGame";
import { LayoutInventory } from "./InventoryLayout";
import type { LayoutNode } from "../layout/LayoutNode";
import { INVENTORY_LAYER, packZoneId, PLAYER_INVENTORY_LAYER } from "../../server/data/packing";
import type { ManagedPanel } from "../../ui/panels/PanelManager";
import { PanelTaskbar } from "../../ui/dom/PanelTaskbar";
import { PixiPanel } from "../../ui/dom/PixiPanel";
import { tryActivateSoul } from "../permissions";

/** Where in the Pixi tree the inventory panel parents itself. The
 *  factory in MainLayout passes the MainLayout instance. */

/** Initial width for an inventory PixiPanel when no saved rect
 *  exists for this soul. */
const DEFAULT_INVENTORY_WIDTH = 440;

/** Initial size for a mini inventory popover (chest-style — capacity
 *  in 1..=9). Sized for a small grid of card-sized tiles; the actual
 *  layout flexes to whatever `LayoutInventory.setBounds` lays out
 *  given this box. */
const MINI_INVENTORY_WIDTH = 280;
const MINI_INVENTORY_HEIGHT = 180;
/** Pixel gap between the clicked card and the bottom edge of the
 *  mini panel — keeps the popover visually clear of the card it
 *  belongs to without floating away from it. */
const MINI_INVENTORY_VERTICAL_GAP = 12;

/**
 * Inventory panel — backs an "inventory bucket" `Zone` (no tile
 * data, just a `(surface, macro_zone)` address that cards live in).
 *
 * Two modes:
 *
 *  - **Soul inventory** (`surface == INVENTORY_LAYER (1)`,
 *    `ownerId = soul.card_id`): per-soul bag. Focusing the panel
 *    activates the soul via `tryActivateSoul` — drag pickup
 *    downstream reads `souls.getSoulId()` so the soul needs to be
 *    "selected" before any inventory drag.
 *
 *  - **Player inventory** (`surface == PLAYER_INVENTORY_LAYER (2)`,
 *    `ownerId = player_id`): account-wide bucket shared across all
 *    of the player's souls (for permanent items). No active-soul
 *    activation on focus — the bucket isn't soul-scoped.
 *
 * Owns:
 *
 *  - The `PixiPanel` chrome (right-anchored by default, taskbar-tabbed).
 *  - The `LayoutInventory` visual surface that hosts the card stack.
 *  - The `GameInventory` physics tick (overlap-push + grid snap),
 *    registered with `ctx.game` so `MainManager.tick` drives it.
 *  - A `ZoneManager.ensureInventory(ownerId)` / `ensurePlayerInventory(ownerId)`
 *    refcount, so the zone subscription stays alive while this
 *    panel is open.
 *
 * `destroy()` is the single teardown path. Order:
 *
 *   1. Remove `GameInventory` from `MainManager`'s tick set.
 *   2. `gameInventory.dispose()`.
 *   3. `releaseZone()` — drop the refcount on the inventory zone.
 *   4. `panel.destroy()` — cascades into `content.destroy()` which
 *      destroys `LayoutInventory` (detaches cards instead of destroying
 *      them, since the zone may still be subscribed).
 */
export class InventoryPanel implements ManagedPanel {
  readonly panel: PixiPanel;
  readonly layoutInventory: LayoutInventory;
  readonly gameInventory: GameInventory;
  /** The owning id — `soul.card_id` for soul inventory,
   *  `player_id` for player inventory. Discriminate via `surface`. */
  readonly ownerId: number;
  readonly surface: number;
  /** Presentation mode. `"default"` is the persistent right-anchored
   *  soul / player inventory window (taskbar entry, drag-resize).
   *  `"mini"` is the chest-style popover used for small-capacity
   *  inventories (`inventory` feature value in `1..=9`): smaller
   *  default rect, anchored above the click position, no taskbar
   *  entry. */
  readonly mode: "default" | "mini";
  /** Max number of cards this inventory accepts. `Infinity` (or
   *  unset) means uncapped. Display-only today; server-side
   *  enforcement is a separate concern. */
  readonly capacity: number;
  /** Backwards-compat shim: callers that previously read
   *  `panel.soulCardId` continue to work in soul mode. Returns
   *  `null` in player-inventory mode (no soul). */
  get soulCardId(): number | null {
    return this.surface === INVENTORY_LAYER ? this.ownerId : null;
  }
  private readonly ctx: GameContext;
  private readonly releaseZone: () => void;
  private destroyed = false;

  constructor(
    ctx: GameContext,
    parent: LayoutNode,
    ownerId: number,
    options: {
      surface?: number;
      title?: string;
      mode?: "default" | "mini";
      capacity?: number;
      /** Viewport-pixel anchor for `mode: "mini"` — the click
       *  position the popover should sit above. Ignored in
       *  default mode. */
      anchorX?: number;
      anchorY?: number;
    } = {},
  ) {
    if (!ctx.layout) throw new Error("[InventoryPanel] ctx.layout must be set");
    if (!ctx.cards) throw new Error("[InventoryPanel] ctx.cards must be set");

    this.ctx = ctx;
    this.ownerId = ownerId;
    this.surface = options.surface ?? INVENTORY_LAYER;
    this.mode = options.mode ?? "default";
    this.capacity = options.capacity ?? Infinity;
    const zoneId = packZoneId(ownerId, this.surface);

    this.layoutInventory = new LayoutInventory(ctx.layout, zoneId);

    // Title is now composed by DomPanel from `baseTitle + suffix
    // resolver`. The default suffix below preserves the prior
    // "Inventory - <something>" shape: soul inventories pick the
    // soul's card name, player inventories pick the player name.
    // User can flip the mode (or set it to "none") via the popup.
    const isSoulInventory = this.surface === INVENTORY_LAYER;
    const isMini = this.mode === "mini";
    // Mini popover anchors above the clicked card — compute the
    // top-left so the panel's bottom edge sits `MINI_*_GAP` pixels
    // above the click point. Falls back to a top-left placement at
    // the click if no anchor was provided.
    const miniLeft = (options.anchorX ?? 0) - MINI_INVENTORY_WIDTH / 2;
    const miniTop  = (options.anchorY ?? 0) - MINI_INVENTORY_HEIGHT - MINI_INVENTORY_VERTICAL_GAP;
    this.panel = new PixiPanel({
      title: options.title ?? "Inventory",
      parent,
      titleSuffix: isSoulInventory ? "soul" : "player",
      titleSuffixResolvers: {
        player: () => ctx.playerSession.getPlayer()?.name ?? null,
        // Soul-name lookup: ownerId is the soul card id in soul
        // mode. Walk the local cards mirror → packedDefinition →
        // definitions.label for the user-facing name. `null` when
        // the row hasn't arrived (initial subscription gap) so
        // the composed title falls back to bare "Inventory".
        ...(isSoulInventory ? {
          soul: () => {
            const row = ctx.data.cardsLocal.get(ownerId);
            if (!row) return null;
            return ctx.definitions.label(row.packedDefinition);
          },
        } : {}),
      },
      // Mini popovers key separately so their per-instance saved
      // size/position doesn't bleed back into the default panel
      // (and vice versa). Both modes carry the (surface, owner) in
      // the key so distinct cards / souls each get their own slot.
      storageKey: isMini
        ? `gameInventoryPanel:mini:${this.surface}:${ownerId}`
        : `gameInventoryPanel:${this.surface}:${ownerId}`,
      // Per-instance storageKey (surface+owner unique per panel), but
      // every inventory panel of the same mode shares one entry in
      // the content defaults file under a stable prefix.
      defaultsKey: isMini ? "gameInventoryPanelMini" : "gameInventoryPanel",
      defaultRect: isMini
        ? {
            left:   `${miniLeft}px`,
            top:    `${miniTop}px`,
            width:  `${MINI_INVENTORY_WIDTH}px`,
            height: `${MINI_INVENTORY_HEIGHT}px`,
          }
        : {
            right:  "0",
            top:    `${PanelTaskbar.HEIGHT}px`,
            width:  `${DEFAULT_INVENTORY_WIDTH}px`,
            height: `calc(100vh - ${PanelTaskbar.HEIGHT * 2}px)`,
          },
      minWidth:   isMini ? 200 : 320,
      minHeight:  isMini ? 140 : 400,
      minimizable: true,
      closable:    true,
      // Mini popovers skip the taskbar — they're ephemeral
      // chest-style affordances, not persistent windows the user
      // expects to minimize/restore.
      taskbar:     isMini ? undefined : ctx.taskbar,
      uiEditMode:  ctx.uiEditMode,
    });
    this.panel.content.addChild(this.layoutInventory);

    // Push body-rect changes into the LayoutInventory so its grid +
    // children re-flow when the user drags / resizes the panel.
    const unsubRect = this.panel.onRectChange(() => {
      this.layoutInventory.setBounds(
        0, 0,
        this.panel.content.width,
        this.panel.content.height,
      );
    });
    // Clear the rect subscription on destroy so a fired-after-destroy
    // event from PixiPanel internals doesn't touch a torn-down node.
    this.panel.onDestroy(() => unsubRect());

    // Register the interior `LayoutInventory` so `PanelManager.
    // findPanelByDescendant` can route Pixi-side body clicks
    // (cards, empty inventory area, drag-starts) back to this
    // panel for focus + active-soul activation. Unregistered in
    // `cleanup()` so a destroyed panel's node doesn't linger in
    // the lookup.
    ctx.panels?.registerNode(this.layoutInventory, this);

    // Refcount the inventory zone so recipes keep ticking while this
    // panel is open. For soul inventory, SoulManager already holds a
    // player-wide refcount for every owned soul; this stacks on top.
    // For player inventory, this is the only refcount keeping it alive.
    this.releaseZone =
      this.surface === PLAYER_INVENTORY_LAYER
        ? ctx.zones.ensurePlayerInventory(ownerId)
        : ctx.zones.ensureInventory(ownerId);

    // GameInventory physics. Snapshot of cards in zone + subscription
    // for future adds/removes. Registered with the tick driver.
    this.gameInventory = new GameInventory(ctx, zoneId);
    ctx.game?.add(this.gameInventory);

    // Panel-initiated destroy (user clicks X, taskbar tear-down,
    // PanelManager.closeAll on scene exit) routes through
    // `this.destroy()` via the inner panel's onDestroy. Guarded so an
    // explicit `inventoryPanel.destroy()` and a chrome-initiated
    // destroy don't double-fire the cleanup.
    this.panel.onDestroy(() => this.cleanup());

    // Focusing this panel activates its soul (if the local player
    // owns it). Drag pickup gates downstream all read
    // `souls.getSoulId()`, so clicking an inventory before dragging
    // out of it gets the active soul into the right state without
    // the user having to remember to "select" the soul first.
    // Player-inventory panels skip this — there's no soul to
    // activate at the player-wide bucket level.
    if (this.surface === INVENTORY_LAYER) {
      const soulId = ownerId;
      this.panel.onFocus(() => {
        tryActivateSoul(this.ctx, soulId);
      });
    }
  }

  focus(): void { this.panel.focus(); }

  destroy(): void {
    // Destroy fans out to `cleanup()` via the inner PixiPanel's
    // onDestroy listener. Calling destroy again would no-op since
    // `cleanup` flips `destroyed` and PanelManager will have already
    // unregistered us.
    this.panel.destroy();
  }

  onFocus(cb: () => void): () => void {
    return this.panel.onFocus(cb);
  }

  onDestroy(cb: () => void): () => void {
    return this.panel.onDestroy(cb);
  }

  /** Internal teardown shared by panel-initiated destroy (user closes
   *  via X or taskbar) and explicit `destroy()` call. Idempotent. */
  private cleanup(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ctx.panels?.unregisterNode(this.layoutInventory);
    this.ctx.game?.remove(this.gameInventory);
    this.gameInventory.dispose();
    this.releaseZone();
  }

  /** Hint to layout: the inventory surface should show its placement
   *  grid (used by `MainScene`'s KeyE handler while held). */
  showGrid(show: boolean): void {
    this.layoutInventory.showGrid(show);
  }

  /** Hint to physics: snap every card to the nearest grid cell. */
  snapToGrid(): void {
    this.gameInventory.snapToGrid();
  }

}
