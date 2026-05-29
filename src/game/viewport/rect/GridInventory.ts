import type { Card } from "../../cards/Card";
import { decodeMicro, microIsCard } from "../../cards/cardData";
import { GameHexCard } from "../../cards/layout/hexagon/HexCard";
import {
  GameRectCard,
  RECT_CARD_HEIGHT,
  RECT_CARD_WIDTH,
} from "../../cards/layout/rectangle/RectCard";
import type { GameContext } from "../../../GameContext";
import type { ZoneId } from "../../../server/data/packing";

const GRID_PAD = 8;
/** Cell footprint of the inventory rect grid (card + padding). Shared with the
 *  `RectGrid` the inventory `LayoutWorld` is constructed with, so on-screen
 *  cells and occupancy cells line up exactly. */
export const GRID_W = RECT_CARD_WIDTH + GRID_PAD;
export const GRID_H = RECT_CARD_HEIGHT + GRID_PAD;

/** `micro.localQ/localR` are 3-bit fields → cells 0..7 on each axis. */
const MAX_CELLS = 8;
/** Safety bound on chain walks — prevents runaway on malformed cyclic data. */
const FIND_ROOT_MAX_DEPTH = 64;

/**
 * One-card-per-cell occupancy for a single inventory zone. Replaces the old
 * continuous overlap-push (`GameInventory`) now that inventory is a `RectGrid`
 * `LayoutWorld` viewport: each loose root card owns a grid cell `(localQ,
 * localR)`; this assigns distinct cells so no two roots share one.
 *
 * Stacked members ride their root (parented to its stack host), so only roots
 * are placed. A card's cell lives in `micro.localQ/localR` (see
 * `CardPositionState` `"cell"`); rendering is handled by `RectCard` via the
 * view's `cellToPixel`. Local-optimistic, like the prior push — placement
 * writes through `Card.setPosition` (`setLocalCard`), not the server.
 */
export class GridInventory {
  private readonly cards = new Set<Card>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly ctx: GameContext,
    private readonly zoneId: ZoneId,
    /** Cell footprint in pixels — drives how many cells fit the panel. Comes
     *  from the viewport's grid (rect or hex), so occupancy bounds match the
     *  on-screen cell spacing regardless of grid shape. */
    private readonly cellW: number = GRID_W,
    private readonly cellH: number = GRID_H,
  ) {
    if (!ctx.cards) throw new Error("[GridInventory] ctx.cards is null");
    for (const card of ctx.cards.cardsInZone(zoneId)) {
      if (card.gameCard instanceof GameRectCard || card.gameCard instanceof GameHexCard) {
        this.cards.add(card);
      }
    }
    this.unsubscribe = ctx.cards.subscribe(zoneId, (kind, card) => {
      if (!(card.gameCard instanceof GameRectCard) && !(card.gameCard instanceof GameHexCard)) return;
      if (kind === "added") this.cards.add(card);
      else this.cards.delete(card);
    });
  }

  update(_dt: number): void {
    const surface = this.ctx.layout?.surfaceFor(this.zoneId);
    const cols = Math.max(1, Math.min(MAX_CELLS, Math.floor((surface?.width ?? Infinity) / this.cellW)));
    const rows = Math.max(1, Math.min(MAX_CELLS, Math.floor((surface?.height ?? Infinity) / this.cellH)));

    // Roots only, in a stable order (by card id) so cell assignment is
    // deterministic frame-to-frame — no jitter from Set iteration order.
    const roots: Card[] = [];
    const seen = new Set<number>();
    for (const c of this.cards) {
      const root = this.findRoot(c);
      if (root && this.cards.has(root) && !seen.has(root.cardId)) {
        seen.add(root.cardId);
        roots.push(root);
      }
    }
    roots.sort((a, b) => a.cardId - b.cardId);

    const occupied = new Set<number>();
    const key = (q: number, r: number): number => r * MAX_CELLS + q;

    // Pass 1: dragging cards pin their current cell so others route around it.
    for (const root of roots) {
      if (!root.isDragging()) continue;
      const cell = this.cellOf(root);
      if (cell) occupied.add(key(cell.q, cell.r));
    }
    // Pass 2: place the rest into distinct free cells (keep current cell when
    // it's in-bounds and free; otherwise raster-scan for the next free one).
    for (const root of roots) {
      if (root.isDragging()) continue;
      const cur = this.cellOf(root);
      let q = cur?.q ?? 0;
      let r = cur?.r ?? 0;
      const inBounds = q >= 0 && q < cols && r >= 0 && r < rows;
      if (!inBounds || occupied.has(key(q, r))) {
        const free = this.firstFree(cols, rows, occupied);
        if (!free) continue; // grid full — leave it where it is
        q = free.q;
        r = free.r;
      }
      occupied.add(key(q, r));
      if (!cur || cur.q !== q || cur.r !== r) {
        root.setPosition({ kind: "cell", q, r });
      }
    }
  }

  private firstFree(
    cols: number,
    rows: number,
    occupied: Set<number>,
  ): { q: number; r: number } | null {
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        if (!occupied.has(r * MAX_CELLS + q)) return { q, r };
      }
    }
    return null;
  }

  /** Current grid cell of a loose root from its local row, or null if missing. */
  private cellOf(card: Card): { q: number; r: number } | null {
    const row = this.ctx.data.cardsLocal.get(card.cardId);
    if (!row) return null;
    const micro = decodeMicro(row.microLocation, row.flagsBk);
    if (micro.kind !== "loose") return null;
    return { q: micro.localQ, r: micro.localR };
  }

  /** Flat-root: a loose card (`!micro_is_card`) IS the root; a member's
   *  `microLocation` is its root (one hop). Null on missing/malformed data. */
  private findRoot(card: Card): Card | null {
    let current: Card = card;
    for (let i = 0; i < FIND_ROOT_MAX_DEPTH; i++) {
      const row = this.ctx.data.cardsLocal.get(current.cardId);
      if (!row) return null;
      if (!microIsCard(row.flagsBk)) return current;
      const parent = this.ctx.cards?.get(row.microLocation);
      if (!parent) return null;
      current = parent;
    }
    return null;
  }

  dispose(): void {
    this.unsubscribe();
    this.cards.clear();
  }
}
