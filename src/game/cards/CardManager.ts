import { debug } from "../../debug";
import type { GameContext } from "../../GameContext";
import type { Card as CardRow } from "../../server/spacetime/bindings/types";
import {
  makeMacroZone,
  INVENTORY_LAYER,
  WORLD_LAYER,
  ZONE_SIZE,
  type ZoneId,
} from "../../server/data/packing";
import { owningSoul } from "../permissions";
import { Card, type CardPositionState, type StackDirection } from "./Card";
import { GameHexCard } from "./layout/hexagon/HexCard";
import {
  applyMicro,
  branchForDirection,
  decodeMicro,
  encodeLooseXY,
  looseKindForSurface,
  microIsCard,
  stackState as stackBranch,
  stackIndex,
  MAX_CHAIN_DEPTH,
  STACK_DIR_DOWN,
  STACK_DIR_HEX,
  STACK_DIR_UP,
  STACK_STATE_DEFERRED,
  type Micro,
} from "./cardData";
// World helpers (packMacroZone, unpackMacroZone, WORLD_LAYER, ZONE_SIZE) live
// in `server/data/packing` — re-import there when world tier is restored.

/** Card-type id for promoted zone tiles. Mirrors `cards/types.json`
 *  (`tile` = 7) and the parallel constants in `LayoutWorld`,
 *  `ActionManager`, `movement.rs`, etc. */
const TILE_CARD_TYPE = 7;

export type CardChangeKind = "added" | "removed";
export type CardListener = (kind: CardChangeKind, card: Card) => void;

/** Discriminated union describing where a card is about to land —
 *  passed to [`CardManager.canPlaceCardAt`] so each rejection
 *  reason has a typed surface to test against. The cascade in
 *  [`CardManager.appendAtChainLeaf`] constructs one of these per
 *  tier (stack-leaf, loose at q/r, inventory) before committing. */
export type PlacementTarget =
  | { kind: "stack-leaf"; parentId: number; direction: number }
  | { kind: "loose"; surface: number; macroZone: bigint; q: number; r: number }
  | { kind: "inventory"; soulId: number };
/**
 * Fired when a stack is "modified" — a card joined, left, or changed
 * direction within a chain. Receives the root id of the affected chain in
 * its post-change state. Same root may be reported via two listeners
 * (oldRoot + newRoot) when a card moves between chains.
 */
export type StackChangeListener = (rootId: number) => void;

const FIND_ROOT_MAX_DEPTH = 64;

export class CardManager {
  private readonly cards = new Map<number, Card>();
  private readonly byZone = new Map<ZoneId, Set<Card>>();
  private readonly listeners = new Map<ZoneId, Set<CardListener>>();
  private readonly stackListeners = new Map<ZoneId, Set<StackChangeListener>>();
  private readonly globalStackListeners = new Set<StackChangeListener>();
  private readonly unsubscribe: () => void;
  /** Cards currently being spliced out — suppress fireStackChange for these roots. */
  private readonly splicing = new Set<number>();

  constructor(private readonly ctx: GameContext) {
    for (const cardId of ctx.data.cardsLocal.keys()) {
      this.spawn(cardId);
    }
    // Spawn order also means a child whose parent wasn't yet in the
    // registry hit `Card`'s `fallbackToInventory` branch and attached
    // to the inventory surface instead of its parent's stack host.
    // Now that every Card exists, walk them all and re-evaluate
    // parenting — anything that should be chained but isn't gets
    // detached + re-attached to the right parent. Bare-loose cards
    // and cards already correctly parented are no-ops.
    this.repairParenting();
    this.unsubscribe = ctx.data.subscribeLocalCard((change) => {
      if (change.kind === "added") {
        // Defensive: an "added" event whose initial row is already
        // `dead === 2` would spawn-then-immediately-despawn. Skip the
        // spawn entirely so we don't churn the scene tree.
        if (change.row.dead === 2) return;
        this.spawn(change.key);
      } else if (change.kind === "removed") {
        this.destroy(change.key);
      } else if (change.kind === "updated") {
        // Transition into `dead === 2` means the death animation has
        // finished and splice has run — the card is logically gone.
        // Despawn it now so the world-surface hit-test layer no
        // longer sees it; the row stays in `cardsLocal` until the
        // server reaps, but without a `Card` mirror nothing tries to
        // render or hit-test it. Lets fresh drops on the same tile
        // resolve to the empty world tile underneath instead of
        // routing through the dead card's reject path.
        if (change.newRow.dead === 2 && change.oldRow.dead !== 2) {
          this.destroy(change.key);
        }
        // Other "updated" cases — position / flag bits changed.
        // Cards subscribe to their own key for data changes;
        // CardManager only cares about spawn/despawn transitions.
      }
    });
  }

