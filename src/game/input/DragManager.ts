import type { Card } from "../cards/Card";
import { GameHexCard } from "../cards/layout/hexagon/HexCard";
import { LayoutCard } from "../cards/layout/CardLayout";
import { GameRectCard } from "../cards/layout/rectangle/RectCard";
import type { GameContext } from "../../GameContext";
import { debug } from "../../debug";
import { canPickUpCard } from "../permissions";
import { isPositionHeld } from "../actions/chainState";
import { DragGhost } from "./DragGhost";
import { DragHoldStore } from "./DragHoldStore";
import { BlueprintSlot, type BlueprintScope } from "../blueprints/BlueprintSlot";
import {
  getPlayerBlueprintCapacity,
  getSoulBlueprintCapacity,
} from "../blueprints/blueprintCapacity";
import {
  applySourceGate,
  executeDrop,
  resolveHexDrop,
  resolveRectDrop,
  type DropContext,
} from "./dropResolver";
import { LayoutWorld } from "../world/LayoutWorld";
import type { LayoutNode } from "../layout/LayoutNode";
import { packMacroZone, packMicroZone, ZONE_SIZE, WORLD_LAYER } from "../../server/data/packing";
import { STACKED_LOOSE } from "../cards/cardData";
import { findPathForSoul } from "../world/pathfind";
import type { PointerEventData } from "./InputManager";

/** `is_owned_by_player` — bit 4 of `cards_state`. Set on soul cards
 *  (whose `owner_id` is a `player_id`); clear on every other card.
 *  Mirrors the constant in `permissions.ts` / `MainScene.ts`. */
/** Card-type id for `soul` cards. Mirrors `content/cards/types.json`
 *  — kept inline so the ghost-drag check (drag a soul → preview-only,
 *  drop fires `move_soul`) doesn't hit the async definitions
 *  registry. Disambiguates from `FLAG_OWNED_BY_PLAYER` cards that
 *  aren't souls (e.g. the dust card in player inventory carries the
 *  flag because its `owner_id` IS a `player_id`, but it's not a
 *  soul and should drag as a normal card, not a movement command). */
const SOUL_CARD_TYPE = 6;

/** Two distinct drag flavors live behind the same `left_drag_*` events:
 *
 * - **`"card"`** — the standard pickup-and-drop flow. The actual layout
 *   card is detached from its zone surface and reparented to the
 *   overlay so it follows the cursor. On drop the card's row gets
 *   rewritten (`setCardPosition`) to its new location.
 *
 * - **`"ghost"`** — the move-request flow. The source card stays in
 *   place; only a translucent visual copy (`DragGhost`) moves with
 *   the cursor. On drop we log / fire a move reducer rather than
 *   rewriting the source's row. Souls use this today; future
 *   "movement-card" tokens will too. */
type DragState =
  | {
      kind: "card";
      card: Card;
      /** Cursor → card top-left in canvas coords, captured at drag start. */
      offsetX: number;
      offsetY: number;
    }
  | {
      kind: "ghost";
      ghost: DragGhost;
      /** Card whose visual is being mirrored — for debug logging and
       *  for the eventual move-reducer call. */
      sourceCardId: number;
      /** Cursor → card top-left at drag start. Used to position the
       *  ghost so the grab point under the cursor stays consistent. */
      offsetX: number;
      offsetY: number;
    }
  | {
      kind: "blueprint";
      ghost: DragGhost;
      /** Stable blueprint id from `content/blueprints/id.json`
       *  (soul scope) or `content/player_blueprints/id.json`
       *  (player scope) — the payload sent to the matching
       *  request_*_blueprint reducer on drop. */
      blueprintId: number;
      /** Which scope this drag belongs to. Drives the drop branch
       *  (cap check + reducer dispatch). */
      scope: BlueprintScope;
      offsetX: number;
      offsetY: number;
    };

/**
 * Scene-scoped drag orchestrator. Subscribes to `left_drag_start` /
 * `left_drag_stop` from `InputManager` and manages drag-gesture state
 * (which card, with what offset). The visual cursor-follow is owned by
 * `LayoutCard.layout()`, which reads `InputManager.lastPointer` while
 * `state.dragging` is true — DragManager does NOT update card position
 * during the drag.
 *
 * On drop, ownership splits:
 *   - The ghost path stays here (`handleGhostDrop`) — it fires a
 *     move reducer, not a position write.
 *   - The card path delegates to [dropResolver.ts](./dropResolver.ts):
 *     the resolver produces a `DropIntent`, `applySourceGate` may
 *     convert it to `rejected` for `surface_locked` sources, and
 *     `executeDrop` translates the intent into `setCardPosition` /
 *     `stack` calls plus the equip/unequip reducer side-effects.
 */
