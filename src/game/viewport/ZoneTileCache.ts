import type { GameContext } from "../../GameContext";
import type { LocalCard } from "../../server/data/DataManager";
import type { Zone } from "../../server/spacetime/bindings/types";
import { decodeZoneTiles } from "./worldCoords";
import { microIsCard, microLooseCell } from "../cards/cardData";
import { debug } from "../../debug";

/** `card_type` value reserved for tile-cards (promoted zone tiles).
 *  Mirrors the constant in `gc.rs` / `world_gen.rs` /
 *  `movement.rs::TILE_CARD_TYPE`. Source of truth lives in
 *  `content/cards/types.json` (`tile` = 7). See `docs/TILE_AS_CARD.md`. */
const TILE_CARD_TYPE = 7;

/** A resolved tile at a cell: packed def + the two stock counters, plus which
 *  source produced it — `"card"` (a promoted tile-card row in `cardsLocal`,
 *  whose def/stocks reflect mid-action mutations) or `"zone"` (the resting
 *  Zone-row snapshot). The viewport rings card-sourced tiles in its debug
 *  overlay, so the source is part of a tile's render signature. */
export interface TileView {
  packed: number;
  stock0: number;
  stock1: number;
  source: "card" | "zone";
}

/**
 * The `(owner, surface)`-scoped tile **data model** behind a viewport — the
 * answer to "what tile is at world cell `(q, r)`?". Two sources, card wins
 * over zone:
 *
 *  - **Zone rows** (`data.zones`): each encodes an 8×8 block of packed tile
 *    slots, decoded into a flat `"${q},${r}"` → `{packed, stock0, stock1}` cache.
 *  - **Promoted tile-cards** (`card_type == 7` rows in `cardsLocal`): indexed by
 *    the cell their micro resolves to (chain-walked to the Free ancestor, since
 *    `chain_stitch` rewrites a bound tile-card's micro away from its hex).
 *
 * Owns the `zones` + `cards` subscriptions that keep both fresh and fires
 * `onChange` after any update, so the viewport re-renders the affected tiles
 * and cards re-bake their object-occlusion overlays.
 *
 * Grid-agnostic: a world hex grid and a rect inventory share this model
 * exactly — only the render shape differs (`LayoutWorld` + `CellGrid`). The
 * `(owner, surface)` scope matters because `data.zones.current` / `cardsLocal`
 * are a single shared mirror across every open viewport.
 */
export class ZoneTileCache {
  /** Zone-derived tiles, keyed `"${q},${r}"` (world-absolute cell coords). */
  private readonly tileData = new Map<string, { packed: number; stock0: number; stock1: number }>();
  /** Cell `"${q},${r}"` → the promoted tile-card occupying it (overrides zone). */
  private readonly tileCardIndex = new Map<string, LocalCard>();
  private readonly changeListeners = new Set<() => void>();
  private readonly unsubZones: () => void;
  private readonly unsubCards: () => void;

  constructor(
    private readonly ctx: GameContext,
    private readonly surface: number,
    private readonly owner: number,
  ) {
    // Hydrate from rows already in the shared mirror so the first read resolves
    // without waiting for a subscription tick.
    for (const zone of ctx.data.zones.current.values()) {
      if (this.owns(zone.macroZone)) this.ingestZone(zone);
    }
    this.rebuildTileCardIndex();

    // Tile-card subscription: a `card_type == 7` row landing / moving / being
    // reaped (demotion) re-points its hex, so rebuild the index and notify.
    this.unsubCards = ctx.data.cards.subscribe((change) => {
      const row =
        change.kind === "removed" ? change.oldRow
        : change.kind === "added" ? change.row
        : change.newRow;
      if (!this.owns(row.macroZone)) return;
      if (((row.packedDefinition >> 12) & 0xf) !== TILE_CARD_TYPE) return;
      this.rebuildTileCardIndex();
      this.fireChange();
    });

    // Zone subscription: on insert / update / remove, evict the zone's 8×8
    // block from the cache and re-decode if the row still exists, then notify.
    this.unsubZones = ctx.data.zones.subscribe((change) => {
      const zone =
        change.kind === "removed" ? change.oldRow
        : change.kind === "added" ? change.row
        : change.newRow;
      debug.log(["zone"], `[ZoneTileCache] zone change kind=${change.kind} key=${change.key}`);
      if (!this.owns(zone.macroZone)) return;
      const { zoneQ, zoneR } = zone.macroZone;
      for (let t = 0; t < 8; t++) {
        for (let b = 0; b < 8; b++) {
          this.tileData.delete(`${zoneQ + b},${zoneR + t}`);
        }
      }
      if (change.kind !== "removed") {
        this.ingestZone(change.kind === "added" ? change.row : change.newRow);
      }
      this.fireChange();
    });
  }

