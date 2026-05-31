// Action subsystem is stripped for now — restore when online:
//   import type { CachedAction } from "../actions/ActionManager";
import { DefinitionManager } from "../definitions/DefinitionManager";
import { debug } from "../../debug";
import type { GameContext } from "../../GameContext";
import type { Card as CardRow } from "../../server/spacetime/bindings/types";
import { WORLD_LAYER, type ZoneId } from "../../server/data/packing";
import type { TableChange } from "../../server/data/ValidAtTable";
import {
  decodeMicro,
  directionForBranch,
  microIsCard,
  STACK_STATE_DEFERRED,
} from "./cardData";
import type { LocalCard } from "../../server/data/DataManager";
import type { CardManager } from "./CardManager";
import { CardView } from "./CardView";
import type { GameCard } from "./game/CardGame";
import { GameHexCard, LayoutHexCard } from "./layout/hexagon/HexCard";
import type { LayoutCard } from "./layout/CardLayout";
import { GameRectCard, LayoutRectCard } from "./layout/rectangle/RectCard";

const INVENTORY_LAYER = 1;

export type StackDirection = "top" | "bottom" | "hex";

/** What `Card.setPosition` accepts. Loose = freely placed inventory xy;
 *  inventory = return to a bucket at given xy (resets surface/zone);
 *  stacked = pinned to another card's stack-host with a direction;
 *  world = placed at a specific hex tile `(q, r)` axial coord on a
 *  hex-bearing surface. */
export type CardPositionState =
  | { kind: "loose"; x: number; y: number }
  /** Inventory placement: `soulCardId` is the bucket address — the owning
   *  soul's `card_id` (`surface == INVENTORY_LAYER`). A player's own inventory
   *  is just their `player_soul` card's inventory; there's no separate bucket.
   *
   *  `owner_id` is independent of position and is NOT changed by
   *  inventory placement. */
  | {
      kind: "inventory";
      soulCardId: number;
      x: number;
      y: number;
      /** Defaults to `INVENTORY_LAYER (1)`. */
      surface?: number;
    }
  /** Place loose at rect-grid cell `(q, r)` within the CURRENT container
   *  (zero within-cell offset). Used by the inventory grid for one-card-per-cell
   *  occupancy — `q, r` are local cell coords (0-7), not global. */
  | { kind: "cell"; q: number; r: number }
  | { kind: "stacked"; parentId: number; direction: StackDirection }
  /** World / hex-grid placement. `q, r` are global axial coords on the
   *  overworld (`surface == WORLD_LAYER`). */
  | {
      kind: "world";
      q: number;
      r: number;
      /** Defaults to `WORLD_LAYER (64)`. */
      surface?: number;
      /** Zone owner band — `0` (world) by default; a soul `card_id` for
       *  an inventory bucket. The viewport supplies it. */
      owner?: number;
      /** Within-cell pixel offset from cell centre (i12, clamped to ±2047).
       *  Defaults to `0`. Set by the drop resolver when the destination
       *  surface's kind is LOOSE (per `looseKindForSurface`); ignored
       *  (effectively zero) when the kind is SNAP. Stored in
       *  `micro_location.x/y`; the renderer applies it iff `looseKind` is
       *  `LOOSE_HEX`/`LOOSE_RECT`. */
      offsetX?: number;
      offsetY?: number;
    };

export class Card {
  readonly cardId: number;
  readonly gameCard: GameCard;
  /** The card's visual(s). Phase C: exactly one view. The `layoutCard` getter
   *  below is a back-compat shim for the handful of external callers that
   *  reach for the single layout node. */
  readonly view: CardView;
  get layoutCard(): LayoutCard {
    return this.view.layoutCard;
  }
  // public currentAction: CachedAction | null = null;  // actions stripped
  private readonly cardManager: CardManager;
  private unsubscribe: (() => void) | null = null;
  // private unsubAction: (() => void) | null = null;            // actions stripped
  // private unsubActionPending: (() => void) | null = null;     // actions stripped
  private currentZoneId: ZoneId;
  /** card_id we're stacked on, or 0 when loose. Drives layout-side parenting:
   *  loose → zone surface, stacked → parent card's stackHost. */
  private currentParentId = 0;
  /** Semantic stack direction. null when loose. */
  private currentStackDirection: StackDirection | null = null;
  /** Last-seen `microLocation`. Tracked so a loose world card moving between
   *  hexes (its cell lives in `microLocation` now) surfaces as a tile-change
   *  event even when parent/direction are unchanged (both 0/null for loose). */
  private currentMicroLocation = 0;