export class DragManager {
  private state: DragState | null = null;
  private readonly unsubStart: () => void;
  private readonly unsubStop: () => void;
  /** Client-only "I'm currently mid-drag on this card" tracker.
   *  Mirrors `ActionManager`'s prediction store: sidecar state that
   *  the server has no concept of, consulted by the drop-target gate
   *  alongside the server's `drop_hold_count`. See
   *  [DragHoldStore](./DragHoldStore.ts) and
   *  `docs/UNIFIED_HOLD_COUNTS.md`. */
  readonly dragHoldStore = new DragHoldStore();

  constructor(private readonly ctx: GameContext) {
    if (!ctx.input) {
      throw new Error("[DragManager] ctx.input is null — InputManager must exist");
    }

    this.unsubStart = ctx.input.on("left_drag_start", (data) => {
      this.handleDragStart(data);
    });
    this.unsubStop = ctx.input.on("left_drag_stop", ({ down, up }) => {
      this.handleDragStop(down, up);
    });
  }

  dispose(): void {
    if (this.state) {
      if (this.state.kind === "card") {
        this.state.card.setDragging(false);
        this.dragHoldStore.clear(this.state.card.cardId, this.ctx);
      } else {
        // Ghost-style variants ("ghost" for souls, "blueprint" for
        // wrench-panel drags) all carry a `DragGhost` to dispose.
        this.state.ghost.destroy();
      }
      this.state = null;
    }
    this.dragHoldStore.clearAll();
    this.unsubStart();
    this.unsubStop();
  }

  private handleDragStart(data: PointerEventData): void {
    if (this.state) return;

    // Wrench-panel drag: the hit target is a `BlueprintSlot` (not a
    // real `LayoutCard` — the slot has no row in `cardsLocal`).
    // Spawn a ghost from the blueprint's resolved card def and skip
    // the rest of the card-drag pipeline; the drop handler logs the
    // requested tile rather than firing a position-write.
    if (data.hit instanceof BlueprintSlot) {
      if (data.hit.cardPackedDefinition === 0 || data.hit.blueprintId === 0) {
        // Locked slot — bounds should already be collapsed, but
        // belt-and-suspenders in case the layout race ever puts us
        // here with stale state.
        return;
      }
      const slotGlobal = data.hit.container.getGlobalPosition();
      const offsetX = data.x - slotGlobal.x;
      const offsetY = data.y - slotGlobal.y;
      const ghost = new DragGhost(
        this.ctx,
        data.hit.cardPackedDefinition,
        offsetX,
        offsetY,
      );
      this.state = {
        kind: "blueprint",
        ghost,
        blueprintId: data.hit.blueprintId,
        scope: data.hit.scope,
        offsetX,
        offsetY,
      };
      return;
    }

    if (!(data.hit instanceof LayoutCard)) return;

    const card = this.ctx.cards?.get(data.hit.cardId);
    if (!card) return;
    if (!(card.gameCard instanceof GameRectCard) && !(card.gameCard instanceof GameHexCard)) return;

    // Source flag check: position_hold (temporary, e.g. mid-animation /
    // server-held while a magnetic action is using the card) or
    // position_locked (permanent — world tiles, anchored event cards).
    // Either bit blocks pickup. See content/cards/flags.json.
    const row = this.ctx.data.cardsLocal.get(data.hit.cardId);
    if (row && this.pickupBlocked(data.hit.cardId, row.flagsState, row.flagsBk)) return;

    // Permission check: does the local player have authority to pick
    // this card up? Today the rule is ownership; future widenings
    // (party shared cards, world-tile occupants, faction rules)
    // land in `canPickUpCard`. Distinct from the flag check above —
    // flags encode the card's *state*, permissions encode the
    // player's *relationship* to the card. Both must pass.
    if (row && !canPickUpCard(this.ctx, row)) return;

    const cardGlobal = data.hit.container.getGlobalPosition();
    const offsetX = data.x - cardGlobal.x;
    const offsetY = data.y - cardGlobal.y;

    // Soul cards drag as a ghost: the actual card stays at its
    // current tile, only a translucent preview follows the cursor.
    // On drop we'll log / fire a move reducer (see `handleDragStop`).
    // Detection is via `card_type == soul (6)` — the
    // `FLAG_OWNED_BY_PLAYER` bit is no longer a reliable "is this a
    // soul" proxy now that player-inventory items (e.g. the starter
    // dust card) also carry the flag (their `owner_id` IS a
    // `player_id`). Other players' soul cards are still blocked by
    // the `canPickUpCard` gate above (their owner chain doesn't
    // reach the local player), so reaching here with the soul
    // card_type means this is a soul this player owns.
    // Independent of `SoulManager.getSoulId()` — every owned soul
    // is movable regardless of which one's "active". The drag-start
    // input hook in `MainScene` also activates the dragged soul,
    // so the active-soul singleton tracks the most-recently-
    // interacted soul without movement gating on it.
    const cardType = row ? (row.packedDefinition >> 12) & 0xf : -1;
    if (row && cardType === SOUL_CARD_TYPE) {
      const ghost = new DragGhost(this.ctx, row.packedDefinition, offsetX, offsetY);
      this.state = {
        kind: "ghost",
        ghost,
        sourceCardId: card.cardId,
        offsetX,
        offsetY,
      };
      return;
    }

    this.state = { kind: "card", card, offsetX, offsetY };
    card.setDragging(true, offsetX, offsetY);
    // Mark the source card as mid-drag locally so drop-target
    // resolution rejects any concurrent drop attempts that would
    // target this card. The server has no concept of drags, so this
    // is purely client-side state (separate from any server-side
    // `drop_hold_count`).
    this.dragHoldStore.mark(card.cardId, this.ctx);
  }

