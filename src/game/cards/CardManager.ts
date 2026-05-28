import { debug } from "../../debug";
import type { GameContext } from "../../GameContext";
import type { Card as CardRow } from "../../server/spacetime/bindings/types";
import {
  macroFields,
  INVENTORY_LAYER,
  packMicroZone,
  packSlotMicroZone,
  packStackMicroZone,
  unpackMicroZone,
  WORLD_LAYER,
  ZONE_SIZE,
  type ZoneId,
} from "../../server/data/packing";
import { owningSoul } from "../permissions";
import { Card, type CardPositionState, type StackDirection } from "./Card";
import { GameHexCard } from "./layout/hexagon/HexCard";
import { RECT_CARD_TITLE_HEIGHT } from "./layout/rectangle/RectCard";
import {
  clearStackedState,
  decodeLooseXY,
  encodeLooseXY,
  getStackDirection,
  getStackedState,
  getStackPosition,
  MAX_CHAIN_DEPTH,
  setStackedState,
  STACK_DIRECTION_DOWN,
  STACK_DIRECTION_HEX,
  STACK_DIRECTION_UP,
  STACKED_DEFERRED,
  STACKED_LOOSE,
  STACKED_ON_ROOT,
  STACKED_SLOT,
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
  | { kind: "loose"; surface: number; macroZone: number; q: number; r: number }
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
    // Spawn order is arbitrary so a child may have spawned before its
    // parent and missed setting its back-pointer. Repair once now that
    // every card is in the registry.
    this.repairBackPointers();
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
    const state = getStackedState(row.microZone);

    debug.log(
      ["splice"],
      `[splice] enter card=${cardId} state=${state} microZone=0x${row.microZone.toString(16)} microLocation=${row.microLocation} macro=${JSON.stringify(row.macro)} surface=${row.surface} stackedTop=${card.stackedTop} stackedBottom=${card.stackedBottom} stackedHex=${card.stackedHex}`,
      1,
    );

    if (state === STACKED_LOOSE) {
      this.spliceLooseRoot(cardId, row);
    } else if (state === STACKED_SLOT) {
      this.spliceSlotMember(cardId, row);
    } else if (state === STACKED_ON_ROOT) {
      this.spliceOnRootMember(cardId, row);
    }

    card.stackedTop = 0;
    card.stackedBottom = 0;
    card.stackedHex = 0;
    this.splicing.delete(cardId);
    debug.log(["splice"], `[splice] exit card=${cardId}`, 1);
  }

  /** State-0 LOOSE root dying. The chain it anchored loses its
   *  anchor — promote the first card in the visual chain (UP wins,
   *  else DOWN) to be the new loose root, re-stack the rest under it,
   *  and pull the other-direction chain in too as the new root's
   *  opposite-side stack.
   *
   *  Uses `buildChain` for chain order so state-2 server-stitched
   *  cards and state-1 client-stacked cards interleave correctly. The
   *  resulting re-stack writes everything as state-1 SLOT (client
   *  ownership), which is correct: the server's chain context died
   *  with the root. */
  private spliceLooseRoot(D_id: number, D_row: CardRow): void {
    const topChain = this.buildChain(D_id, STACK_DIRECTION_UP).map((c) => c.cardId);
    const bottomChain = this.buildChain(D_id, STACK_DIRECTION_DOWN).map((c) => c.cardId);
    const onWorld = D_row.surface >= WORLD_LAYER;

    debug.log(
      ["splice"],
      `[splice] LOOSE D=${D_id} surface=${D_row.surface} top=[${topChain.join(",")}] bottom=[${bottomChain.join(",")}]`,
      1,
    );

    // Pick the primary direction — whichever has cards. Top wins on tie.
    let primaryChain: number[];
    let secondaryChain: number[];
    let primaryDir: "top" | "bottom";
    if (topChain.length > 0) {
      primaryChain = topChain;
      secondaryChain = bottomChain;
      primaryDir = "top";
    } else if (bottomChain.length > 0) {
      primaryChain = bottomChain;
      secondaryChain = topChain;
      primaryDir = "bottom";
    } else {
      return;
    }

    // Promote the first card of the primary chain. Two shapes:
    //
    //   - Inventory: write loose at the dying card's xy with a one-
    //     title-bar offset so the chain doesn't visually collapse.
    //   - World: the dying card's position is encoded in
    //     `macroZone + microZone` (hex address), and `microLocation`
    //     is 0. The inheritor takes the same tile by copying those
    //     fields verbatim, with the state cleared to Free. No xy
    //     offset — the chain on a world tile shares the tile.
    const newRootId = primaryChain[0];
    if (onWorld) {
      const inheritorRow = this.ctx.data.cardsLocal.get(newRootId);
      if (inheritorRow !== undefined) {
        const newMicroZone = clearStackedState(D_row.microZone);
        debug.log(
          ["splice"],
          `[splice]   promote ${newRootId} to world-loose on dying tile (macro=${JSON.stringify(D_row.macro)} microZone=0x${newMicroZone.toString(16)})`,
          2,
        );
        this.ctx.data.setLocalCard(newRootId, {
          ...inheritorRow,
          surface:       D_row.surface,
          ...macroFields(D_row.macro),
          microZone:     newMicroZone,
          microLocation: 0,
        });
      }
    } else {
      const { x, y } = decodeLooseXY(D_row.microLocation);
      const dy = primaryDir === "top" ? -RECT_CARD_TITLE_HEIGHT : RECT_CARD_TITLE_HEIGHT;
      debug.log(["splice"], `[splice]   promote ${newRootId} to inventory-loose at (${x},${y + dy})`, 2);
      this.setCardPosition(newRootId, { kind: "loose", x, y: y + dy });
    }

    let parent = newRootId;
    for (let i = 1; i < primaryChain.length; i++) {
      debug.log(["splice"], `[splice]   re-stack ${primaryChain[i]} onto ${parent} dir=${primaryDir}`, 2);
      this.setCardPosition(primaryChain[i], { kind: "stacked", parentId: parent, direction: primaryDir });
      parent = primaryChain[i];
    }

    // Re-stack the secondary direction chain under the new root.
    const secondaryDir: "top" | "bottom" = primaryDir === "top" ? "bottom" : "top";
    let parent2 = newRootId;
    for (const id of secondaryChain) {
      debug.log(["splice"], `[splice]   re-stack ${id} onto ${parent2} dir=${secondaryDir}`, 2);
      this.setCardPosition(id, { kind: "stacked", parentId: parent2, direction: secondaryDir });
      parent2 = id;
    }
  }

  /** State-1 SLOT member dying. Each immediate state-1 child
   *  re-parents to the dying card's parent (`D.microLocation`),
   *  keeping its own direction. Transitive grandchildren stay in
   *  place — their `microLocation` references the just-re-parented
   *  child, which still exists. */
  private spliceSlotMember(D_id: number, D_row: CardRow): void {
    const parentId = D_row.microLocation;
    debug.log(["splice"], `[splice] SLOT D=${D_id} → parent=${parentId}`, 1);
    for (const dir of [STACK_DIRECTION_UP, STACK_DIRECTION_DOWN]) {
      const childId = this.findSlotChild(D_id, dir);
      if (childId === 0) continue;
      const childRow = this.ctx.data.cardsLocal.get(childId);
      if (!childRow) continue;
      debug.log(["splice"], `[splice]   reparent ${childId} (dir=${dir}) → ${parentId}`, 2);
      this.ctx.data.setLocalCard(childId, {
        ...childRow,
        ...macroFields(D_row.macro),
        surface:       D_row.surface,
        microZone:     packSlotMicroZone(dir),
        microLocation: parentId,
      });
    }
  }

  /** State-2 ON_ROOT member dying. Two repair shapes:
   *
   *  - If a state-1 child exists in the dying direction, that child
   *    inherits the dying card's state-2 row exactly (root, pos,
   *    direction). The slot is filled; state-2 successors above stay
   *    at their original positions.
   *  - Otherwise state-2 successors above the gap renumber down by
   *    one to close it.
   *
   *  Opposite-direction state-1 children of D re-parent to the chain
   *  root with their own direction preserved. */
  private spliceOnRootMember(D_id: number, D_row: CardRow): void {
    const dyingPos = getStackPosition(D_row.microZone);
    const dyingDir = getStackDirection(D_row.microZone);
    const dyingRoot = D_row.microLocation;
    const oppDir = dyingDir === STACK_DIRECTION_UP ? STACK_DIRECTION_DOWN : STACK_DIRECTION_UP;

    const sameDirChild = this.findSlotChild(D_id, dyingDir);
    const oppDirChild = this.findSlotChild(D_id, oppDir);

    debug.log(
      ["splice"],
      `[splice] ON_ROOT D=${D_id} pos=${dyingPos} dir=${dyingDir} root=${dyingRoot} sameDirChild=${sameDirChild} oppDirChild=${oppDirChild}`,
      1,
    );

    if (sameDirChild !== 0) {
      // Same-direction child fills the state-2 slot. State-2 above
      // stays put — slot is occupied.
      const childRow = this.ctx.data.cardsLocal.get(sameDirChild);
      if (childRow) {
        debug.log(["splice"], `[splice]   ${sameDirChild} inherits D's state-2 slot pos=${dyingPos}`, 2);
        this.ctx.data.setLocalCard(sameDirChild, {
          ...childRow,
          ...macroFields(D_row.macro),
          surface:       D_row.surface,
          microZone:     D_row.microZone,
          microLocation: dyingRoot,
        });
      }
    } else {
      this.renumberOnRootSuccessors(dyingRoot, dyingDir, dyingPos);
    }

    if (oppDirChild !== 0) {
      // Opposite-direction child re-parents to the chain root with
      // its own direction preserved. Note: if dyingRoot already has
      // a state-1 child in `oppDir`, this creates two — the chain
      // walk in `buildChain` will pick one arbitrarily. Recipes don't
      // emit opposite-direction state-1 children today, so this is a
      // rare data shape; documenting the corner rather than handling
      // it here.
      const childRow = this.ctx.data.cardsLocal.get(oppDirChild);
      if (childRow) {
        debug.log(["splice"], `[splice]   reparent opp ${oppDirChild} (dir=${oppDir}) → ${dyingRoot}`, 2);
        this.ctx.data.setLocalCard(oppDirChild, {
          ...childRow,
          ...macroFields(D_row.macro),
          surface:       D_row.surface,
          microZone:     packSlotMicroZone(oppDir),
          microLocation: dyingRoot,
        });
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

  /** Public wrapper around [`findSlotChild`] that returns the
   *  occupant's row rather than its id. Used by `DataManager.mirrorCard`
   *  to detect whether an incoming `pos_need` / `pos_want` row's slot
   *  is already held by a different card (the splice trigger). */
  findSlotOccupant(parentId: number, direction: number): CardRow | null {
    const id = this.findSlotChild(parentId, direction);
    if (id === 0) return null;
    return this.ctx.data.cardsLocal.get(id) ?? null;
  }

  /** Find the immediate state-1 child of `parentId` in `direction`,
   *  or `0` if none. There's at most one per direction by invariant
   *  (a card has at most one state-1 child per side); if multiple
   *  rows match, returns the first encountered. */
  private findSlotChild(parentId: number, direction: number): number {
    for (const [id, r] of this.ctx.data.cardsLocal) {
      if (r.microLocation !== parentId) continue;
      if (getStackedState(r.microZone) !== STACKED_SLOT) continue;
      if (getStackDirection(r.microZone) !== direction) continue;
      return id;
    }
    return 0;
  }

  /** Decrement positions of every state-2 sibling at pos > `pivotPos`
   *  in the same `direction` under `rootId`. Closes the gap left by
   *  a state-2 splice when no state-1 child filled the slot. */
  private renumberOnRootSuccessors(rootId: number, direction: number, pivotPos: number): void {
    const successors: { id: number; oldPos: number }[] = [];
    for (const [id, r] of this.ctx.data.cardsLocal) {
      if (r.microLocation !== rootId) continue;
      if (getStackedState(r.microZone) !== STACKED_ON_ROOT) continue;
      if (getStackDirection(r.microZone) !== direction) continue;
      const pos = getStackPosition(r.microZone);
      if (pos > pivotPos) successors.push({ id, oldPos: pos });
    }
    successors.sort((a, b) => a.oldPos - b.oldPos);
    for (const { id, oldPos } of successors) {
      const r = this.ctx.data.cardsLocal.get(id);
      if (!r) continue;
      const newPos = oldPos - 1;
      debug.log(["splice"], `[splice]   renumber ${id}: pos ${oldPos} → ${newPos}`, 2);
      this.ctx.data.setLocalCard(id, {
        ...r,
        microZone: packStackMicroZone(newPos, direction, STACKED_ON_ROOT),
      });
    }
  }

  // ---- splice-into-chain primitive (pos_need / pos_want) -----------------
  //
  // The two existing splice helpers above (`spliceSlotMember`,
  // `spliceOnRootMember`) handle the *remove-and-rejoin* case for cards
  // dying out of a chain. The primitive below handles the inverse —
  // *insert-and-displace* — when a server row carrying `pos_need` or
  // `pos_want` arrives at a slot already occupied by a locally-loaded
  // card. Used exclusively from the state-1 SLOT branch in `mirrorCard`;
  // state-2 ON_ROOT conflicts continue to flow through
  // `renumberAfterForcedStackPosition` (which already implements the
  // "incoming wins, push the rest up by +1" semantics that match
  // `pos_need` for state-2 chains; state-2 `pos_want` is future work
  // when a recipe actually opts into it).

  /** Splice `incoming` into the state-1 chain alongside `target`,
   *  parameterized by who keeps the existing slot pointer:
   *
   *  - `nAbove === false` (**pos_need**): incoming lands at the
   *    server-specified slot exactly. `target` re-anchors above
   *    incoming (its `microLocation` flips from the original parent
   *    to `incoming.cardId`); whatever was above `target` in the
   *    chain is unaffected (still points at `target` by id).
   *
   *  - `nAbove === true` (**pos_want**): incoming stacks above
   *    `target`. Incoming's row is rewritten so its `microLocation`
   *    points at `target` (overriding the server's preferred
   *    position); whatever was previously above `target` re-anchors
   *    above incoming.
   *
   *  **Write discipline**: this function writes only the *partner*
   *  card (`target` for need, `existingAbove` for want) via
   *  [`setLocalCard`]. The incoming card's row is returned via
   *  `incomingRow` so the caller can fold it into its own single
   *  authoritative write (`mirrorCard` builds the local row with
   *  progress / def / dead extras attached; pre-writing incoming
   *  here would be clobbered a moment later).
   *
   *  Both cases grow the chain by exactly one card. When the
   *  resulting chain exceeds [`MAX_CHAIN_DEPTH`], `overflowTop`
   *  carries the topmost card's row so the caller can run it
   *  through [`evictCard`] (Phase 4); chains that fit return
   *  `overflowTop: null`. The chain stays correctly linked under
   *  eviction because the topmost has no children to re-anchor —
   *  eviction just rewrites its row out of the chain. */
  insertIntoSlotChain(
    incoming: CardRow,
    target: CardRow,
    nAbove: boolean,
  ): { incomingRow: CardRow; overflowTop: CardRow | null } {
    const direction = getStackDirection(target.microZone);
    let incomingRow: CardRow;
    if (nAbove) {
      // Want: incoming stacks above target. Find whatever was above
      // target first — re-anchor it above incoming after the write.
      // If nothing was above, the splice is a clean append.
      const existingAbove = this.findSlotChild(target.cardId, direction);
      incomingRow = {
        ...incoming,
        surface:       target.surface,
        ...macroFields(target.macro),
        microZone:     packSlotMicroZone(direction),
        microLocation: target.cardId,
      };
      if (existingAbove !== 0) {
        const childRow = this.ctx.data.cardsLocal.get(existingAbove);
        if (childRow) {
          this.ctx.data.setLocalCard(existingAbove, {
            ...childRow,
            microLocation: incoming.cardId,
          });
        }
      }
    } else {
      // Need: incoming lands at server's exact position; target gets
      // pushed up. Incoming inherits target's parent + slot
      // direction verbatim (this is what the server told us); target
      // re-anchors above incoming keeping the same direction.
      incomingRow = incoming;
      this.ctx.data.setLocalCard(target.cardId, {
        ...target,
        microZone:     packSlotMicroZone(direction),
        microLocation: incoming.cardId,
      });
    }
    return {
      incomingRow,
      overflowTop: this.findOverflowTop(target, direction),
    };
  }

  /** Walk the chain rooted under `anchor` upward in `direction`,
   *  counting cards. Returns the topmost card row when the chain
   *  exceeds [`MAX_CHAIN_DEPTH`]; otherwise `null`. The walk starts
   *  from `anchor` (any chain member works — we walk *down* via
   *  `microLocation` first to find the chain root, then *up* via
   *  `findSlotChild` to count). Cycle-safe via a visited set; aborts
   *  past `MAX_CHAIN_DEPTH * 2` steps as a paranoia cap. */
  private findOverflowTop(anchor: CardRow, direction: number): CardRow | null {
    // Walk down to the chain root (STACKED_LOOSE).
    let rootId = anchor.cardId;
    let depth = 0;
    while (depth < MAX_CHAIN_DEPTH * 2) {
      const row = this.ctx.data.cardsLocal.get(rootId);
      if (!row) break;
      const state = getStackedState(row.microZone);
      if (state !== STACKED_SLOT) break;
      if (row.microLocation === 0 || row.microLocation === rootId) break;
      rootId = row.microLocation;
      depth += 1;
    }
    // Now walk up from root counting and tracking the topmost.
    const seen = new Set<number>([rootId]);
    let topRow: CardRow | null = null;
    let chainLen = 1; // root counts
    let cursor = rootId;
    while (chainLen <= MAX_CHAIN_DEPTH * 2) {
      const childId = this.findSlotChild(cursor, direction);
      if (childId === 0) break;
      if (seen.has(childId)) break; // cycle guard
      seen.add(childId);
      const childRow = this.ctx.data.cardsLocal.get(childId);
      if (!childRow) break;
      chainLen += 1;
      topRow = childRow;
      cursor = childId;
    }
    return chainLen > MAX_CHAIN_DEPTH ? topRow : null;
  }

  /** Three-tier eviction cascade for chain-overflow displacement.
   *  Public so [`mirrorCard`] in `DataManager` can invoke it when
   *  a `pos_need` / `pos_want` splice grows the chain past
   *  [`MAX_CHAIN_DEPTH`]; the topmost card returned by
   *  [`insertIntoSlotChain`] is fed in here and re-homed via the
   *  first successful tier:
   *
   *  1. **Owning soul's inventory.** Walk the card's owner chain
   *     via [`owningSoul`] to a soul; if found, rewrite to
   *     `(INVENTORY_LAYER, soulCardId, STACKED_LOOSE-at-(0,0))`.
   *     The receiving InventoryGame's `clampToSurface` picks the
   *     next free grid slot on its layout pass — same path the
   *     orphan-slot recovery branch in `mirrorCard` already uses.
   *
   *  2. **Loose on the chain root's tile.** When no owning soul
   *     exists (world-owned chain), drop the card as
   *     `STACKED_LOOSE` at the chain root's tile coords with a
   *     small XY offset so it doesn't perfectly overlap the root
   *     visually. World-surface loose cards are first-class
   *     (dropped items, souls).
   *
   *  3. **Worst-case no-op.** If neither (1) nor (2) applies (chain
   *     root missing from the local overlay, or it's on an inventory
   *     surface with no owning soul — a data shape that shouldn't
   *     occur in real play), log and leave the card at its prior
   *     position. The next server reconciliation will fix things up. */
  evictCard(card: CardRow): void {
    const soul = owningSoul(this.ctx, card.cardId);
    if (soul) {
      debug.log(
        ["splice", "evict"],
        `[evict] ${card.cardId} → soul ${soul.soulCardId} inventory`,
        1,
      );
      this.ctx.data.setLocalCard(card.cardId, {
        ...card,
        surface:       INVENTORY_LAYER,
        ...macroFields({ kind: "container", id: soul.soulCardId }),
        microZone:     card.microZone & ~0x3, // state → STACKED_LOOSE
        microLocation: 0,                      // encodeLooseXY(0, 0) === 0
      });
      return;
    }
    const rootRow = this.chainRootRow(card);
    if (rootRow && rootRow.surface >= WORLD_LAYER) {
      const { localQ, localR } = unpackMicroZone(rootRow.microZone);
      debug.log(
        ["splice", "evict"],
        `[evict] ${card.cardId} → loose at root ${rootRow.cardId}'s tile (${localQ}, ${localR})`,
        1,
      );
      this.ctx.data.setLocalCard(card.cardId, {
        ...card,
        surface:       rootRow.surface,
        ...macroFields(rootRow.macro),
        microZone:     packMicroZone(localQ, localR, STACKED_LOOSE),
        microLocation: encodeLooseXY(8, 8),
      });
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
    const { localQ: fallbackQ, localR: fallbackR } = unpackMicroZone(deferredRow.microZone);

    // ---- Tier 1: leaf-append on host's chain ----------------------
    if (hostId !== 0) {
      const host = this.ctx.data.cardsLocal.get(hostId);
      if (host) {
        const leaf = this.findChainLeafFor(host);
        if (leaf) {
          const target: PlacementTarget = {
            kind: "stack-leaf",
            parentId: leaf.cardId,
            direction: leaf.direction,
          };
          if (this.canPlaceCardAt(deferredRow, target)) {
            debug.log(
              ["splice", "defer"],
              `[defer] ${deferredRow.cardId} → leaf ${leaf.cardId} dir=${leaf.direction}`,
              1,
            );
            this.ctx.data.setLocalCard(deferredRow.cardId, {
              ...deferredRow,
              surface:       host.surface,
              ...macroFields(host.macro),
              microZone:     packSlotMicroZone(leaf.direction),
              microLocation: leaf.cardId,
            });
            return;
          }
        }
      }
    }

    // ---- Tier 2: loose at fallback (q, r) -------------------------
    const looseTarget: PlacementTarget = {
      kind: "loose",
      surface: deferredRow.surface,
      macroZone: deferredRow.macroZone,
      q: fallbackQ,
      r: fallbackR,
    };
    if (this.canPlaceCardAt(deferredRow, looseTarget)) {
      debug.log(
        ["splice", "defer"],
        `[defer] ${deferredRow.cardId} → loose at fallback (${fallbackQ}, ${fallbackR})`,
        1,
      );
      this.ctx.data.setLocalCard(deferredRow.cardId, {
        ...deferredRow,
        microZone:     packMicroZone(fallbackQ, fallbackR, STACKED_LOOSE),
        microLocation: encodeLooseXY(0, 0),
      });
      return;
    }

    // ---- Tier 3: owner inventory ----------------------------------
    const soul = owningSoul(this.ctx, deferredRow.cardId);
    if (soul) {
      const invTarget: PlacementTarget = { kind: "inventory", soulId: soul.soulCardId };
      if (this.canPlaceCardAt(deferredRow, invTarget)) {
        debug.log(
          ["splice", "defer"],
          `[defer] ${deferredRow.cardId} → soul ${soul.soulCardId} inventory`,
          1,
        );
        this.ctx.data.setLocalCard(deferredRow.cardId, {
          ...deferredRow,
          surface:       INVENTORY_LAYER,
          ...macroFields({ kind: "container", id: soul.soulCardId }),
          microZone:     packMicroZone(0, 0, STACKED_LOOSE),
          microLocation: 0,
        });
        return;
      }
    }

    // ---- Tier 4: spiral-search free (q, r) in macroZone -----------
    const spiralHit = this.findFreeTileInMacroZone(
      deferredRow,
      deferredRow.surface,
      deferredRow.macroZone,
      fallbackQ,
      fallbackR,
    );
    if (spiralHit) {
      debug.log(
        ["splice", "defer"],
        `[defer] ${deferredRow.cardId} → spiral (${spiralHit.q}, ${spiralHit.r}) in macroZone`,
        1,
      );
      this.ctx.data.setLocalCard(deferredRow.cardId, {
        ...deferredRow,
        microZone:     packMicroZone(spiralHit.q, spiralHit.r, STACKED_LOOSE),
        microLocation: encodeLooseXY(0, 0),
      });
      return;
    }

    // ---- Tier 5: worst-case — loose at fallback, no probe ---------
    debug.log(
      ["splice", "defer"],
      `[defer] ${deferredRow.cardId} no acceptable target — worst-case loose at fallback (${fallbackQ}, ${fallbackR})`,
      1,
    );
    this.ctx.data.setLocalCard(deferredRow.cardId, {
      ...deferredRow,
      microZone:     packMicroZone(fallbackQ, fallbackR, STACKED_LOOSE),
      microLocation: encodeLooseXY(0, 0),
    });
  }

  /** Find the chain leaf for `host` — walk down to the chain root,
   *  identify growth direction, walk back up to the leaf. Returns
   *  `{ cardId, direction }` for the leaf (which may be the host
   *  itself if the chain is a single card). Returns `null` only on
   *  malformed chain (cycle, missing parent past the depth cap).
   *
   *  Growth direction inference: count children of root in each
   *  direction. Top child present → Top; Bottom present → Bottom;
   *  both → Top (consistent default, matches inventory convention);
   *  neither → Top (host is solo; new card lands as the first Top
   *  child). The "try Top then Bottom" cascade only matters when the
   *  probe rejects Top — the caller re-runs with a different
   *  preferred direction.
   *
   *  For Phase 3 this returns the Top-preferred outcome only. The
   *  Top-then-Bottom fallback fires from the cascade tier above when
   *  the probe rejects, not from this method. */
  private findChainLeafFor(host: CardRow): { cardId: number; direction: number } | null {
    // Walk down to root via microLocation parent chain.
    let rootId = host.cardId;
    for (let i = 0; i < MAX_CHAIN_DEPTH * 2; i++) {
      const row = this.ctx.data.cardsLocal.get(rootId);
      if (!row) return null;
      const state = getStackedState(row.microZone);
      if (state !== STACKED_SLOT) break;
      if (row.microLocation === 0 || row.microLocation === rootId) break;
      rootId = row.microLocation;
    }

    // Pick direction from root's children.
    const hasTop = this.findSlotChild(rootId, STACK_DIRECTION_UP) !== 0;
    const hasBottom = this.findSlotChild(rootId, STACK_DIRECTION_DOWN) !== 0;
    const direction = hasTop || !hasBottom ? STACK_DIRECTION_UP : STACK_DIRECTION_DOWN;

    // Walk up to leaf in chosen direction.
    let cursor = rootId;
    const seen = new Set<number>([rootId]);
    for (let i = 0; i < MAX_CHAIN_DEPTH * 2; i++) {
      const child = this.findSlotChild(cursor, direction);
      if (child === 0 || seen.has(child)) break;
      seen.add(child);
      cursor = child;
    }
    return { cardId: cursor, direction };
  }

  /** Tier-4 spiral search. Scan candidate (q, r) tiles within the
   *  same `(surface, macroZone)` starting from `(startQ, startR)`
   *  and walking outward in axial-hex distance. Returns the first
   *  candidate the probe accepts, or `null` if the search exhausts
   *  the radius cap without a hit. The radius cap is small (4) —
   *  this tier is meant for "very close to intended" recovery, not
   *  arbitrary placement; if no slot fits within radius 4, the
   *  worst-case tier handles it. */
  private findFreeTileInMacroZone(
    card: CardRow,
    surface: number,
    macroZone: number,
    startQ: number,
    startR: number,
  ): { q: number; r: number } | null {
    const RADIUS = 4;
    // Spiral via axial-hex distance ordering. Brute-force scan a small
    // box and filter by hex distance; cheap because the search area
    // is bounded (~50 candidates).
    type Cand = { q: number; r: number; dist: number };
    const cands: Cand[] = [];
    for (let dq = -RADIUS; dq <= RADIUS; dq++) {
      for (let dr = -RADIUS; dr <= RADIUS; dr++) {
        const dist = (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
        if (dist === 0 || dist > RADIUS) continue;
        const q = startQ + dq;
        const r = startR + dr;
        // Skip out-of-range zone-local coords (legacy layout: 3 bits each, 0..7).
        if (q < 0 || q > 7 || r < 0 || r > 7) continue;
        cands.push({ q, r, dist });
      }
    }
    cands.sort((a, b) => a.dist - b.dist);
    for (const c of cands) {
      const target: PlacementTarget = {
        kind: "loose",
        surface,
        macroZone,
        q: c.q,
        r: c.r,
      };
      if (this.canPlaceCardAt(card, target)) {
        return { q: c.q, r: c.r };
      }
    }
    return null;
  }

  /** Walk down from `start` via `microLocation` until reaching a
   *  non-`STACKED_SLOT` card (the chain root, typically
   *  `STACKED_LOOSE` on a tile or `STACKED_ON_ROOT` on inventory).
   *  Returns the row, or `null` if the walk falls off the local
   *  overlay or trips the depth cap (cycle / malformation). Used
   *  by [`evictCard`] to find the chain root's tile coords for the
   *  loose-on-tile fallback tier. */
  private chainRootRow(start: CardRow): CardRow | null {
    let cur: CardRow = start;
    for (let i = 0; i < 32; i++) {
      if (getStackedState(cur.microZone) !== STACKED_SLOT) return cur;
      const parent = this.ctx.data.cardsLocal.get(cur.microLocation);
      if (!parent || parent === cur) return cur;
      cur = parent;
    }
    return null;
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
    const a = this.cards.get(aId);
    if (!a) return;
    if (!this.cards.get(bId)) return;

    const oppositeDir: StackDirection = direction === "top" ? "bottom" : "top";
    const aRequestedSlot = this.slot(aId, direction);
    const aOppositeSlot = this.slot(aId, oppositeDir);

    if (aRequestedSlot !== 0 && aOppositeSlot !== 0) return;

    if (aRequestedSlot === 0 && aOppositeSlot !== 0) {
      this.flipChain(aId, oppositeDir, direction);
    }

    let leafId = bId;
    while (true) {
      const leaf = this.cards.get(leafId);
      if (!leaf) return;
      // Self-stack check: if A is already in B's chain at this slot,
      // the stack is a no-op and we'd loop infinitely otherwise.
      const raw = direction === "top" ? leaf.stackedTop : leaf.stackedBottom;
      if (raw === aId) break;
      const next = this.slot(leafId, direction);
      if (next === 0) break;
      leafId = next;
    }

    // Collect A's chain in `direction` BEFORE moving A — once A's row
    // changes, A's children still point at A as root (microLocation = aId)
    // so they're discoverable by walking the back-pointer cache from A.
    // After A's microLocation flips to B's root, the children's chain-
    // root reference is stale; we re-stack each one onto its predecessor
    // so `setCardPosition` re-computes its (root_id, position) from the
    // freshly-written predecessor row.
    const aChain: number[] = [];
    {
      let cursor = aId;
      while (true) {
        const next = this.slot(cursor, direction);
        if (next === 0) break;
        aChain.push(next);
        cursor = next;
      }
    }

    this.setCardPosition(aId, { kind: "stacked", parentId: leafId, direction });

    let parentForChild = aId;
    for (const childId of aChain) {
      this.setCardPosition(childId, { kind: "stacked", parentId: parentForChild, direction });
      parentForChild = childId;
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
    let newRow: CardRow;
    if (state.kind === "loose") {
      newRow = {
        ...row,
        microLocation: encodeLooseXY(state.x, state.y),
        microZone: clearStackedState(row.microZone),
      };
    } else if (state.kind === "inventory") {
      // Inventory bucket address: `(macro_zone = soulCardId,
      // surface = state.surface ?? INVENTORY_LAYER)`. For player
      // inventory pass `surface = PLAYER_INVENTORY_LAYER` and
      // `soulCardId = player_id`. `ownerId` is independent of
      // position and stays untouched — only an explicit ownership-
      // transfer reducer (TBD) changes who owns the card.
      newRow = {
        ...row,
        ...macroFields({ kind: "container", id: state.soulCardId }),
        surface: state.surface ?? 1,
        microLocation: encodeLooseXY(state.x, state.y),
        microZone: clearStackedState(row.microZone),
      };
    } else if (state.kind === "stacked") {
      const parentRow = this.ctx.data.cardsLocal.get(state.parentId);
      if (state.direction === "hex") {
        // Hex-mount: dragged card becomes the parent's first
        // hex-direction child. Server convention is
        // `OnRoot + direction=HEX + position=1` with
        // `micro_location = parent.card_id`. State 3 is now
        // `STACKED_DEFERRED` (anchored deferred placement) and is
        // emitted only by recipe outputs like `stack.N.create`, not
        // by drag-drop — so writing it from this drag path would
        // mis-signal "deferred resolution" to the mirror.
        // The first-child case is the only one this branch needs to
        // handle for now; chain extension beyond a single hex-mounted
        // card isn't a drop UI today.
        newRow = {
          ...row,
          ...macroFields(parentRow?.macro ?? row.macro),
          surface:       parentRow?.surface   ?? row.surface,
          microLocation: state.parentId,
          microZone:     packStackMicroZone(1, STACK_DIRECTION_HEX, STACKED_ON_ROOT),
        };
      } else {
        // Rect chains use the parent-pointer (state-1 / Slot) model
        // for client writes: `microLocation` is the IMMEDIATE parent's
        // card_id; `microZone` carries direction only (no position
        // field). The server still writes state-2 (`OnRoot`) rows
        // from `propose_action` for rooted-recipe actor pinning, and
        // those continue to work — `buildChain` enumerates both
        // states uniformly.
        //
        // The reason we prefer state-1 here: when the user drags a
        // chain member off, only the dragged card's row updates.
        // Cards above keep their `microLocation` reference. Under
        // state-2 those references all point to the chain root R,
        // so the cards above stay logically in R's chain even though
        // their visual is following the dragged card (Pixi parent
        // hierarchy). The matcher then mis-reports a recipe as
        // matching cards that visually live in two separate stacks.
        // Under state-1, `microLocation` references the immediate
        // predecessor, so the chain-above-the-drag follows the
        // dragged card both visually AND in data.
        const direction =
          state.direction === "top" ? STACK_DIRECTION_UP : STACK_DIRECTION_DOWN;
        newRow = {
          ...row,
          ...macroFields(parentRow?.macro ?? row.macro),
          surface:       parentRow?.surface   ?? row.surface,
          microLocation: state.parentId,
          microZone:     packSlotMicroZone(direction),
        };
      }
    } else {
      // World drop. The dropped card lands at world hex (q, r) on the
      // world surface as `Free` (state 0). State 3 is now
      // `STACKED_DEFERRED` (anchored deferred placement emitted by
      // recipe outputs); writing it from a drag path would mis-signal
      // "resolve me at mirror time." We match the server's
      // `resolve_loose_target` shape directly:
      //
      //   surface       = WORLD_LAYER.
      //   macro_zone    = packed (zoneQ, zoneR) where (zoneQ, zoneR) is
      //                   the floor-to-ZONE_SIZE origin containing (q, r).
      //   micro_zone    = packed (localQ, localR, STACKED_LOOSE) where
      //                   (localQ, localR) = (q - zoneQ, r - zoneR).
      //   micro_location = 0 (Free cards on world don't track a
      //                   parent pointer).
      //
      // Hex tile-cards at the same hex are NOT auto-stitched here —
      // re-parenting an existing tile under the new rect is the
      // server's responsibility on the next propose-action (via
      // `chain_stitch`). The local overlay just lays the new rect
      // Free at the hex; the server's reply will land any chain
      // adjustments.
      const zoneQ = Math.floor(state.q / ZONE_SIZE) * ZONE_SIZE;
      const zoneR = Math.floor(state.r / ZONE_SIZE) * ZONE_SIZE;
      const localQ = state.q - zoneQ;
      const localR = state.r - zoneR;
      const newMicroZone = packMicroZone(localQ, localR, STACKED_LOOSE);

      newRow = {
        ...row,
        // World / mini-zone / any hex-grid surface — caller supplies
        // the surface in the state. Defaults to `WORLD_LAYER` for
        // back-compat.
        surface:       state.surface ?? WORLD_LAYER,
        ...macroFields({ kind: "world", q: zoneQ, r: zoneR }),
        microZone:     newMicroZone,
        microLocation: 0,
      };
    }
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
    let id = cardId;
    for (let i = 0; i < FIND_ROOT_MAX_DEPTH; i++) {
      const row = this.ctx.data.cardsLocal.get(id);
      if (!row) return id;
      const state = getStackedState(row.microZone);
      if (state === STACKED_LOOSE) return id;
      if (state === STACKED_ON_ROOT) {
        return this.cards.get(row.microLocation) ? row.microLocation : id;
      }
      if (state === STACKED_DEFERRED) {
        // Deferred row's `microLocation` is the host anchor for
        // resolution, not a chain parent. Mirror should've resolved
        // this before chain walking sees it; if it didn't (gap),
        // stop the walk here rather than wandering into the host's
        // chain.
        return id;
      }
      // STACKED_SLOT — hop to immediate parent and continue the walk.
      const parentId = row.microLocation;
      if (!this.cards.get(parentId)) return id;
      id = parentId;
    }
    return id;
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
    const direct: { card: Card; chainIdx: number }[] = [];
    for (const [id, row] of this.ctx.data.cardsLocal) {
      if (row.microLocation !== rootId) continue;
      const state = getStackedState(row.microZone);

      let chainIdx: number;
      if (state === STACKED_ON_ROOT) {
        if (getStackDirection(row.microZone) !== direction) continue;
        chainIdx = getStackPosition(row.microZone);
      } else if (state === STACKED_SLOT) {
        if (getStackDirection(row.microZone) !== direction) continue;
        chainIdx = 1; // state-1 directly on root sits at chain index 1
      } else {
        // STACKED_LOOSE (0) — not a child of this root.
        // STACKED_DEFERRED (3) — transient row that mirror should've
        // resolved; skip if a subscription gap let one through.
        continue;
      }

      const card = this.cards.get(id);
      if (!card) continue;
      direct.push({ card, chainIdx });
    }
    direct.sort((a, b) => a.chainIdx - b.chainIdx);

    const result: Card[] = [];
    for (const { card } of direct) {
      result.push(card);
      this.appendSlotSubChain(card.cardId, direction, result);
    }
    return result;
  }

  /** Walk the state-1 chain anchored at `parentId` in `direction`,
   *  appending each card to `out`. At most one state-1 child per
   *  direction per parent (chain is a single line), so a simple loop
   *  suffices. Bounded by `FIND_ROOT_MAX_DEPTH` against malformed data. */
  private appendSlotSubChain(parentId: number, direction: number, out: Card[]): void {
    let currentParent = parentId;
    for (let depth = 0; depth < FIND_ROOT_MAX_DEPTH; depth++) {
      let next: Card | null = null;
      for (const [id, row] of this.ctx.data.cardsLocal) {
        if (row.microLocation !== currentParent) continue;
        if (getStackedState(row.microZone) !== STACKED_SLOT) continue;
        if (getStackDirection(row.microZone) !== direction) continue;
        const card = this.cards.get(id);
        if (!card) continue;
        next = card;
        break;
      }
      if (!next) return;
      out.push(next);
      currentParent = next.cardId;
    }
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

  /**
   * Read the immediate child stacked on `parentId` in `direction`, or 0
   * if the cache says none. The back-pointer cache is maintained from
   * data by `Card.onDataChange` (via `Card.stackParentOf` which resolves
   * to the immediate parent under the stack layout), so a direct read
   * is trustworthy — no validation/repair pass needed.
   */
  private slot(parentId: number, direction: StackDirection): number {
    const parent = this.cards.get(parentId);
    if (!parent) return 0;
    if (direction === "top") return parent.stackedTop;
    if (direction === "bottom") return parent.stackedBottom;
    return parent.stackedHex;
  }

  /**
   * Walks the chain rooted at `rootId` in `fromDir` and rewrites every
   * link to `toDir`. Each chain member's `stackedState` bits flip; the
   * `position` field is rebuilt from 1..N in walk order so position 1
   * stays adjacent to root after the flip.
   *
   * Collects ids first via the back-pointer cache so each setCardPosition
   * sees a coherent pre-flip view. Each write fires onDataChange and
   * shuffles the cache; by loop end the chain is uniform in `toDir`.
   */
  private flipChain(
    rootId: number,
    fromDir: StackDirection,
    toDir: StackDirection,
  ): void {
    const chain: number[] = [];
    let currentId = rootId;
    while (true) {
      const childId = this.slot(currentId, fromDir);
      if (childId === 0) break;
      chain.push(childId);
      currentId = childId;
    }
    // Walk the collected chain in order and re-stack each one onto its
    // predecessor in `toDir`. setCardPosition recomputes the position
    // field from the parent's row, so positions naturally renumber 1..N.
    let parentId = rootId;
    for (const id of chain) {
      this.setCardPosition(id, {
        kind: "stacked",
        parentId,
        direction: toDir,
      });
      parentId = id;
    }
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

  /** Rebuild back-pointer cache from data. Called once after the
   *  initial spawn pass — spawn order is arbitrary, so a child may have
   *  spawned before its parent and missed the immediate-parent's
   *  `Card.stackedTop` setter. After every chain mutation, individual
   *  `Card.onDataChange` runs maintain the cache incrementally; this
   *  pass is the start-of-life seed. */
  private repairBackPointers(): void {
    for (const card of this.cards.values()) {
      const row = this.ctx.data.cardsLocal.get(card.cardId);
      if (!row) continue;
      const state = getStackedState(row.microZone);
      // Only chain-member states feed back-pointers. State 3
      // (`STACKED_DEFERRED`) is transient — mirror resolution
      // converts it before this seed pass; even if one slipped
      // through, deferred rows have no chain identity (`microLocation`
      // is the resolution anchor, not a parent), so they don't
      // populate parent's stackedTop/Bottom/Hex.
      if (state !== STACKED_ON_ROOT && state !== STACKED_SLOT) {
        continue;
      }
      // Resolve immediate parent + direction:
      //  - STACKED_SLOT:   microLocation IS the immediate parent
      //                    (server-written parent-pointer chain).
      //  - STACKED_ON_ROOT: the immediate parent is the chain member
      //                    at position-1 in the same direction (or
      //                    the chain root if position == 1).
      let parentId: number;
      let direction = STACK_DIRECTION_UP;
      if (state === STACKED_SLOT) {
        parentId = row.microLocation;
        direction = getStackDirection(row.microZone);
      } else {
        direction = getStackDirection(row.microZone);
        const position = getStackPosition(row.microZone);
        if (position <= 1) {
          parentId = row.microLocation;
        } else {
          parentId = 0;
          for (const [otherId, otherRow] of this.ctx.data.cardsLocal) {
            if (otherRow.microLocation !== row.microLocation) continue;
            if (getStackedState(otherRow.microZone) !== STACKED_ON_ROOT) continue;
            if (getStackDirection(otherRow.microZone) !== direction) continue;
            if (getStackPosition(otherRow.microZone) === position - 1) {
              parentId = otherId;
              break;
            }
          }
          if (parentId === 0) parentId = row.microLocation;
        }
      }
      const parent = this.cards.get(parentId);
      if (!parent) continue;
      if (direction === STACK_DIRECTION_HEX) {
        parent.stackedHex = card.cardId;
      } else if (direction === STACK_DIRECTION_UP) {
        parent.stackedTop = card.cardId;
      } else {
        parent.stackedBottom = card.cardId;
      }
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