  /**
   * Card stacked directly on top of us (state 1), or 0 if none. Public so
   * `CardManager.stack`'s chain-walk can read these without ceremony. The
   * authoritative state still lives in the child's row (microLocation +
   * microZone's stackedState bits); these are convenience back-pointers that
   * let us walk down a chain in O(1) per step instead of scanning every
   * card. Kept in sync by Card.onDataChange (incoming data) and Card.destroy
   * (removal).
   */
  public stackedTop = 0;
  /** Card stacked directly below us (state 2), or 0 if none. Same caveat. */
  public stackedBottom = 0;
  /** Rect card mounted on us via STACK_DIRECTION_HEX (the hex-tile branch),
   *  or 0 if none. Under the unified card model the encoding is
   *  `STACKED_ON_ROOT + direction=HEX + position=1` with `microLocation
   *  = this.cardId`; the field name and back-pointer role survive from
   *  the legacy state-3 (then `STACKED_ON_HEX`, now repurposed as
   *  `STACKED_DEFERRED`) model. */
  public stackedHex = 0;

  /** Resolve the IMMEDIATE parent's card_id for this row.
   *
   *  - `STACKED_SLOT`: `microLocation` IS the immediate parent
   *    (parent-pointer model — server-written for recipe slots above
   *    the actor; client-written for rect-chain drag attaches).
   *  - `STACKED_ON_ROOT`: `microLocation` is the chain ROOT. The
   *    immediate parent is the chain member at `position - 1` in the
   *    same direction. If `position == 1`, the parent is the root
   *    itself. Falls back to the root if the expected predecessor
   *    isn't in the overlay (gap-tolerant). Covers the hex-mount case
   *    (direction = HEX, position = 1, microLocation = parent hex tile)
   *    via the same `position == 1 → root` path.
   *  - `STACKED_DEFERRED` (3): transient deferred-placement row;
   *    resolved by `mirrorCard` to a concrete state 1/2 before chain
   *    walks see it. If one slips through (subscription gap where the
   *    host hasn't arrived yet), we return 0 — deferred rows aren't
   *    part of any chain until resolution lands.
   *  - `STACKED_LOOSE`: no parent. */
  private static stackParentOf(
    row: CardRow,
    _cardsLocal: Map<number, LocalCard>,
  ): number {
    // Flat-root: a stack member's visual parent is its chain ROOT. Every
    // member of a branch parents to the root's stack host and offsets by its
    // `stackIndex` (RectCard layout), so no per-card predecessor lookup is
    // needed. Loose cards have no parent; a still-deferred member (resolved
    // by `mirrorCard` before chain walks normally see it) isn't in a chain.
    const micro = decodeMicro(row.microLocation, row.flagsBk);
    if (micro.kind !== "stacked") return 0;
    if (micro.branch === STACK_STATE_DEFERRED) return 0;
    return micro.root;
  }

  private static stackDirectionOf(row: CardRow): StackDirection | null {
    const micro = decodeMicro(row.microLocation, row.flagsBk);
    if (micro.kind !== "stacked") return null;
    // Deferred members have no chain direction until mirror-time resolution.
    return directionForBranch(micro.branch);
  }