  private handleDragStop(_down: PointerEventData, up: PointerEventData): void {
    if (!this.state) return;
    const state = this.state;
    this.state = null;

    if (state.kind === "ghost") {
      this.handleGhostDrop(state.sourceCardId, state.ghost, up);
      return;
    }
    if (state.kind === "blueprint") {
      this.handleBlueprintDrop(state.blueprintId, state.scope, state.ghost, up);
      return;
    }

    const { card, offsetX, offsetY } = state;

    // Clear drag state first so the card re-parents back to whichever
    // surface its current data implies (zone surface for loose, parent's
    // stackHost for stacked). Display position is preserved across the
    // re-parent, so the visual stays put while we resolve the drop.
    card.setDragging(false);
    // Mirror: this card is no longer mid-drag locally. Drop-target
    // gates may now accept it again as a target.
    this.dragHoldStore.clear(card.cardId, this.ctx);

    const sourceRow = this.ctx.data.cardsLocal.get(card.cardId);
    if (!sourceRow) return;

    const dropCtx: DropContext = {
      ctx: this.ctx,
      card,
      sourceRow,
      up,
      offsetX,
      offsetY,
      dragHoldStore: this.dragHoldStore,
    };

    const raw = card.gameCard instanceof GameRectCard
      ? resolveRectDrop(dropCtx)
      : resolveHexDrop(dropCtx);
    const gated = applySourceGate(raw, sourceRow, this.ctx);
    if (gated.kind === "rejected") {
      debug.log(["drag"], `[drag] drop card=${card.cardId} rejected — ${gated.reason}`, 3);
    }
    executeDrop(dropCtx, gated);
  }