  /**
   * Remove `cardId` from its chain, bridging the gap it leaves behind.
   * Pure client concern — the server has no view of board layout and
   * can't repair chains for us.
   *
   * **Mental model.** Each card has an effective "parent" depending
   * on its state:
   *
   * | State           | Effective parent for splice                          |
   * | --------------- | ---------------------------------------------------- |
   * | LOOSE           | none — successor becomes a new loose root            |
   * | SLOT            | `microLocation`                                      |
   * | ON_ROOT pos N   | same-direction state-1 child IF any (fills slot),    |
   * |                 | else state-2 successors renumber down                |
   *
   * State 3 (formerly `STACKED_ON_HEX`, now repurposed as
   * `STACKED_DEFERRED`) doesn't appear in this splice path —
   * deferred rows are resolved by `mirrorCard` into state 1/2
   * before chain-splice logic ever sees them; if one slips through
   * via a subscription gap, it has no chain identity yet and the
   * splice family treats it as a no-op.
   *
   * For each direction (UP/DOWN) the dying card has children in,
   * those children re-parent to the dying card's effective parent,
   * keeping their own direction. The chain "compresses" through the
   * removed card.
   *
   * Invariant: splice only runs after the death animation has
   * completed and `RectCard.layout` has written `dead: 2` to the
   * local row. The dying card row lingers in `cardsLocal` until the
   * server reaps it; chain walks that need to ignore the corpse use
   * the `dead === 2` filter on the dying card's row directly.
   */
  spliceCard(cardId: number): void {
    const card = this.cards.get(cardId);
    if (!card) return;
    const row = this.ctx.data.cardsLocal.get(cardId);
    if (!row) return;

    // Splice fires when `RectCard.layout` sees the death animation
    // complete (deathProgress >= 4). At that moment the row is still
    // dead=1 — the caller writes dead=2 immediately AFTER splice
    // returns (the dead=2 write triggers `CardManager.destroy`, which
    // would tear down `this.cards.get(cardId)` and force splice to
    // bail). Accept either dead=1 or dead=2 here, and refuse if the
    // card isn't dying at all (defensive — would mean an unexpected
    // splice call site).
    if (row.dead !== 1 && row.dead !== 2) {
      debug.log(
        ["splice"],
        `[splice] refuse card=${cardId} dead=${row.dead ?? "undefined"} (expected 1 or 2); animation hasn't started`,
        0,
      );
      return;
    }

    this.splicing.add(cardId);

    debug.log(
      ["splice"],
      `[splice] enter card=${cardId} isCard=${microIsCard(row.flagsBk)} microLocation=${row.microLocation} macroZone=${row.macroZone.packed} surface=${row.macroZone.surface}`,
      1,
    );

    // Flat-root: a dying MEMBER just leaves a gap — siblings keep their indices
    // (gap-tolerant rendering draws everything). Only a dying ROOT needs repair:
    // its members lose their anchor, so promote one to a new loose root and
    // re-root the rest onto it.
    if (!microIsCard(row.flagsBk)) {
      this.spliceRoot(cardId, row);
    }

    card.stackedTop = 0;
    card.stackedBottom = 0;
    card.stackedHex = 0;
    this.splicing.delete(cardId);
    debug.log(["splice"], `[splice] exit card=${cardId}`, 1);
  }

  /** A loose ROOT is dying. Promote the first member (top branch wins, then
   *  bottom, then hex) to a new loose root at the dying card's position, and
   *  re-root every other member onto it preserving their branch. */
  private spliceRoot(D_id: number, D_row: CardRow): void {
    const top = this.buildChain(D_id, STACK_DIR_UP).map((c) => c.cardId);
    const bottom = this.buildChain(D_id, STACK_DIR_DOWN).map((c) => c.cardId);
    const hex = this.buildChain(D_id, STACK_DIR_HEX).map((c) => c.cardId);

    // Pick the primary branch (whichever has members; top > bottom > hex).
    let primary: number[];
    let primaryDir: StackDirection;
    const others: { ids: number[]; dir: StackDirection }[] = [];
    if (top.length > 0) {
      primary = top; primaryDir = "top";
      others.push({ ids: bottom, dir: "bottom" }, { ids: hex, dir: "hex" });
    } else if (bottom.length > 0) {
      primary = bottom; primaryDir = "bottom";
      others.push({ ids: top, dir: "top" }, { ids: hex, dir: "hex" });
    } else if (hex.length > 0) {
      primary = hex; primaryDir = "hex";
      others.push({ ids: top, dir: "top" }, { ids: bottom, dir: "bottom" });
    } else {
      return; // no members — nothing to promote
    }

    const newRootId = primary[0];
    // Promote the new root to the dying card's exact cell — same zone
    // (owner + surface), same loose cell, same within-cell `(x, y)` offset —
    // regardless of grid. The viewport's grid decides hex-vs-rect render
    // downstream; this splice is grid-agnostic. Passing `owner` keeps an
    // inventory splice on its own bucket (the "world" kind defaults owner to
    // 0 otherwise). Preserving the offset keeps a free-placed root's
    // promoted-successor in the exact same visual spot.
    const dMicro = decodeMicro(D_row.microLocation, D_row.flagsBk);
    const localQ = dMicro.kind === "loose" ? dMicro.localQ : 0;
    const localR = dMicro.kind === "loose" ? dMicro.localR : 0;
    this.setCardPosition(newRootId, {
      kind: "world",
      q: D_row.macroZone.zoneQ + localQ,
      r: D_row.macroZone.zoneR + localR,
      surface: D_row.macroZone.surface,
      owner: D_row.macroZone.owner,
      offsetX: dMicro.kind === "loose" ? dMicro.x : 0,
      offsetY: dMicro.kind === "loose" ? dMicro.y : 0,
    });

    // Re-root the rest of the primary branch + the other branches as members
    // of the new root. `setCardPosition` claims the next free index per branch.
    for (let i = 1; i < primary.length; i++) {
      this.setCardPosition(primary[i], { kind: "stacked", parentId: newRootId, direction: primaryDir });
    }
    for (const o of others) {
      for (const id of o.ids) {
        this.setCardPosition(id, { kind: "stacked", parentId: newRootId, direction: o.dir });
      }
    }
  }