  static create(
    cardId: number,
    ctx: GameContext,
    cardManager: CardManager,
  ): Card | null {
    // Prefer the server's promoted current row over the local overlay for
    // first-time creation: `cardsLocal` is the result of mirror passes plus
    // any client-side `setLocalCard` writes, which don't necessarily carry
    // position fields forward across every write site (e.g. partial
    // overlay updates). `data.cards.current` is the canonical server view
    // for the now-promoted row, so it's the safer source for spawn-time
    // shape + position reads. Fall back to `cardsLocal` only when the
    // server tier hasn't surfaced the row yet (rare, but possible for
    // client-only optimistic rows that haven't round-tripped).
    const row =
      ctx.data.cards.current.get(cardId) ?? ctx.data.cardsLocal.get(cardId);
    if (!row) {
      debug.warn(["cards"], `[Card] no row for card ${cardId}, skipping spawn`);
      return null;
    }
    const { typeId } = DefinitionManager.unpack(row.packedDefinition);
    const shape = ctx.definitions.shape(typeId) ?? "rect";
    if (shape === "hex") {
      return new Card(
        cardId,
        ctx,
        cardManager,
        new GameHexCard(cardId, ctx),
        new LayoutHexCard(cardId, ctx),
      );
    }
    return new Card(
      cardId,
      ctx,
      cardManager,
      new GameRectCard(cardId, ctx),
      new LayoutRectCard(cardId, ctx),
    );
  }

  constructor(
    cardId: number,
    ctx: GameContext,
    cardManager: CardManager,
    gameCard: GameCard,
    layoutCard: LayoutCard,
  ) {
    this.cardId = cardId;
    this.cardManager = cardManager;
    this.gameCard = gameCard;
    this.view = new CardView(cardManager, layoutCard);

    // Source the initial row from `data.cards.current` (the server's
    // promoted canonical row) rather than `cardsLocal`. See the
    // `Card.create` docstring for the rationale — same reasoning
    // applies here for position fields used to compute zoneId / parent
    // / direction at spawn time.
    const initialRow =
      ctx.data.cards.current.get(cardId) ?? ctx.data.cardsLocal.get(cardId);
    this.currentZoneId = initialRow ? initialRow.macroZone.packed : -1n;

    if (initialRow) {
      // Decide where this card lives on the layout tree before we apply data,
      // so applyData's setTarget calls are interpreted in the correct coord
      // space. Orphan stacked cards (parent missing) get rewritten loose to
      // the owner's inventory and then attached there.
      //
      // Parent lookup still goes through `cardsLocal` because that's the
      // tier game code reads to ask "where is card N?" — the local
      // overlay carries client-side splice / fallback rewrites that the
      // server's view doesn't.
      this.currentParentId = Card.stackParentOf(initialRow, ctx.data.cardsLocal);
      this.currentStackDirection = Card.stackDirectionOf(initialRow);
      this.currentMicroLocation = initialRow.microLocation;
      let row: CardRow = initialRow;
      if (this.currentParentId !== 0 && !cardManager.get(this.currentParentId)) {
        this.fallbackToInventory(initialRow);
        // `fallbackToInventory` writes through `setLocalCard`, so the
        // post-fallback read must come from `cardsLocal` to pick up
        // that rewrite — `cards.current` still has the orphan shape.
        row = ctx.data.cardsLocal.get(cardId) ?? initialRow;
        this.currentZoneId = row.macroZone.packed;
        this.currentParentId = 0;
        this.currentStackDirection = null;
        this.currentMicroLocation = row.microLocation;
      }
      this.gameCard.applyData(row);
      this.view.applyData(row);
      this.view.attachToCurrent(
        this.currentParentId,
        this.currentStackDirection,
        this.currentZoneId,
      );
      // Best-effort back-pointer: if our parent already exists, claim our
      // slot on it. If the parent hasn't spawned yet, CardManager's
      // post-init repair pass picks it up.
      if (this.currentParentId !== 0 && this.currentStackDirection) {
        this.setBackPointerOn(this.currentParentId, this.currentStackDirection);
      }
    }

    this.unsubscribe = ctx.data.subscribeLocalCardKey(cardId, (change) => {
      this.onDataChange(change);
    });

    // Action subscriptions stripped while ActionManager is offline. Restore
    // when the actions subsystem returns:
    //   if (ctx.actions) {
    //     this.unsubAction = ctx.actions.subscribeCard(cardId, (action) => {
    //       this.currentAction = action;
    //       this.layoutCard.invalidate();
    //     });
    //   }
    //   this.unsubActionPending = ctx.data.actions.subscribePending((change) => {
    //     const row = change.newValue ?? change.oldValue;
    //     if (row && row.cardId === this.cardId) this.layoutCard.invalidate();
    //   });
  }