  /** Ghost-drag drop resolution. Destroys the ghost regardless of
   *  outcome and, on a valid world-tile drop, computes the path
   *  client-side via `findPathForSoul` and fires `move_soul_path`
   *  with the result. Server validates adjacency + traversability
   *  per step and queues the same per-step row writes the old
   *  `move_soul` produced. Drops outside the world view are no-ops.
   *  See [docs/MOVEMENT_REWRITE.md](../../../../docs/MOVEMENT_REWRITE.md). */
  private handleGhostDrop(sourceCardId: number, ghost: DragGhost, up: PointerEventData): void {
    ghost.destroy();
    const worldDrop = this.resolveGhostWorldDrop(up);
    if (!worldDrop) {
      debug.log(
        ["drag"],
        `[drag] ghost drop card=${sourceCardId} outside world view — ignored`,
        2,
      );
      return;
    }

    const zoneQ = Math.floor(worldDrop.q / ZONE_SIZE) * ZONE_SIZE;
    const zoneR = Math.floor(worldDrop.r / ZONE_SIZE) * ZONE_SIZE;
    const localQ = worldDrop.q - zoneQ;
    const localR = worldDrop.r - zoneR;
    const targetMacroZone = packMacroZone(zoneQ, zoneR);
    // Target microZone carries the local (q, r) for pathfinding; the
    // state bits are unused by `coordFromTileAddress`. Use
    // STACKED_LOOSE (state 0) — value 3 is now `STACKED_DEFERRED`
    // (anchored deferred placement) and isn't appropriate for a
    // pathfinding target.
    const targetMicroZone = packMicroZone(localQ, localR, STACKED_LOOSE);

    // `sourceCardId` is the soul card the ghost was minted from in
    // `handleDragStart` — already gated there on
    // `souls.getSoulId() === card.cardId`, so it's guaranteed to be
    // the local player's currently-active soul. The server still
    // re-validates ownership in `move_soul_path` via
    // `resolve_caller` + `cards[soul_id].owner_id` comparison.
    const soul = this.ctx.data.cardsLocal.get(sourceCardId);
    if (!soul) {
      debug.log(
        ["drag"],
        `[drag] ghost drop card=${sourceCardId} — soul not in local view; dropping`,
        2,
      );
      return;
    }
    const result = findPathForSoul(
      this.ctx.data.zonesLocal,
      this.ctx.definitions,
      soul,
      { surface: WORLD_LAYER, macroZone: targetMacroZone, microZone: targetMicroZone },
    );
    if (result === null) {
      debug.log(
        ["drag"],
        `[drag] ghost drop card=${sourceCardId} → (${worldDrop.q}, ${worldDrop.r}) — no path (unreachable, off-map, or unsubscribed zone)`,
        2,
      );
      return;
    }
    if (result.path.length === 0) {
      // Drop on the soul's current tile — no-op, same as
      // `move_soul`'s `start == goal` early return.
      return;
    }
    debug.log(
      ["drag"],
      `[drag] ghost drop card=${sourceCardId} → world tile (${worldDrop.q}, ${worldDrop.r}) — moveSoul ${result.path.length} steps`,
      2,
    );
    void this.ctx.reducers.moveSoul({
      soulId: sourceCardId,
      path: result.path,
    });
  }

  /** Blueprint-drag drop resolution. Destroys the ghost regardless
   *  of outcome and, when the drop lands on a hex-grid view (world
   *  OR a player dimension), fires the scope-matching reducer:
   *
   *  - **soul scope**: `request_blueprint` with the active soul +
   *    target placement. Server validates soul ownership +
   *    `SoulPrivate.blueprints_0` discovery + `aspects.builder` cap.
   *  - **player scope**: `request_player_blueprint` with the caller
   *    player + target placement. Server validates
   *    `PlayerProfile.blueprints_0` discovery + `blueprint_info`
   *    cap.
   *
   *  The cap pre-check mirrors what the server gates on, so we skip
   *  a guaranteed-to-fail roundtrip when the local mirror already
   *  shows the cap is full. */
  private handleBlueprintDrop(
    blueprintId: number,
    scope: BlueprintScope,
    ghost: DragGhost,
    up: PointerEventData,
  ): void {
    ghost.destroy();
    const layoutWorld = findLayoutWorldInChain(up.hit);
    if (!layoutWorld) {
      debug.log(
        ["drag"],
        `[drag] blueprint drop scope=${scope} id=${blueprintId} outside hex-grid view — ignored`,
        2,
      );
      return;
    }
    const g = layoutWorld.container.getGlobalPosition();
    const { q, r } = layoutWorld.localToWorld(up.x - g.x, up.y - g.y);
    const surface = layoutWorld.surface;

    // Pack the global `(q, r)` into the server's
    // `(macro_zone, micro_zone)` shape — same chunk math as
    // `dropResolver.buildPlacement`'s world case.
    const zoneQ = Math.floor(q / ZONE_SIZE) * ZONE_SIZE;
    const zoneR = Math.floor(r / ZONE_SIZE) * ZONE_SIZE;
    const localQ = q - zoneQ;
    const localR = r - zoneR;
    const macroZone = packMacroZone(zoneQ, zoneR);
    const microZone = packMicroZone(localQ, localR, STACKED_LOOSE);

    if (scope === "soul") {
      const soulId = this.ctx.souls.getSoulId();
      if (soulId === null) {
        debug.log(
          ["drag"],
          `[drag] blueprint drop id=${blueprintId} — no active soul; ignored`,
          2,
        );
        return;
      }
      const capacity = getSoulBlueprintCapacity(this.ctx, soulId);
      if (capacity.available <= 0) {
        debug.log(
          ["drag"],
          `[drag] blueprint drop id=${blueprintId} — soul ${soulId} at cap ` +
            `(${capacity.active}/${capacity.max}); not sending request`,
          2,
        );
        return;
      }
      debug.log(
        ["drag"],
        `[drag] request blueprint id=${blueprintId} soul=${soulId} surface=${surface} q=${q} r=${r}`,
        2,
      );
      void this.ctx.reducers.requestBlueprint({
        soulCardId: soulId,
        blueprintId,
        surface,
        macroZone,
        microZone,
        microLocation: 0,
      });
      return;
    }

    // Player scope.
    const playerId = this.ctx.playerSession.getPlayer()?.playerId ?? null;
    if (playerId === null) {
      debug.log(
        ["drag"],
        `[drag] player_blueprint drop id=${blueprintId} — no logged-in player; ignored`,
        2,
      );
      return;
    }
    const capacity = getPlayerBlueprintCapacity(this.ctx, playerId);
    if (capacity.available <= 0) {
      debug.log(
        ["drag"],
        `[drag] player_blueprint drop id=${blueprintId} — player ${playerId} at cap ` +
          `(${capacity.active}/${capacity.max}); not sending request`,
        2,
      );
      return;
    }
    debug.log(
      ["drag"],
      `[drag] request player_blueprint id=${blueprintId} player=${playerId} surface=${surface} q=${q} r=${r}`,
      2,
    );
    void this.ctx.reducers.requestPlayerBlueprint({
      blueprintId,
      surface,
      macroZone,
      microZone,
      microLocation: 0,
    });
  }

