import type { Card } from "../cards/Card";
import { GameHexCard } from "../cards/layout/hexagon/HexCard";
import { LayoutCard } from "../cards/layout/CardLayout";
import { GameRectCard } from "../cards/layout/rectangle/RectCard";
import type { GameContext } from "../../GameContext";
import { debug } from "../../debug";
import { canPickUpCard } from "../permissions";
import { DragGhost } from "./DragGhost";
import { BlueprintSlot } from "../toolbar/BlueprintSlot";
import {
  applySourceGate,
  executeDrop,
  resolveHexDrop,
  resolveRectDrop,
  type DropContext,
} from "./dropResolver";
import { packMacroZone, packMicroZone, ZONE_SIZE, WORLD_LAYER } from "../../server/data/packing";
import { STACKED_ON_HEX } from "../cards/cardData";
import { findPathForSoul } from "../world/pathfind";
import type { PointerEventData } from "./InputManager";

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
      /** Stable blueprint id from `content/blueprints/id.json` — the
       *  payload we'll eventually send to the "create blueprint
       *  instance" reducer. Today this just appears in the debug log
       *  so we can see the drop resolved correctly. */
      blueprintId: number;
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
      } else {
        // Ghost-style variants ("ghost" for souls, "blueprint" for
        // wrench-panel drags) all carry a `DragGhost` to dispose.
        this.state.ghost.destroy();
      }
      this.state = null;
    }
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
    if (row && this.pickupBlocked(row.flags)) return;

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
    // Detection is via `SoulManager.getSoulId()` — only the LOCAL
    // player's currently-controlled soul matches, which is what we
    // want (other players' souls are owner-gated by `canPickUpCard`
    // and never reach this path anyway). Future "movement card"
    // types can join this branch by widening the predicate.
    if (row && this.ctx.souls.getSoulId() === card.cardId) {
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
      this.handleBlueprintDrop(state.blueprintId, state.ghost, up);
      return;
    }

    const { card, offsetX, offsetY } = state;

    // Clear drag state first so the card re-parents back to whichever
    // surface its current data implies (zone surface for loose, parent's
    // stackHost for stacked). Display position is preserved across the
    // re-parent, so the visual stays put while we resolve the drop.
    card.setDragging(false);

    const sourceRow = this.ctx.data.cardsLocal.get(card.cardId);
    if (!sourceRow) return;

    const dropCtx: DropContext = {
      ctx: this.ctx,
      card,
      sourceRow,
      up,
      offsetX,
      offsetY,
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
    const targetMicroZone = packMicroZone(localQ, localR, STACKED_ON_HEX);

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
   *  of outcome and, when the drop lands on a world tile, logs the
   *  blueprint id + target tile coords. The actual "create
   *  blueprint instance at tile" reducer is a follow-up — this
   *  handler exists so we can verify the drag pipeline end-to-end
   *  before wiring server behavior. */
  private handleBlueprintDrop(
    blueprintId: number,
    ghost: DragGhost,
    up: PointerEventData,
  ): void {
    ghost.destroy();
    const worldDrop = this.resolveGhostWorldDrop(up);
    if (!worldDrop) {
      debug.log(
        ["drag"],
        `[drag] blueprint drop id=${blueprintId} outside world view — ignored`,
        2,
      );
      return;
    }
    debug.log(
      ["drag"],
      `[drag] would create blueprint id=${blueprintId} at world tile (${worldDrop.q}, ${worldDrop.r})`,
      2,
    );
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
  private pickupBlocked(flags: number): boolean {
    const def = this.ctx.definitions;
    return def.isPositionHeld(flags)
        || def.hasCardFlag(flags, "position_locked")
        // Dead cards still appear in `cardsLocal` until GC retention
        // sweeps them; the player should not be able to pick one up.
        // Mirrors the `dead` check in `dropResolver::targetBlocksDrop`.
        || def.hasCardFlag(flags, "dead");
  }
}