  /**
   * Canonical setter for a card's position. Always go through here so the
   * layout-side re-parent + tween + back-pointer maintenance stay in
   * lockstep with the data, and callers don't need to know about flag
   * bit-fiddling or which slot to touch on which neighbor.
   *
   * The back-pointer cleanup (clearing our slot on the old parent if any,
   * claiming our slot on the new parent if stacked) happens in onDataChange
   * — single funnel for both our writes here and any server-driven update.
   *
   * Note: write-back through `CardManager.setCardPosition` is currently a
   * no-op pending the outbound reducer wire. Until that lands, calls here
   * compute the new row but don't propagate.
   */
  setPosition(state: CardPositionState): void {
    this.cardManager.setCardPosition(this.cardId, state);
  }

  private clearBackPointerOn(parentId: number, direction: StackDirection): void {
    const parent = this.cardManager.get(parentId);
    if (!parent) return;
    if (direction === "top") {
      if (parent.stackedTop === this.cardId) parent.stackedTop = 0;
    } else if (direction === "bottom") {
      if (parent.stackedBottom === this.cardId) parent.stackedBottom = 0;
    } else {
      if (parent.stackedHex === this.cardId) parent.stackedHex = 0;
    }
  }

  private setBackPointerOn(parentId: number, direction: StackDirection): void {
    const parent = this.cardManager.get(parentId);
    if (!parent) return;
    if (direction === "top") parent.stackedTop = this.cardId;
    else if (direction === "bottom") parent.stackedBottom = this.cardId;
    else parent.stackedHex = this.cardId;
  }

  /** Repair orphaned chain attachment after the initial spawn pass.
   *  Called by `CardManager.repairParenting` once every Card exists,
   *  so the "parent not yet in registry" race the constructor's
   *  `fallbackToInventory` branch handles can be reversed.
   *
   *  Re-resolves the true parent from the current row and, if it
   *  now exists in CardManager, detaches from wherever we ended up
   *  (the inventory surface, typically) and re-attaches to the
   *  parent's stack host. No-op for cards whose state never
   *  requires a parent (loose), and for cards whose constructor
   *  succeeded in attaching to the right parent the first time. */
  repairParenting(): void {
    const row = this.layoutCard.ctx.data.cardsLocal.get(this.cardId);
    if (!row) return;
    const trueParentId = Card.stackParentOf(row, this.layoutCard.ctx.data.cardsLocal);
    const trueDirection = Card.stackDirectionOf(row);
    // Loose / unstacked rows: no parent to repair to.
    if (trueParentId === 0 || trueDirection === null) return;
    // Already correctly parented — constructor handled it.
    if (this.currentParentId === trueParentId && this.currentStackDirection === trueDirection) {
      return;
    }
    const parent = this.cardManager.get(trueParentId);
    if (!parent) return; // still orphan; nothing we can do here.
    this.currentParentId = trueParentId;
    this.currentStackDirection = trueDirection;
    this.view.attachToCurrent(
      this.currentParentId,
      this.currentStackDirection,
      this.currentZoneId,
    );
    this.setBackPointerOn(trueParentId, trueDirection);
  }

  /**
   * Stacked card whose parent doesn't exist — orphan. Was a `setClientCard`
   * path that wrote a corrected loose row and let the post-init data path
   * see the fix through onDataChange. With client-side mutations gone, this
   * is currently a no-op pending reducer routing — orphans stay visually
   * stranded until the new outbound path is wired.
   */
  private fallbackToInventory(row: CardRow): void {
    void row;
    // TODO: route through a reducer when the outbound API is ready. The old
    // path was:
    //   this.layoutCard.ctx.data.setClientCard({
    //     ...row,
    //     macroZone:     row.ownerId,
    //     surface:       INVENTORY_LAYER,
    //     microZone:     0,
    //     microLocation: 0,
    //   });
  }

