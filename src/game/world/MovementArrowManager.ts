import { Container, Graphics } from "pixi.js";
import type { GameContext } from "../../GameContext";
import { worldPixelFromRow } from "../cards/cardData";
import type { LayoutWorld } from "./LayoutWorld";
import type { LocalCard } from "../../server/data/DataManager";

/** Arrow stroke style. Thin and bright so it reads over varied
 *  terrain without dominating the world view. */
const ARROW_COLOR = 0xffffff;
const ARROW_ALPHA = 0.85;
const ARROW_WIDTH = 3;
/** Pull the arrow shaft endpoints inward by this many pixels from
 *  each tile's center so it doesn't visually impale the soul card
 *  at the source or stab into the target tile mid-card. */
const ARROW_TAIL_INSET = 26;
const ARROW_HEAD_INSET = 18;
/** Head triangle dimensions. */
const ARROW_HEAD_LENGTH = 14;
const ARROW_HEAD_HALF_WIDTH = 7;

/**
 * Draws a single "next tile" arrow per card whose `LocalCard.target`
 * points to a tile other than the card's current tile.
 *
 * Source: the card's current row (decoded via `worldPixelFromRow`).
 * Destination: `row.target.x/y` (populated by `DataManager.resolveCardTarget`).
 *
 * Lives in the world's panning coord space — arrows are children of
 * `LayoutWorld.worldOverlayContainer`, the same container cards live
 * in, so the viewport-pan transform applies for free.
 *
 * Lifecycle: one `Graphics` per card-id with an active arrow, kept
 * in `arrows`. Subscribed to `subscribeLocalCard` for every change
 * — on add/update we re-evaluate visibility, on remove we destroy.
 * Initial state is seeded by iterating `cardsLocal` at construction.
 *
 * Why one container per card: each arrow has independent visibility
 * + position; bundling into one Graphics would force a full repaint
 * on any change. Per-card Graphics lets us touch only the affected
 * one.
 */
export class MovementArrowManager {
  private readonly arrows = new Map<number, Graphics>();
  private readonly overlay: Container;
  private readonly unsubLocalCard: () => void;

  constructor(
    private readonly ctx: GameContext,
    worldView: LayoutWorld,
  ) {
    this.overlay = worldView.worldOverlayContainer;

    // Seed from anything already in cardsLocal — subscriptions only
    // fire on diffs from this point forward.
    for (const row of this.ctx.data.cardsLocal.values()) {
      this.refresh(row);
    }

    this.unsubLocalCard = this.ctx.data.subscribeLocalCard((change) => {
      if (change.kind === "removed") {
        this.clear(change.key);
        return;
      }
      const row = change.kind === "added" ? change.row : change.newRow;
      this.refresh(row);
    });
  }

  dispose(): void {
    this.unsubLocalCard();
    for (const g of this.arrows.values()) {
      if (g.parent) g.parent.removeChild(g);
      g.destroy();
    }
    this.arrows.clear();
  }

  /** Re-evaluate this card's arrow. Creates / repositions / hides
   *  based on whether `row.target` resolves to a tile different from
   *  the card's current decoded position. Cheap to call on every
   *  row update — the only work for arrows that don't change is a
   *  few comparisons. */
  private refresh(row: LocalCard): void {
    const tgt = row.target;
    if (tgt === undefined) {
      this.clear(row.cardId);
      return;
    }
    const from = worldPixelFromRow(row);
    if (from === null) {
      // Card's current row isn't OnHex / microLocation=0 — no
      // absolute pixel to anchor the arrow tail at. Hide.
      this.clear(row.cardId);
      return;
    }
    if (tgt.x === from.x && tgt.y === from.y) {
      // Target is the same tile we're on — covered by the
      // `resolveCardTarget` fallback after motion completes, or
      // when no future smooth+dirty row exists. Nothing to show.
      this.clear(row.cardId);
      return;
    }
    this.draw(row.cardId, from.x, from.y, tgt.x, tgt.y);
  }

  /** Tear down the arrow for a given card if one exists. */
  private clear(cardId: number): void {
    const g = this.arrows.get(cardId);
    if (g === undefined) return;
    if (g.parent) g.parent.removeChild(g);
    g.destroy();
    this.arrows.delete(cardId);
  }

  /** Draw or re-draw the arrow from `(fromX, fromY)` (source tile
   *  center) toward `(toX, toY)` (destination tile center). Both
   *  endpoints are insetted along the shaft direction so the arrow
   *  doesn't visually overlap with whatever lives at either tile. */
  private draw(cardId: number, fromX: number, fromY: number, toX: number, toY: number): void {
    let g = this.arrows.get(cardId);
    if (g === undefined) {
      g = new Graphics();
      g.eventMode = "none";
      this.overlay.addChild(g);
      this.arrows.set(cardId, g);
    }

    const dx = toX - fromX;
    const dy = toY - fromY;
    const len = Math.hypot(dx, dy);
    if (len === 0) {
      // Degenerate (handled by `refresh`'s same-tile check, but
      // guard against zero-length math in case of bad input).
      g.clear();
      return;
    }
    const ux = dx / len;
    const uy = dy / len;

    // Inset the visible shaft so it doesn't clip the source card or
    // overshoot the destination tile.
    const tailX = fromX + ux * ARROW_TAIL_INSET;
    const tailY = fromY + uy * ARROW_TAIL_INSET;
    const tipX = toX - ux * ARROW_HEAD_INSET;
    const tipY = toY - uy * ARROW_HEAD_INSET;

    // Where the shaft meets the back of the arrowhead. Pulling the
    // line short of the tip avoids the line stroke fattening the
    // triangle's base when they share a pixel.
    const baseX = tipX - ux * ARROW_HEAD_LENGTH;
    const baseY = tipY - uy * ARROW_HEAD_LENGTH;

    // Perpendicular unit vector for the head's outer corners.
    const px = -uy;
    const py = ux;
    const leftX = baseX + px * ARROW_HEAD_HALF_WIDTH;
    const leftY = baseY + py * ARROW_HEAD_HALF_WIDTH;
    const rightX = baseX - px * ARROW_HEAD_HALF_WIDTH;
    const rightY = baseY - py * ARROW_HEAD_HALF_WIDTH;

    g.clear();
    g.moveTo(tailX, tailY)
      .lineTo(baseX, baseY)
      .stroke({ color: ARROW_COLOR, width: ARROW_WIDTH, alpha: ARROW_ALPHA });
    g.moveTo(tipX, tipY)
      .lineTo(leftX, leftY)
      .lineTo(rightX, rightY)
      .closePath()
      .fill({ color: ARROW_COLOR, alpha: ARROW_ALPHA });
  }
}