  /** World-view drop resolution for ghost drags. Same shape as the
   *  rect/hex resolver's world-view check, but kept here because the
   *  ghost path doesn't share the rest of the resolver pipeline — it
   *  fires a reducer, not a `setCardPosition`. Two signals: an explicit
   *  hit on `LayoutWorld`, or a hit on a Card whose row sits on a world
   *  surface (occluded tile). */
  private resolveGhostWorldDrop(up: PointerEventData): { q: number; r: number } | null {
    const worldView = this.ctx.layout?.worldView;
    if (!worldView) return null;

    let inWorld = up.hit === worldView;
    if (!inWorld && up.hit instanceof LayoutCard) {
      const hitRow = this.ctx.data.cardsLocal.get(up.hit.cardId);
      if (hitRow && hitRow.surface >= WORLD_LAYER) inWorld = true;
    }
    if (!inWorld) return null;

    const g = worldView.container.getGlobalPosition();
    return worldView.localToWorld(up.x - g.x, up.y - g.y);
  }

  /** True if any system currently holds the card's position
   *  (`position_hold_count > 0`) or it's permanently position-locked.
   *  Both block pickup. `position_hold_count` is a ref count rather
   *  than a single bit so multiple concurrent owners (e.g. two
   *  recipes both has-predicate-matching the same axe) compose; the
   *  bit-flag form (`position_hold`) is a tombstone — derived from
   *  `count > 0`. */
  private pickupBlocked(cardId: number, flagsState: number, flagsBk: number): boolean {
    // `isPositionHeld` subsumes the former `position_locked` bit
    // (now expressed as a permanent +1 on `position_hold_count`,
    // per unified-hold-counts rework). Dead cards still appear in
    // `cardsLocal` until GC retention sweeps them; the player should
    // not be able to pick one up. Mirrors the `dead` check in
    // `dropResolver::targetBlocksDrop`.
    return isPositionHeld(this.ctx, cardId, flagsState, flagsBk)
        || this.ctx.definitions.hasCardFlag(flagsState, flagsBk, "dead");
  }
}

/** Walk a hit node's LayoutNode parent chain looking for a
 *  `LayoutWorld`. Mirrors the same-named helper in `dropResolver`
 *  — duplicated here to keep both modules self-contained. Used by
 *  `handleBlueprintDrop` so the drop targets whichever LayoutWorld
 *  is actually under the cursor (dim or world panel), not the
 *  last-write-wins `ctx.layout.worldView` singleton. */
function findLayoutWorldInChain(hit: LayoutNode | null): LayoutWorld | null {
  let n: LayoutNode | null = hit;
  while (n) {
    if (n instanceof LayoutWorld) return n;
    n = n.parent;
  }
  return null;
}