  zoneId(): ZoneId {
    return this.currentZoneId;
  }

  whereAreYou(): { x: number; y: number } {
    return this.gameCard.whereAreYou();
  }

  /**
   * Forwards drag state to both halves so game logic (overlap-push skip) and
   * visual state stay in sync. On drag start, also re-parents the layout half
   * from its zone surface up to the global overlay so the card can roam
   * freely above the rest of the scene; on drag stop, returns it to the
   * surface for its current zone. The on-screen position is preserved across
   * each re-parent (display is converted between coord spaces) so the
   * transition is seamless.
   *
   * `offsetX` / `offsetY` are the cursor → card top-left offsets at grab time
   * (in surface-local coords). They get plumbed to LayoutCard which uses them
   * to keep the card under the cursor while dragging.
   */
  setDragging(value: boolean, offsetX = 0, offsetY = 0): void {
    this.gameCard.setDragging(value);
    // Visual half (re-parent to / from the drag overlay, preserving on-screen
    // position). On release the view re-attaches to whatever the current model
    // state implies — stackHost for a stacked card, zone surface for a loose
    // one — so a "drop on same parent" path doesn't strand the card when no
    // data actually changes; onDataChange reparents again if the drop did
    // change state.
    this.view.setDragging(
      value,
      offsetX,
      offsetY,
      this.currentParentId,
      this.currentStackDirection,
      this.currentZoneId,
    );
  }

  isDragging(): boolean {
    return this.gameCard.isDragging();
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    // this.unsubAction?.();        // actions stripped
    // this.unsubAction = null;
    // this.unsubActionPending?.();
    // this.unsubActionPending = null;
    // Free our slot on the parent so its back-pointer doesn't dangle.
    if (this.currentParentId !== 0 && this.currentStackDirection) {
      this.clearBackPointerOn(this.currentParentId, this.currentStackDirection);
    }
    this.gameCard.destroy();
    this.view.destroy();
  }

