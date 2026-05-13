import type { Card as CardRow } from "../../server/spacetime/bindings/types";
import type { Card, StackDirection } from "../cards/Card";
import {
  STACK_DIRECTION_DOWN,
  STACK_DIRECTION_UP,
} from "../cards/cardData";
import { GameHexCard } from "../cards/layout/hexagon/HexCard";
import { LayoutCard } from "../cards/layout/CardLayout";
import { GameRectCard } from "../cards/layout/rectangle/RectCard";
import type { GameContext } from "../../GameContext";
import { debug } from "../../debug";
import { canPickUpCard } from "../permissions";
import type { LayoutNode } from "../layout/LayoutNode";
import { DragGhost } from "./DragGhost";
import { packMacroZone, packMicroZone, packZoneId, ZONE_SIZE, WORLD_LAYER } from "../../server/data/packing";
import { STACKED_ON_HEX } from "../cards/cardData";
import type { PointerEventData } from "./InputManager";

/** Maximum allowed chain depth from root to leaf, exclusive of the
 *  root itself. State-2 (`OnRoot`) rows pack `position` into a u5
 *  (0..31), so any chain card whose distance from root would exceed
 *  31 can't be addressed by a state-2 write. Client drag-stack writes
 *  are state-1 today (no position field) and so don't directly hit
 *  this limit, but a future rooted recipe activating on the chain
 *  would pin its actor as state-2 with `position = rootDist` — and if
 *  that pushes any card past 31, the server's
 *  `pack_stack_micro_zone(position & 0x1f, ...)` silently truncates,
 *  corrupting chain layout. We reject the drop preemptively. */
const MAX_CHAIN_DEPTH = 31;

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
    };