  /** Card-priority `(packed, stock0, stock1, source)` at world cell `(q, r)`,
   *  or `null` (off-map / containing zone not loaded). A promoted tile-card
   *  wins over the zone slot — its `packed_definition` + `tile_stock_{0,1}`
   *  reflect any mid-action mutations (e.g. wood decremented after `cut_tree`). */
  tileViewAt(q: number, r: number): TileView | null {
    const tileCard = this.tileCardIndex.get(`${q},${r}`);
    if (tileCard) {
      return {
        packed: tileCard.packedDefinition,
        stock0: this.ctx.definitions.cardFlagFieldValueIn("cards_bk", tileCard.flagsBk, "tile_stock_0") ?? 0,
        stock1: this.ctx.definitions.cardFlagFieldValueIn("cards_bk", tileCard.flagsBk, "tile_stock_1") ?? 0,
        source: "card",
      };
    }
    const zone = this.tileData.get(`${q},${r}`);
    if (!zone) return null;
    return { ...zone, source: "zone" };
  }

  /** Subscribe to tile-data changes (zone or tile-card). Returns an unsubscribe fn. */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  dispose(): void {
    this.unsubZones();
    this.unsubCards();
    this.changeListeners.clear();
    this.tileData.clear();
    this.tileCardIndex.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private owns(mz: { surface: number; owner: number }): boolean {
    return mz.surface === this.surface && mz.owner === this.owner;
  }

  private ingestZone(zone: Zone): void {
    for (const tile of decodeZoneTiles(zone, this.ctx.definitions)) {
      this.tileData.set(`${tile.q},${tile.r}`, {
        packed: tile.packed,
        stock0: tile.stock0,
        stock1: tile.stock1,
      });
    }
  }

  private fireChange(): void {
    for (const cb of this.changeListeners) cb();
  }

  /** Rebuild the `(q,r)` → tile-card index from `cardsLocal`. Cheap enough to
   *  redo wholesale on each tile-card change (infrequent vs. frames). */
  private rebuildTileCardIndex(): void {
    this.tileCardIndex.clear();
    for (const row of this.ctx.data.cardsLocal.values()) {
      if (!this.owns(row.macroZone)) continue;
      if (((row.packedDefinition >> 12) & 0xf) !== TILE_CARD_TYPE) continue;
      const hex = this.resolveTileCardHex(row);
      if (hex === null) continue;
      const { zoneQ, zoneR } = row.macroZone;
      this.tileCardIndex.set(`${zoneQ + hex.q},${zoneR + hex.r}`, row);
    }
  }

  /** Resolve a tile-card's local `(q, r)` within its zone: a Free tile-card
   *  reads its loose cell from `microLocation`; a stacked one inherits its
   *  root's cell by chasing the chain to the first Free ancestor. Returns
   *  `null` when the chain dead-ends (root reaped) or exceeds the depth cap. */
  private resolveTileCardHex(
    row: { flagsBk: number; microLocation: number },
  ): { q: number; r: number } | null {
    let cur: { flagsBk: number; microLocation: number } | undefined = row;
    for (let depth = 0; depth < 32 && cur !== undefined; depth++) {
      if (!microIsCard(cur.flagsBk)) {
        const { localQ, localR } = microLooseCell(cur.microLocation);
        return { q: localQ, r: localR };
      }
      cur = this.ctx.data.cardsLocal.get(cur.microLocation);
    }
    return null;
  }
}