  private onDataChange(change: TableChange<CardRow>): void {
    if (change.kind === "removed") return;
    const row = change.kind === "added" ? change.row : change.newRow;

    const newZoneId = row.macroZone.packed;
    const newParentId = Card.stackParentOf(row, this.layoutCard.ctx.data.cardsLocal);
    const newStackDirection = Card.stackDirectionOf(row);
    const newMicroLocation = row.microLocation;
    const zoneChanged = newZoneId !== this.currentZoneId;
    const parentChanged = newParentId !== this.currentParentId;
    const directionChanged = newStackDirection !== this.currentStackDirection;
    // World-tile move detection: a loose card on the world surface encodes its
    // cell `(localQ, localR)` in `microLocation`; its `(zoneQ, zoneR)` chunk
    // address lives in `macroZone`. A move between two empty tiles inside the
    // same chunk doesn't change parent or direction (both loose) — without this
    // trigger, `ActionManager.evaluateRoot` never re-runs and a queued recipe
    // (e.g. corpus on tree) keeps the stale hex def. Cross-chunk moves are
    // caught by `zoneChanged` (macroZone changes). Stacked members aren't loose,
    // so they're excluded.
    const tileChanged =
      !microIsCard(row.flagsBk) &&
      row.macroZone.surface >= WORLD_LAYER &&
      newMicroLocation !== this.currentMicroLocation;

    if (zoneChanged || parentChanged || directionChanged || tileChanged) {
      debug.log(
        ["splice"],
        `[splice] onDataChange card=${this.cardId} isCard=${microIsCard(row.flagsBk)} microLocation=${row.microLocation} zone=${this.currentZoneId}->${newZoneId} parent=${this.currentParentId}->${newParentId} dir=${this.currentStackDirection}->${newStackDirection}`,
        2,
      );
      // Orphan check before mutating state, so we can early-out cleanly
      // without leaving currentZoneId / currentParentId half-updated.
      // Direction-only changes (same parent, top↔bottom) don't move us between
      // surfaces — only the layout target shifts, which applyData handles.
      const reparentNeeded = zoneChanged || parentChanged;
      if (reparentNeeded && newParentId !== 0 && !this.cardManager.get(newParentId)) {
        // Orphan — write a corrected row. setClient fires this same
        // subscriber synchronously, and that recursive pass (with
        // newParentId === 0) does the actual re-parent.
        this.fallbackToInventory(row);
        return;
      }

      if (zoneChanged) {
        const oldZoneId = this.currentZoneId;
        this.currentZoneId = newZoneId;
        this.cardManager.move(this.cardId, oldZoneId, newZoneId);
      }

      // Capture old parent before we mutate it, so we can fire a stack-
      // change event for the chain we're leaving. The new chain's root we
      // resolve from newParentId (or this card itself when becoming loose).
      const oldParentId = this.currentParentId;
      const oldDirection = this.currentStackDirection;

      // Back-pointer maintenance: clear our slot on the old parent (if we had
      // one) and claim our slot on the new parent (if stacked).
      if (parentChanged || directionChanged) {
        if (oldParentId !== 0 && oldDirection) {
          this.clearBackPointerOn(oldParentId, oldDirection);
        }
        this.currentParentId = newParentId;
        this.currentStackDirection = newStackDirection;
        if (newParentId !== 0 && newStackDirection) {
          this.setBackPointerOn(newParentId, newStackDirection);
        }
      }

      // View half: resolve the layout parent for the new model state (now
      // committed to `current*`) and re-parent there. Per-view; the orphan
      // case is already handled above.
      if (reparentNeeded) {
        this.view.reparentToModel(
          this.currentParentId,
          this.currentStackDirection,
          this.currentZoneId,
        );
      }

      // Stash the new microLocation before firing so re-entrant subscribers
      // see consistent state (mirrors the currentZoneId timing above).
      this.currentMicroLocation = newMicroLocation;

      // Fire stack-change events for both affected chains. A chain is
      // "affected" if this card joined or left it; when both old and new
      // resolve to the same root (e.g. direction-only change on the same
      // parent) we only fire once. Loose-to-loose moves don't enter this
      // block so they don't fire — that matches the spec ("any case that
      // wasn't a rejected drop or a loose -> loose drop").
      //
      // `tileChanged` (state-3 card moved between world tiles with parent
      // and direction both unchanged) also needs to fire. The card's
      // chain is rooted at itself in the virtual-world-hex-root case
      // (microLocation = 0) — `rootOf` returns the card id when the
      // hex parent doesn't exist locally. Even when parent is a real
      // hex Card, that hex Card doesn't move with the rect, so the
      // re-evaluation we want is for this card's own chain.
      if (parentChanged || directionChanged || tileChanged) {
        // Resolve old/new chain roots so ActionManager can re-evaluate
        // both sides of the move. Under the unified card model, a
        // state-3 child IS part of its hex parent's chain (buildChain
        // walks state-3 children at chainIdx=1) — so when a state-3
        // card joins/leaves its hex, the HEX's chain just gained or
        // lost a member. We need to re-evaluate the hex's chain, not
        // pretend the chain is rooted on the moving card itself.
        // (Earlier code special-cased `direction === "hex"` to use
        // `this.cardId` as root, which is correct only for the legacy
        // "rect mounted on hex" model where hex was a separate
        // anchor — now dropped.)
        const oldRoot =
          oldParentId !== 0
            ? this.cardManager.rootOf(oldParentId)
            : this.cardId;
        const newRoot =
          newParentId !== 0
            ? this.cardManager.rootOf(newParentId)
            : this.cardId;
        this.cardManager.fireStackChange(oldRoot);
        if (newRoot !== oldRoot) this.cardManager.fireStackChange(newRoot);
      }
    }

    this.gameCard.applyData(row);
    this.layoutCard.applyData(row);
  }
}