  /** Probe — would this card be accepted at the proposed placement?
   *  Consulted by every tier of the state-3 deferred-placement
   *  cascade ([`appendAtChainLeaf`]) before committing to a write.
   *
   *  Today a stub that returns true for all targets; grows as
   *  rejection cases get implemented:
   *  - **Drop-locked target**: `drop_hold_count > 0` on the
   *    prospective parent for stack-tier placements.
   *  - **Surface restriction**: certain card types refuse certain
   *    surfaces (e.g. world-only cards on inventory layers).
   *  - **Type compatibility**: chain rules on what can stack on
   *    what (e.g. tile cards can't stack on rect cards).
   *  - **Chain at MAX_CHAIN_DEPTH with no eviction path**: target
   *    chain is at the cap and the eviction cascade has nowhere
   *    to send the displaced topmost.
   *
   *  Each rejection reason lands in this single decision point so
   *  the cascade has consistent semantics across tiers. */
  canPlaceCardAt(_card: CardRow, _target: PlacementTarget): boolean {
    return true;
  }

  /** All current members of `rootId` — flat: every card whose `microLocation`
   *  points at it as root (`micro_is_card` set). */
  private membersOf(rootId: number): CardRow[] {
    const out: CardRow[] = [];
    for (const [, r] of this.ctx.data.cardsLocal) {
      if (r.microLocation === rootId && microIsCard(r.flagsBk)) out.push(r);
    }
    return out;
  }

  /** The member occupying `(rootId, branch, index)`, or null. `excludeId`
   *  skips a card (e.g. the incoming row). Used by `DataManager.mirrorCard` to
   *  detect a `pos_need` / `pos_want` slot collision. */
  findMemberAt(
    rootId: number,
    branch: number,
    index: number,
    excludeId = 0,
  ): CardRow | null {
    for (const r of this.membersOf(rootId)) {
      if (r.cardId === excludeId) continue;
      if (stackBranch(r.flagsBk) === branch && stackIndex(r.flagsBk) === index) {
        return r;
      }
    }
    return null;
  }

  /** Next free `stackIndex` in `(rootId, branch)` — max occupied + 1,
   *  saturating at the chain cap; 0 when the branch is empty. */
  private nextBranchIndex(rootId: number, branch: number): number {
    let max = -1;
    for (const r of this.membersOf(rootId)) {
      if (stackBranch(r.flagsBk) === branch) max = Math.max(max, stackIndex(r.flagsBk));
    }
    return Math.min(max + 1, MAX_CHAIN_DEPTH - 1);
  }

  /** The chain root's row for `card` — `card` itself when loose, else the root
   *  it points at (one hop in the flat model). */
  private rootRowOf(card: CardRow): CardRow | null {
    if (!microIsCard(card.flagsBk)) return card;
    return this.ctx.data.cardsLocal.get(card.microLocation) ?? null;
  }

  /** Splice an incoming server `pos_need` / `pos_want` member into a chain when
   *  a local card already occupies its `(root, branch, index)` slot.
   *
   *  - `nAbove === false` (**pos_need**): incoming wins its exact slot; the
   *    occupant is bumped to the next free index in the branch.
   *  - `nAbove === true` (**pos_want**): incoming stacks above the occupant —
   *    it claims the next free index instead of the occupant's slot.
   *
   *  Returns the incoming row to fold into the caller's authoritative write,
   *  plus `overflowTop` (the occupant) when the branch is full so the caller
   *  can `evictCard` it. Flat-root: indices are gap-tolerant, so this only
   *  reshuffles `stackIndex` — no parent-pointer relinking. */
  insertIntoSlotChain(
    incoming: CardRow,
    occupant: CardRow,
    nAbove: boolean,
  ): { incomingRow: CardRow; overflowTop: CardRow | null } {
    const root = incoming.microLocation;
    const branch = stackBranch(incoming.flagsBk);
    const freeIdx = this.nextBranchIndex(root, branch);
    const branchFull = freeIdx >= MAX_CHAIN_DEPTH - 1
      && this.findMemberAt(root, branch, freeIdx, incoming.cardId) !== null;

    if (nAbove) {
      // pos_want: incoming goes above the occupant at the next free index.
      const placed = applyMicro(
        { kind: "stacked", root, branch, index: freeIdx },
        incoming.flagsBk,
      );
      return { incomingRow: { ...incoming, ...placed }, overflowTop: branchFull ? occupant : null };
    }
    // pos_need: incoming keeps its server slot; bump the occupant up.
    if (!branchFull) {
      const placed = applyMicro(
        { kind: "stacked", root, branch, index: freeIdx },
        occupant.flagsBk,
      );
      this.ctx.data.setLocalCard(occupant.cardId, { ...occupant, ...placed });
    }
    return { incomingRow: incoming, overflowTop: branchFull ? occupant : null };
  }

