import type { Card, StackDirection } from "../cards/Card";
import { GameHexCard } from "../cards/layout/hexagon/HexCard";
import { LayoutCard } from "../cards/layout/CardLayout";
import { GameRectCard } from "../cards/layout/rectangle/RectCard";
import type { GameContext } from "../../GameContext";
import type { LayoutNode } from "../layout/LayoutNode";
import type { PointerEventData } from "./InputManager";

interface DragState {
  card: Card;
  /** Cursor → card top-left in canvas coords, captured at drag start. */
  offsetX: number;
  offsetY: number;
}

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
      this.state.card.setDragging(false);
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

    // Stacked cards are draggable too — dropping them on another card
    // re-stacks, dropping on empty space converts to loose (unstack). Both
    // paths flow through Card.setPosition so the linked-list back-pointers
    // stay consistent.

    const cardGlobal = data.hit.container.getGlobalPosition();
    const offsetX = data.x - cardGlobal.x;
    const offsetY = data.y - cardGlobal.y;

    this.state = { card, offsetX, offsetY };
    card.setDragging(true, offsetX, offsetY);
  }

  private handleDragStop(_down: PointerEventData, up: PointerEventData): void {
    if (!this.state) return;
    const { card, offsetX, offsetY } = this.state;
    this.state = null;

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

  private handleRectDrop(
    card: Card,
    up: PointerEventData,
    offsetX: number,
    offsetY: number,
  ): void {
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
      if (target.gameCard instanceof GameRectCard) {
        const direction = this.directionFromCursor(up, target);
        this.ctx.cards?.stack(card.cardId, target.cardId, direction);
        return;
      }
      if (target.gameCard instanceof GameHexCard) {
        if (target.stackedHex === 0) {
          this.ctx.cards?.setCardPosition(card.cardId, {
            kind: "stacked",
            parentId: target.cardId,
            direction: "hex",
          });
          return;
        }
      }
    }
    // World surface drop stripped — when world tier returns, restore the
    // `this.ctx.world` cursor-rect check + `card.setPosition({ kind: "world" })` path here.

    // No valid target — drop loose in the same zone.
    this.dropLoose(card, up, offsetX, offsetY);
    // TODO: cross-zone drops
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
    // World-card-returning-to-inventory path stripped — when world returns,
    // bail back to `packZoneId(row.ownerId, 1)`'s surface here for cards
    // whose `row.surface >= WORLD_LAYER`.

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
}