/**
 * Scene-scoped drag orchestrator. Subscribes to `left_drag_start` /
 * `left_drag_stop` from `InputManager` and manages drag-gesture state
 * (which card, with what offset). The visual cursor-follow is owned by
 * `LayoutCard.layout()`, which reads `InputManager.lastPointer` while
 * `state.dragging` is true — DragManager does NOT update card position
 * during the drag.
 *
 * On drop, DragManager calls `card.setPosition(...)` which builds a new
 * row in CardManager. The actual write-back is currently a no-op while the
 * outbound reducer path is being wired; once routed, the card's visual
 * catches up via tween from its current (cursor-follow) display position
 * to the new data-driven target.
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
        this.state.ghost.destroy();
      }
      this.state = null;
    }
    this.unsubStart();
    this.unsubStop();
  }

  private handleDragStart(data: PointerEventData): void {
    if (this.state) return;
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

    // Stacked cards are draggable too — dropping them on another card
    // re-stacks, dropping on empty space converts to loose (unstack). Both
    // paths flow through Card.setPosition so the linked-list back-pointers
    // stay consistent.

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

    const { card, offsetX, offsetY } = state;

    // Clear drag state first so the card re-parents back to whichever
    // surface its current data implies (zone surface for loose, parent's
    // stackHost for stacked). Display position is preserved across the
    // re-parent, so the visual stays put while we resolve the drop.
    card.setDragging(false);

    if (card.gameCard instanceof GameRectCard) {
      this.handleRectDrop(card, up, offsetX, offsetY);
    } else if (card.gameCard instanceof GameHexCard) {
      this.handleHexDrop(card, up, offsetX, offsetY);
    }
  }

  /** Ghost-drag drop resolution. Destroys the ghost regardless of
   *  outcome and, on a valid world-tile drop, fires the `move_soul`
   *  reducer with the packed target. The server resolves the move
   *  (validation + soul row rewrite) and we just observe the row
   *  update flow back through the normal mirror path. Drops outside
   *  the world view are no-ops — the user released the soul
   *  somewhere meaningless. */
  private handleGhostDrop(sourceCardId: number, ghost: DragGhost, up: PointerEventData): void {
    ghost.destroy();
    const worldDrop = this.resolveWorldDrop(up);
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
    debug.log(
      ["drag"],
      `[drag] ghost drop card=${sourceCardId} → world tile (${worldDrop.q}, ${worldDrop.r}) — moveSoul surface=${WORLD_LAYER} macroZone=${targetMacroZone} microZone=0x${targetMicroZone.toString(16)}`,
      2,
    );
    void this.ctx.reducers.moveSoul({
      targetSurface: WORLD_LAYER,
      targetMacroZone,
      targetMicroZone,
    });
  }

  private handleRectDrop(
    card: Card,
    up: PointerEventData,
    offsetX: number,
    offsetY: number,
  ): void {
    // Source-side `surface_locked` (content/cards/flags.json bit 2):
    // the card may not be moved to a different `surface`. Same-surface
    // drops (e.g. world tile → world tile, inventory stack → another
    // inventory chain) are still allowed; only cross-layer moves get
    // rejected. We snap back by returning early — the card has already
    // had `setDragging(false)` called, so the next render frame puts
    // it at its row's existing position.
    const sourceRow = this.ctx.data.cardsLocal.get(card.cardId);

    // Stack onto another rect card if one is under the cursor. The dragged
    // card was parented to the hit-transparent overlay, so the up event's
    // hit-test fell through to whatever was beneath. Drop on a peeking title
    // returns the child; CardManager.stack walks to the actual leaf.
    //
    // Target flag check: drop_hold (temporary, mid-drop) or drop_locked
    // (permanent reject of any drop) on the target makes this drop fall
    // through to dropLoose as if there were no target at all.
    const rawTarget = this.targetCardFromHit(up.hit, card.cardId);
    const target = rawTarget && !this.targetBlocksDrop(rawTarget) ? rawTarget : null;
    if (target) {
      const targetRow = this.ctx.data.cardsLocal.get(target.cardId);
      if (target.gameCard instanceof GameRectCard) {
        if (sourceRow && targetRow && this.sourceLocksSurfaceChange(sourceRow, targetRow.surface)) {
          return;
        }
        const direction = this.directionFromCursor(up, target);
        if (this.wouldExceedChainDepth(card, target, direction)) {
          // Combined chain (target's existing chain in `direction`
          // plus dragged card + its chain) would push some card past
          // chain index 31. Fall through to dropLoose so the dragged
          // card lands free in the same zone.
          this.dropLoose(card, up, offsetX, offsetY);
          return;
        }
        this.ctx.cards?.stack(card.cardId, target.cardId, direction);
        return;
      }
      if (target.gameCard instanceof GameHexCard) {
        if (target.stackedHex === 0) {
          if (sourceRow && targetRow && this.sourceLocksSurfaceChange(sourceRow, targetRow.surface)) {
            return;
          }
          this.ctx.cards?.setCardPosition(card.cardId, {
            kind: "stacked",
            parentId: target.cardId,
            direction: "hex",
          });
          return;
        }
      }
    }

    // World drop. Check if the drop landed inside the world view. The
    // hit-test usually resolves this for us — `LayoutWorld` returns
    // itself for empty world space, and any card sitting on the
    // world surface returns its own LayoutCard. We accept either as a
    // signal that the drop point is in world coords.
    const worldDrop = this.resolveWorldDrop(up);
    if (worldDrop) {
      // Every world-drop branch lands the card on `WORLD_LAYER`.
      // Source-side `surface_locked` rejects cross-layer moves up
      // front; same-surface (world → world) drops fall through.
      if (sourceRow && this.sourceLocksSurfaceChange(sourceRow, WORLD_LAYER)) {
        return;
      }
      // World tiles can only hold one card chain at a time — if the
      // target tile already has an occupant, redirect the drop into a
      // stacking attempt onto that occupant. Prefer a rect occupant
      // (a rect mounted on the tile, possibly carrying a chain) over a
      // hex Card occupant; CardManager.stack walks the rect's chain to
      // the leaf and attaches there.
      const occupant = this.findCardAtTile(worldDrop.q, worldDrop.r, card.cardId);
      if (occupant && !this.targetBlocksDrop(occupant)) {
        if (occupant.gameCard instanceof GameRectCard) {
          const direction = this.directionFromCursor(up, occupant);
          if (this.wouldExceedChainDepth(card, occupant, direction)) {
            this.dropLoose(card, up, offsetX, offsetY);
            return;
          }
          this.ctx.cards?.stack(card.cardId, occupant.cardId, direction);
          return;
        }
        if (occupant.gameCard instanceof GameHexCard) {
          if (occupant.stackedHex === 0) {
            this.ctx.cards?.setCardPosition(card.cardId, {
              kind: "stacked",
              parentId: occupant.cardId,
              direction: "hex",
            });
            return;
          }
          // Hex mount already taken — fall through to dropLoose
          // (the rect occupying the mount should have been picked
          // up by the rect-preferred branch above, so reaching
          // here means a stale cache or race).
        }
      }
      // Tile is empty — place the dragged card on it.
      this.ctx.cards?.setCardPosition(card.cardId, {
        kind: "world",
        q: worldDrop.q,
        r: worldDrop.r,
      });
      return;
    }

    // No valid target — drop loose in the same zone.
    this.dropLoose(card, up, offsetX, offsetY);
    // TODO: cross-zone drops
  }

  /** Search `cardsLocal` for a card at the world hex tile `(q, r)`.
   *  Returns a rect occupant when one is present (the rect is the
   *  stack root for further state-1 chain members); otherwise the
   *  hex Card occupying the tile; null when the tile is unoccupied.
   *
   *  Skips `excludeCardId` — used to exclude the dragged card itself,
   *  which has already had its row rewritten to point at the world
   *  tile by the time `setCardPosition({kind:"world"})` ran for a
   *  previous drag-cycle... actually it hasn't been rewritten yet
   *  here, but the exclusion is cheap and prevents self-stacks from
   *  any future write-then-recheck flow. */
  private findCardAtTile(
    q: number,
    r: number,
    excludeCardId: number,
  ): Card | null {
    const cards = this.ctx.cards;
    if (!cards) return null;
    const zoneQ = Math.floor(q / 8) * 8;
    const zoneR = Math.floor(r / 8) * 8;
    const localQ = q - zoneQ;
    const localR = r - zoneR;
    const targetMacroZone = packMacroZone(zoneQ, zoneR);

    let hexCard: Card | null = null;
    let rectCard: Card | null = null;
    for (const [id, row] of this.ctx.data.cardsLocal) {
      if (id === excludeCardId) continue;
      if (row.surface < WORLD_LAYER) continue;
      if (row.macroZone !== targetMacroZone) continue;
      // Both state-0 hex Cards on world and state-3 rect cards on a
      // hex tile encode local q/r in the legacy q/r bit-fields of
      // `microZone` (bits 5-7 = localQ, bits 2-4 = localR). Same
      // unpack works for both.
      const otherLocalQ = (row.microZone >> 5) & 0x7;
      const otherLocalR = (row.microZone >> 2) & 0x7;
      if (otherLocalQ !== localQ || otherLocalR !== localR) continue;
      const c = cards.get(id);
      if (!c) continue;
      if (c.gameCard instanceof GameRectCard) {
        rectCard = c;
      } else if (c.gameCard instanceof GameHexCard) {
        hexCard = c;
      }
    }
    return rectCard ?? hexCard;
  }

  /** Compute the world hex (q, r) the drop landed on, or null when the
   *  drop wasn't inside the world view. Uses `LayoutWorld.localToWorld`
   *  with the drop point in the view's local frame — `up.x` / `up.y`
   *  are canvas-local, so we subtract the world view's global position
   *  to translate. Falls back to a per-hit-test path: when `up.hit` is
   *  LayoutWorld itself, we trust the hit; when it's a Card whose data
   *  row sits on `WORLD_LAYER`, same. Otherwise null.
   *
   *  Either signal alone would work — together they handle the case
   *  where a card visually occluded the empty-tile hit and the case
   *  where the drop landed on a card-less world surface region. */
  private resolveWorldDrop(up: PointerEventData): { q: number; r: number } | null {
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

  private handleHexDrop(
    card: Card,
    up: PointerEventData,
    offsetX: number,
    offsetY: number,
  ): void {
    // World surface drop stripped — hex cards have no other meaningful
    // drop target right now, so they fall straight through to dropLoose.
    this.dropLoose(card, up, offsetX, offsetY);
  }

  private dropLoose(
    card: Card,
    up: PointerEventData,
    offsetX: number,
    offsetY: number,
  ): void {
    // World-source → inventory return: a card sitting on a world tile
    // (or a world surface generally) that gets dropped outside the
    // world view should land back in the owner's inventory at the
    // cursor position. Otherwise we'd fall through to the "loose in
    // current zone" path below, which for a world-rooted card would
    // place it loose on the world surface at the wrong coords (and
    // visually fly off-screen if the cursor is over the inventory
    // panel).
    //
    // We route through `setCardPosition({kind:"inventory"})` so the
    // local row gets a clean inventory shape (surface=1,
    // macroZone=ownerId, microZone state-cleared, microLocation =
    // encoded xy). The xy is the cursor's position translated into
    // the inventory surface's local coords.
    const row = this.ctx.data.cardsLocal.get(card.cardId);
    if (
      row
      && row.surface >= WORLD_LAYER
      && !this.sourceLocksSurfaceChange(row, 1)
    ) {
      const invSurface = this.ctx.layout?.surfaceFor(packZoneId(row.ownerId, 1));
      if (invSurface) {
        const ig = invSurface.container.getGlobalPosition();
        this.ctx.cards?.setCardPosition(card.cardId, {
          kind: "inventory",
          x: up.x - ig.x - offsetX,
          y: up.y - ig.y - offsetY,
        });
        return;
      }
    }

    // Look the zone surface up fresh (rather than using whatever the card was
    // parented to at drag start) — for a stacked-source drag that was a
    // stackHost, not the inventory coord space we need for loose xy.
    const surface = this.ctx.layout?.surfaceFor(card.zoneId());
    if (!surface) return;
    const sg = surface.container.getGlobalPosition();
    card.setPosition({ kind: "loose", x: up.x - sg.x - offsetX, y: up.y - sg.y - offsetY });
  }

  private targetCardFromHit(
    hit: LayoutNode | null,
    draggedId: number,
  ): Card | null {
    if (!(hit instanceof LayoutCard)) return null;
    if (hit.cardId === draggedId) return null;
    return this.ctx.cards?.get(hit.cardId) ?? null;
  }

  /**
   * Upper half of the target → top stack; lower half → bottom stack. Maps
   * intuitively to the visual: drop near where you want the new card's
   * peeking titlebar to appear. Works the same for peeking-title hits since
   * those titles are at the top/bottom edge of their own card.
   */
  private directionFromCursor(
    up: PointerEventData,
    target: Card,
  ): StackDirection {
    const g = target.layoutCard.container.getGlobalPosition();
    const localY = up.y - g.y;
    return localY < target.layoutCard.height / 2 ? "top" : "bottom";
  }

  /** True if the source card's `flags` has either `position_hold` or
   *  `position_locked` set — both block pickup. */
  private pickupBlocked(flags: number): boolean {
    const def = this.ctx.definitions;
    return def.hasCardFlag(flags, "position_hold")
        || def.hasCardFlag(flags, "position_locked");
  }

  /** True if the merged chain (target's existing chain in `direction`,
   *  plus the dragged card and everything stacked on it) would exceed
   *  `MAX_CHAIN_DEPTH` — which would force a state-2 actor pin into
   *  the truncating `position & 0x1f` path. Counts:
   *
   *  - `existing`: cards from the target's chain root outward in
   *    `direction`, excluding the root itself. (`buildChain` returns
   *    chain members only, not the root.)
   *  - `dragged`: the dragged card + every chain descendant in either
   *    direction. `CardManager.stack` flips opposite-direction
   *    descendants before attaching, so the entire dragged subtree
   *    ends up stacked in `direction`; we sum both directions to
   *    capture that.
   *
   *  Reject when `existing + dragged > MAX_CHAIN_DEPTH` — the new
   *  leaf would sit at chain index `existing + dragged`, which must
   *  be ≤ 31. */
  private wouldExceedChainDepth(
    card: Card,
    target: Card,
    direction: StackDirection,
  ): boolean {
    const cards = this.ctx.cards;
    if (!cards) return false;
    const targetRoot = cards.rootOf(target.cardId);
    const dirNum = direction === "top" ? STACK_DIRECTION_UP : STACK_DIRECTION_DOWN;
    const existing = cards.buildChain(targetRoot, dirNum).length;
    const dragged =
      1
      + cards.buildChain(card.cardId, STACK_DIRECTION_UP).length
      + cards.buildChain(card.cardId, STACK_DIRECTION_DOWN).length;
    return existing + dragged > MAX_CHAIN_DEPTH;
  }

  /** True if the target card's `flags` has either `drop_hold` or
   *  `drop_locked` set — both reject incoming drops. Reads the row from
   *  `cardsLocal` (the displayed-state overlay). */
  private targetBlocksDrop(target: Card): boolean {
    const row = this.ctx.data.cardsLocal.get(target.cardId);
    if (!row) return false;
    const def = this.ctx.definitions;
    return def.hasCardFlag(row.flags, "drop_hold")
        || def.hasCardFlag(row.flags, "drop_locked");
  }

  /** True if the source card has `surface_locked` set AND the proposed
   *  destination would change its `surface` field. Same-surface drops
   *  return false even when the flag is set — `surface_locked` is only
   *  about cross-layer moves (inventory ↔ world, etc.), not about
   *  pinning the card to one specific tile / coordinate.
   *
   *  Used to gate every surface-changing branch in `handleRectDrop`
   *  (stack-onto-rect, stack-onto-hex, world-tile drops) and the
   *  world → inventory return path in `dropLoose`. On a reject the
   *  caller simply returns; the card snaps back to its row's
   *  existing position on the next render frame. */
  private sourceLocksSurfaceChange(
    sourceRow: CardRow,
    destinationSurface: number,
  ): boolean {
    if (sourceRow.surface === destinationSurface) return false;
    return this.ctx.definitions.hasCardFlag(sourceRow.flags, "surface_locked");
  }
}