  /** Evict a card to a fallback position: the owning soul's inventory, else
   *  loose on the chain root's tile, else leave it (server reconciles).
   *  Flat-root via `applyMicro`. */
  evictCard(card: CardRow): void {
    const soul = owningSoul(this.ctx, card.cardId);
    if (soul) {
      const placed = applyMicro(
        { kind: "loose", localQ: 0, localR: 0, x: 0, y: 0, looseKind: looseKindForSurface(INVENTORY_LAYER) },
        card.flagsBk,
      );
      this.ctx.data.setLocalCard(card.cardId, {
        ...card,
        macroZone: makeMacroZone(soul.soulCardId, INVENTORY_LAYER, 0, 0),
        ...placed,
      });
      return;
    }
    const rootRow = this.rootRowOf(card);
    if (rootRow) {
      // Land loose on the chain root's own cell, in the root's zone (owner +
      // surface) — grid-agnostic; the viewport renders it hex or rect. If the
      // root has a within-cell `(x, y)` offset (LOOSE-kind placement), inherit
      // it so the evicted card lands visually next to its old root instead of
      // snapping to the cell centre.
      const rMicro = decodeMicro(rootRow.microLocation, rootRow.flagsBk);
      const localQ = rMicro.kind === "loose" ? rMicro.localQ : 0;
      const localR = rMicro.kind === "loose" ? rMicro.localR : 0;
      const x = rMicro.kind === "loose" ? rMicro.x : 0;
      const y = rMicro.kind === "loose" ? rMicro.y : 0;
      const placed = applyMicro(
        { kind: "loose", localQ, localR, x, y, looseKind: looseKindForSurface(rootRow.macroZone.surface) },
        card.flagsBk,
      );
      this.ctx.data.setLocalCard(card.cardId, { ...card, macroZone: rootRow.macroZone, ...placed });
      return;
    }
    debug.log(
      ["splice", "evict"],
      `[evict] ${card.cardId} no fallback — leaving at prior position; server will reconcile`,
      1,
    );
  }

  /** Resolve a state-3 deferred-placement row to a concrete state
   *  1/2 placement via the five-tier cascade documented on
   *  [`STACKED_DEFERRED`] in `cardData.ts`. Writes the resolved row
   *  via `setLocalCard`; returns nothing — the caller reads
   *  `cardsLocal.get(cardId)` if it needs the resolved shape.
   *
   *  Tier order:
   *    1. **Leaf-append on host's chain.** Walk `microLocation`
   *       (host) down to chain root, identify growth direction
   *       (Top child present → Top; Bottom → Bottom; both → Top;
   *       neither → try Top then Bottom), walk up to leaf, append
   *       as state-1 child. Skipped when host is 0 or not in
   *       `cardsLocal`.
   *    2. **Loose at fallback (q, r).** Decode (q, r) from the
   *       deferred row's `microZone` legacy layout, write as
   *       `STACKED_LOOSE` at `(deferredRow.surface,
   *       deferredRow.macroZone, q, r)`.
   *    3. **Owner inventory.** Walk owner chain via [`owningSoul`];
   *       if found, write loose-at-(0,0) on `(INVENTORY_LAYER,
   *       soulId)`. The receiving inventory's `clampToSurface`
   *       picks the next free grid slot.
   *    4. **Free (q, r) in macroZone.** Spiral-search axially from
   *       the fallback (q, r) within the same `(surface, macroZone)`
   *       for a slot the probe accepts.
   *    5. **Worst case.** Write loose at the fallback (q, r)
   *       verbatim without probe; log so the failure surfaces.
   *
   *  Each tier consults [`canPlaceCardAt`] before committing. The
   *  probe is a stub today (always returns true); each rejection
   *  reason lands there incrementally. Until the probe gets real
   *  teeth, tier 1 always succeeds when the host exists, so tiers
   *  2-5 are mostly defensive against host-gone edge cases. */
  appendAtChainLeaf(deferredRow: CardRow): void {
    const hostId = deferredRow.microLocation;
    const host = hostId !== 0 ? this.ctx.data.cardsLocal.get(hostId) : undefined;

    // ---- Tier 1: join the host's chain ----------------------------
    // Resolve the host's root + branch and claim the next free index in that
    // branch (append-to-end; gap-tolerant). If the host is loose it IS the
    // root; default to the top branch.
    if (host) {
      const root = this.rootOf(hostId);
      const rootRow = this.ctx.data.cardsLocal.get(root);
      const branch = microIsCard(host.flagsBk) ? stackBranch(host.flagsBk) : STACK_DIR_UP;
      const index = this.nextBranchIndex(root, branch);
      const placed = applyMicro({ kind: "stacked", root, branch, index }, deferredRow.flagsBk);
      debug.log(
        ["splice", "defer"],
        `[defer] ${deferredRow.cardId} → root ${root} branch=${branch} index=${index}`,
        1,
      );
      this.ctx.data.setLocalCard(deferredRow.cardId, {
        ...deferredRow,
        macroZone: rootRow?.macroZone ?? deferredRow.macroZone,
        ...placed,
      });
      return;
    }

    // ---- Tier 2: owner inventory ----------------------------------
    const soul = owningSoul(this.ctx, deferredRow.cardId);
    if (soul) {
      const placed = applyMicro(
        { kind: "loose", localQ: 0, localR: 0, x: 0, y: 0, looseKind: looseKindForSurface(INVENTORY_LAYER) },
        deferredRow.flagsBk,
      );
      debug.log(["splice", "defer"], `[defer] ${deferredRow.cardId} → soul ${soul.soulCardId} inventory`, 1);
      this.ctx.data.setLocalCard(deferredRow.cardId, {
        ...deferredRow,
        macroZone: makeMacroZone(soul.soulCardId, INVENTORY_LAYER, 0, 0),
        ...placed,
      });
      return;
    }

    // ---- Tier 3: fail-to-loose at the deferred row's own cell ------
    const placed = applyMicro(
      { kind: "loose", localQ: 0, localR: 0, x: 0, y: 0, looseKind: looseKindForSurface(deferredRow.macroZone.surface) },
      deferredRow.flagsBk,
    );
    debug.log(["splice", "defer"], `[defer] ${deferredRow.cardId} no host — fail-to-loose`, 1);
    this.ctx.data.setLocalCard(deferredRow.cardId, { ...deferredRow, ...placed });
  }


  /**
   * Stack card `aId` onto card `bId` in the given direction.
   *
   * Invariant guarded here: A's chain (the dragged card and its descendants)
   * must be uniform in `direction` after the operation, so the resulting
   * chain rooted at A — which becomes a sub-chain of B's chain — doesn't
   * have mixed top/bottom links. Three cases on A:
   *
   *   1. A has both top AND bottom children → reject. There's no consistent
   *      single direction we could flip A's chain to without losing one
   *      side, so we refuse the stack.
   *
   *   2. A has children in the *opposite* direction → flip A's entire chain
   *      to match `direction`. Each card stays stacked on the same parent;
   *      only its flag bits flip (top↔bottom) and the titlebar swaps. B is
   *      unconstrained — if B already has its opposite slot occupied, A's
   *      chain simply attaches in the requested slot and B ends up with a
   *      "Y" of children, which is allowed.
   *
   *   3. A has children in the requested direction (or no children) → no
   *      flip needed; A's chain comes along uniformly.
   *
   * After flip (if any), walks B's chain in `direction` to find the leaf
   * and stacks A there. The walk validates each pointer against current
   * data and repairs stale pointers in place — `Card.setPosition` does the
   * data write and back-pointer plumbing flows through onDataChange.
   */
  stack(aId: number, bId: number, direction: StackDirection): void {
    if (!this.cards.get(aId) || !this.cards.get(bId)) return;
    const bRoot = this.rootOf(bId);
    if (bRoot === aId) return; // can't stack a root onto its own member

    // Collect A's members (if A is a root) BEFORE moving A — once A becomes a
    // member of B's root, they must re-root too (flat chains don't nest).
    // Preserve their order by current index so the visual chain stays stable.
    const aMembers = [
      ...this.buildChain(aId, STACK_DIR_UP),
      ...this.buildChain(aId, STACK_DIR_DOWN),
      ...this.buildChain(aId, STACK_DIR_HEX),
    ].map((c) => c.cardId);

    // A becomes a member of B's chain in `direction` (next free index).
    this.setCardPosition(aId, { kind: "stacked", parentId: bId, direction });
    // Its former members follow into the same branch (append-to-end).
    for (const childId of aMembers) {
      this.setCardPosition(childId, { kind: "stacked", parentId: bId, direction });
    }
  }

  /**
   * Build a client-side position update for `cardId`. The row is read from
   * the data store, the position fields are replaced. The actual write-back
   * is currently a no-op while the new architecture's outbound path is
   * still being wired — a reducer call (e.g. `ctx.reducers.setMicroLocation`)
   * will replace `setClientCard` here. Until that lands, position changes
   * built here don't propagate.
   */
  setCardPosition(cardId: number, state: CardPositionState): void {
    const row = this.ctx.data.cardsLocal.get(cardId);
    if (!row) return;
    const clampOffset = (v: number) => Math.max(-2048, Math.min(2047, Math.round(v)));
    let macroZone = row.macroZone;
    let micro: Micro;
    if (state.kind === "loose") {
      // Loose in the current container at within-cell offset (x, y). Inventory
      // is a rect-cell grid now; cell (0, 0) + offset is the single-bucket case.
      micro = {
        kind: "loose",
        localQ: 0,
        localR: 0,
        x: clampOffset(state.x),
        y: clampOffset(state.y),
        looseKind: looseKindForSurface(row.macroZone.surface),
      };
    } else if (state.kind === "inventory") {
      // Move to the bucket `(soulCardId, surface)`. `ownerId` is independent of
      // position and stays untouched.
      macroZone = makeMacroZone(state.soulCardId, state.surface ?? INVENTORY_LAYER, 0, 0);
      micro = {
        kind: "loose",
        localQ: 0,
        localR: 0,
        x: clampOffset(state.x),
        y: clampOffset(state.y),
        looseKind: looseKindForSurface(state.surface ?? INVENTORY_LAYER),
      };
    } else if (state.kind === "cell") {
      // Stay in the current container, snap to rect-grid cell (q, r) with no
      // within-cell offset. Inventory one-card-per-cell occupancy.
      micro = {
        kind: "loose",
        localQ: state.q,
        localR: state.r,
        x: 0,
        y: 0,
        looseKind: looseKindForSurface(row.macroZone.surface),
      };
    } else if (state.kind === "stacked") {
      // Flat-root: become a member of the parent's chain ROOT in `direction`,
      // claiming the next free index. The card inherits the root's macroZone.
      const root = this.rootOf(state.parentId);
      const rootRow = this.ctx.data.cardsLocal.get(root);
      macroZone = rootRow?.macroZone ?? row.macroZone;
      const branch = branchForDirection(state.direction);
      micro = { kind: "stacked", root, branch, index: this.nextBranchIndex(root, branch) };
    } else {
      // Viewport cell drop at `(q, r)`: cell within the chunk + optional
      // within-cell `(offsetX, offsetY)` offset (in pixels, i12 storage —
      // ±2047). Owner from the viewport — `0` for the world, a soul/anchor
      // `card_id` for an inventory / mini-zone bucket. The renderer applies
      // the offset iff the card's `looseKind` is `LOOSE_*` (0/1); for SNAP
      // kinds the renderer ignores it, so storing 0/0 is the norm there.
      // `looseKind` itself comes from `looseKindForSurface(surface)`.
      const zoneQ = Math.floor(state.q / ZONE_SIZE) * ZONE_SIZE;
      const zoneR = Math.floor(state.r / ZONE_SIZE) * ZONE_SIZE;
      macroZone = makeMacroZone(state.owner ?? 0, state.surface ?? WORLD_LAYER, zoneQ, zoneR);
      micro = {
        kind: "loose",
        localQ: state.q - zoneQ,
        localR: state.r - zoneR,
        x: clampOffset(state.offsetX ?? 0),
        y: clampOffset(state.offsetY ?? 0),
        looseKind: looseKindForSurface(state.surface ?? WORLD_LAYER),
      };
    }
    const { microLocation, flagsBk } = applyMicro(micro, row.flagsBk);
    const newRow: CardRow = { ...row, macroZone, microLocation, flagsBk };
    // Local-only write: store the new row in DataManager's local overlay.
    // The server tier (`data.cards.server` / `data.cards.current`) is left
    // untouched — pixel placement in inventory is a client concern.
    // `setLocalCard` fires the local-cards subscribers, so the matching
    // `Card.onDataChange` runs and applies the row to both halves
    // (gameCard + layoutCard). It also marks the key as overridden so
    // subsequent server pushes don't clobber the position fields (see
    // `mirrorCard`).
    this.ctx.data.setLocalCard(cardId, newRow);
  }

  get(cardId: number): Card | undefined {
    return this.cards.get(cardId);
  }

  size(): number {
    return this.cards.size;
  }

  /** Snapshot iterator of cards currently in the given zone. */
  *cardsInZone(zoneId: ZoneId): Generator<Card> {
    const bucket = this.byZone.get(zoneId);
    if (bucket) yield* bucket;
  }

  /**
   * Per-zone delivery. Listener fires `("added", card)` when a card enters
   * the zone (spawned-into or moved-into) and `("removed", card)` when it
   * leaves (destroyed or moved-out). No snapshot of existing cards on
   * subscribe — call `cardsInZone(zoneId)` for an initial scan.
   */
  subscribe(zoneId: ZoneId, listener: CardListener): () => void {
    return this.addListener(this.listeners, zoneId, listener);
  }

  /**
   * Per-zone delivery of stack-change events. Listener receives the root id
   * of an affected chain in the requested zone. `Card.onDataChange` fires
   * here when its parent or stack-direction changes — once for the old
   * chain's root (if applicable), once for the new chain's root (deduped if
   * they're the same). Loose-to-loose moves do NOT fire — those aren't
   * stack changes.
   *
   * Subscribers should walk the chain from `rootId` themselves to discover
   * the cards in it. Chains are uniform-direction by invariant, so walking
   * `stackedTop` xor `stackedBottom` from root finds every card in O(depth).
   */
  subscribeStackChange(zoneId: ZoneId, listener: StackChangeListener): () => void {
    return this.addListener(this.stackListeners, zoneId, listener);
  }

  subscribeAllStackChanges(listener: StackChangeListener): () => void {
    this.globalStackListeners.add(listener);
    return () => this.globalStackListeners.delete(listener);
  }

  /**
   * Fire stack-change listeners for the chain rooted at `rootId`. Called
   * by `Card.onDataChange` after a parent/direction transition. Determines
   * the zone from the root card's current zoneId; listeners registered for
   * that zone hear the event.
   */
  fireStackChange(rootId: number): void {
    if (this.splicing.has(rootId)) return;
    const root = this.cards.get(rootId);
    if (!root) return;
    const zoneId = root.zoneId();
    const set = this.stackListeners.get(zoneId);
    if (set) {
      for (const listener of set) {
        try {
          listener(rootId);
        } catch (err) {
          console.error("[CardManager] stack-change listener threw", err);
        }
      }
    }
    for (const listener of this.globalStackListeners) {
      try {
        listener(rootId);
      } catch (err) {
        console.error("[CardManager] stack-change listener threw", err);
      }
    }
  }

  /**
   * Resolve the loose root of `cardId`'s chain. Mixed-mode walker:
   *
   * - `STACKED_LOOSE`: the card IS the root.
   * - `STACKED_ON_ROOT`: one-hop — `microLocation` is the chain root.
   *   Falls back to `cardId` if the named root isn't in the overlay
   *   (broken chain).
   * - `STACKED_SLOT`: walk up via `microLocation` parent-pointers.
   *   The immediate parent could be another `Slot` (continue walking),
   *   an `OnRoot` (one more hop lands on the root), or a `Free` card
   *   (the root itself).
   *
   * `STACKED_DEFERRED` (state 3) is transient — `mirrorCard`
   * converts it to state 1/2 before any chain walker sees it. If one
   * slips through via a subscription gap, the `microLocation` field
   * is the host_id (anchor for future resolution), NOT a chain
   * parent — we treat it as no-parent so the walker stops cleanly
   * rather than wandering into the host's chain.
   *
   * Bounded by `FIND_ROOT_MAX_DEPTH` against pathological cycles.
   */
  rootOf(cardId: number): number {
    const row = this.ctx.data.cardsLocal.get(cardId);
    if (!row) return cardId;
    // Flat-root: a loose card IS the root; a stack member's `microLocation` is
    // its root (one hop). A still-deferred member's `microLocation` is the host
    // anchor, not a chain root — `mirrorCard` resolves it first, so treat it as
    // its own root if one slips through. The root must exist in the registry;
    // fall back to the card itself otherwise (broken chain).
    if (!microIsCard(row.flagsBk)) return cardId;
    if (stackBranch(row.flagsBk) === STACK_STATE_DEFERRED) return cardId;
    return this.cards.get(row.microLocation) ? row.microLocation : cardId;
  }

  /**
   * Build the chain rooted at `rootId` in the given direction, returning
   * cards in visual chain order (closest to root first, outward).
   *
   * Direct children of `rootId` are enumerated — any card whose
   * `microLocation === rootId`. For each, the chain index is:
   *   - `STACKED_ON_ROOT` (state 2): reads the `position` field, and
   *     filters by `getStackDirection` matching the requested direction.
   *     Hex mounts (direction = `STACK_DIRECTION_HEX`) also flow through
   *     this branch — they're `OnRoot + direction=HEX + position=1` under
   *     the unified card model.
   *   - `STACKED_SLOT` (state 1): chain index 1, filtered by direction.
   *
   * Direct children sort by chain index ascending. For each direct
   * child in order, push to the result and recursively append its
   * state-1 sub-chain (cards whose `microLocation === thisCard`, state
   * `SLOT`, direction matches — walking parent-pointer style until a
   * leaf).
   *
   * `STACKED_DEFERRED` (state 3) is resolved by `mirrorCard` before
   * any chain walker sees it; if one slips through via a subscription
   * gap, it's not part of the chain yet and is skipped (`continue`).
   *
   * Use this for any "what cards are in the chain in order" question.
   * The back-pointer cache (`stackedTop` / `stackedBottom`) is not
   * reliable for mixed chains because state-2's position-1-sibling
   * lookup filters out state-1 cards and falls back to the chain root,
   * causing R's cache slot to be overwritten by the wrong child.
   */
  buildChain(rootId: number, direction: number): Card[] {
    // Flat-root: members of `rootId` in `direction` are every card whose
    // `microLocation === rootId`, `micro_is_card` set, and `stackState ==
    // direction`. Order is `stackIndex` ascending (closest to root first).
    const direct: { card: Card; idx: number }[] = [];
    for (const [id, row] of this.ctx.data.cardsLocal) {
      if (row.microLocation !== rootId || !microIsCard(row.flagsBk)) continue;
      if (stackBranch(row.flagsBk) !== direction) continue;
      const card = this.cards.get(id);
      if (!card) continue;
      direct.push({ card, idx: stackIndex(row.flagsBk) });
    }
    direct.sort((a, b) => a.idx - b.idx);
    return direct.map((d) => d.card);
  }

  /**
   * Split a chain (as returned by `buildChain`) into runs of contiguous
   * unheld cards. Held cards are dropped; runs are preserved in chain
   * order.
   *
   * Returns `{ firstSubChain, subsequentSubChains }`:
   * - `firstSubChain` is non-null only when `chain[0]` is unheld — i.e.
   *   chain index 1 is R-adjacent and not in a held block. This is the
   *   sub-chain that gets the rootless-retry treatment in
   *   `ActionManager.evaluateRoot`.
   * - `subsequentSubChains` is every other run of unheld cards in
   *   visual order.
   *
   * `isHeld` is supplied by the caller so the function stays
   * recipe-agnostic — pass any predicate (server `slot_hold`, in-pass
   * holds added during a match-loop, etc.).
   */
  splitChainByHeld(
    chain: Card[],
    isHeld: (card: Card) => boolean,
  ): { firstSubChain: Card[] | null; subsequentSubChains: Card[][] } {
    const firstStartsUnheld = chain.length > 0 && !isHeld(chain[0]);
    const runs: Card[][] = [];
    let current: Card[] = [];
    for (const card of chain) {
      if (isHeld(card)) {
        if (current.length > 0) {
          runs.push(current);
          current = [];
        }
      } else {
        current.push(card);
      }
    }
    if (current.length > 0) runs.push(current);

    if (firstStartsUnheld && runs.length > 0) {
      const [first, ...rest] = runs;
      return { firstSubChain: first, subsequentSubChains: rest };
    }
    return { firstSubChain: null, subsequentSubChains: runs };
  }

  /**
   * Re-route a Card between zone buckets. Called by `Card` itself when its
   * data update changes `(macroZone, layer)`. Same Card instance preserved —
   * no destroy/respawn, gameCard / renderCard state survives.
   */
  move(cardId: number, oldZoneId: ZoneId, newZoneId: ZoneId): void {
    if (oldZoneId === newZoneId) return;
    const card = this.cards.get(cardId);
    if (!card) return;
    this.removeFromZone(oldZoneId, card);
    this.addToZone(newZoneId, card);
  }

  dispose(): void {
    this.unsubscribe();
    for (const card of this.cards.values()) card.destroy();
    this.cards.clear();
    this.byZone.clear();
    this.listeners.clear();
    this.stackListeners.clear();
  }

  private spawn(cardId: number): void {
    if (this.cards.has(cardId)) return;
    // Tile-cards (card_type == 7) are rendered by LayoutWorld via
    // `tileViewAt` + the centre-object pipeline at hex-tile size and
    // position, not as standalone hex cards. Skipping them here
    // prevents a double render — small `HexCard` instance with its
    // own 72-radius geometry on top of the existing 96-radius zone
    // tile. See `docs/TILE_AS_CARD.md`. Tile-cards' data is still
    // queryable directly via `cardsLocal.get(card_id)` (DetailsPanel,
    // ActionManager, the recipe matcher all read it that way).
    const row = this.ctx.data.cardsLocal.get(cardId);
    if (row) {
      const cardType = (row.packedDefinition >> 12) & 0xf;
      if (cardType === TILE_CARD_TYPE) return;
    }
    const card = Card.create(cardId, this.ctx, this);
    if (!card) return;
    this.cards.set(cardId, card);
    this.addToZone(card.zoneId(), card);
  }

  private destroy(cardId: number): void {
    const card = this.cards.get(cardId);
    if (!card) return;
    // Capture the chain root BEFORE removing the card from the
    // registry — `rootOf` walks `cardsLocal.microLocation`, which
    // still carries the dying card's parent pointer at this moment,
    // so the result is the same as the user-visible chain the card
    // belonged to right up to this destruction.
    const rootId = this.rootOf(cardId);
    this.removeFromZone(card.zoneId(), card);
    card.destroy();
    this.cards.delete(cardId);
    // Notify anyone watching the chain (ActionManager) that the
    // chain has changed. Without this, a non-root child dying with
    // `dead=2` leaves listeners stuck on the pre-destroy chain
    // until something else triggers a recheck — e.g. after a splice
    // the post-splice chain {root, surviving siblings} matches a
    // new recipe (stick after corpus_b.2 splice), but no event
    // reaches ActionManager so the recipe doesn't queue until the
    // next unrelated mutation. Skip when the destroyed card IS the
    // root — the `dead=1`/`dead=2` row update already routes through
    // `subscribeLocalCard` for the root itself, and `evaluateRoot`
    // sees the dead flag and drops the queue there.
    if (rootId !== cardId) {
      this.fireStackChange(rootId);
    }
  }

  private addToZone(zoneId: ZoneId, card: Card): void {
    let bucket = this.byZone.get(zoneId);
    if (!bucket) {
      bucket = new Set();
      this.byZone.set(zoneId, bucket);
    }
    bucket.add(card);
    this.fireZone(zoneId, "added", card);
  }

  private removeFromZone(zoneId: ZoneId, card: Card): void {
    const bucket = this.byZone.get(zoneId);
    if (bucket) {
      bucket.delete(card);
      if (bucket.size === 0) this.byZone.delete(zoneId);
    }
    this.fireZone(zoneId, "removed", card);
  }

  private addListener<L>(
    map: Map<ZoneId, Set<L>>,
    zoneId: ZoneId,
    listener: L,
  ): () => void {
    let set = map.get(zoneId);
    if (!set) {
      set = new Set();
      map.set(zoneId, set);
    }
    set.add(listener);
    return () => {
      const s = map.get(zoneId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) map.delete(zoneId);
    };
  }

  /** Re-attach each Card's Pixi container to its true parent when
   *  the constructor's `fallbackToInventory` left it dangling.
   *  Called once after the initial spawn pass + `repairBackPointers`,
   *  when every Card is guaranteed to be in the registry — the
   *  earlier reason a child fell back was its parent hadn't spawned
   *  yet, which can't be true anymore.
   *
   *  Each Card's `repairParenting` is a no-op unless its row says
   *  it should be chained AND it isn't currently chained to the
   *  right parent. Steady-state spawns (post-init) don't hit this
   *  race in practice, so the pass only ever does real work on
   *  scene entry. */
  private repairParenting(): void {
    for (const card of this.cards.values()) {
      card.repairParenting();
    }
  }

  private fireZone(zoneId: ZoneId, kind: CardChangeKind, card: Card): void {
    const set = this.listeners.get(zoneId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(kind, card);
      } catch (err) {
        console.error("[CardManager] zone listener threw", err);
      }
    }
  }
}
