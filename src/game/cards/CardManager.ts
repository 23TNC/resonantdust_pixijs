import { debug } from "../../debug";
import type { GameContext } from "../../GameContext";
import type { Card as CardRow } from "../../server/spacetime/bindings/types";
import {
  packMacroZone,
  packMicroZone,
  packSlotMicroZone,
  packStackMicroZone,
  WORLD_LAYER,
  ZONE_SIZE,
  type ZoneId,
} from "../../server/data/packing";
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
  setStackedState,
  STACK_DIRECTION_DOWN,
  STACK_DIRECTION_UP,
  STACKED_LOOSE,
  STACKED_ON_HEX,
  STACKED_ON_ROOT,
  STACKED_SLOT,
} from "./cardData";
// World helpers (packMacroZone, unpackMacroZone, WORLD_LAYER, ZONE_SIZE) live
// in `server/data/packing` — re-import there when world tier is restored.

export type CardChangeKind = "added" | "removed";
export type CardListener = (kind: CardChangeKind, card: Card) => void;
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
   * `STACKED_ON_HEX` (state 3) was retired in the unified card model
   * — hex cards now sit as state-2 children of their hex root. The
   * legacy constant lingers in TS for drag-drop world-tile rendering
   * until Phase 10.4 migrates it; splice no longer has a state-3
   * branch.
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
      `[splice] enter card=${cardId} state=${state} microZone=0x${row.microZone.toString(16)} microLocation=${row.microLocation} macroZone=${row.macroZone} surface=${row.surface} stackedTop=${card.stackedTop} stackedBottom=${card.stackedBottom} stackedHex=${card.stackedHex}`,
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
          `[splice]   promote ${newRootId} to world-loose on dying tile (macroZone=${D_row.macroZone} microZone=0x${newMicroZone.toString(16)})`,
          2,
        );
        this.ctx.data.setLocalCard(newRootId, {
          ...inheritorRow,
          surface:       D_row.surface,
          macroZone:     D_row.macroZone,
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
        macroZone:     D_row.macroZone,
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
          macroZone:     D_row.macroZone,
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
          macroZone:     D_row.macroZone,
          surface:       D_row.surface,
          microZone:     packSlotMicroZone(oppDir),
          microLocation: dyingRoot,
        });
      }
    }
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
      // Under the post-flag-20 card-owner model, the inventory
      // bucket address is the soul's card_id. For cards already in
      // inventory, `row.ownerId` IS the soul's card_id (the pun
      // preserves). For cards coming from the world (`ownerId = 0`)
      // we fall back to the active soul (`SoulManager.getSoulId()`)
      // so the drop lands in the player's currently-controlled soul's
      // inventory rather than at `macroZone = 0`. Also re-stamp
      // `ownerId` so future drags from this row resolve consistently.
      const inventoryBucket = row.ownerId !== 0
        ? row.ownerId
        : (this.ctx.souls.getSoulId() ?? 0);
      newRow = {
        ...row,
        ownerId: inventoryBucket,
        macroZone: inventoryBucket,
        surface: 1,
        microLocation: encodeLooseXY(state.x, state.y),
        microZone: clearStackedState(row.microZone),
      };
    } else if (state.kind === "stacked") {
      const parentRow = this.ctx.data.cardsLocal.get(state.parentId);
      if (state.direction === "hex") {
        // Hex chains keep the legacy parent-pointer model.
        newRow = {
          ...row,
          macroZone:     parentRow?.macroZone ?? row.macroZone,
          surface:       parentRow?.surface   ?? row.surface,
          microLocation: state.parentId,
          microZone:     setStackedState(row.microZone, STACKED_ON_HEX),
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
          macroZone:     parentRow?.macroZone ?? row.macroZone,
          surface:       parentRow?.surface   ?? row.surface,
          microLocation: state.parentId,
          microZone:     packSlotMicroZone(direction),
        };
      }
    } else {
      // World drop. The dropped card lands at world hex (q, r) on the
      // world surface. Always state-3 (STACKED_ON_HEX) — even when no
      // hex card actually exists at that tile, the rect card lives "on
      // the hex tile" rather than being loose at a pixel coordinate.
      //
      //   surface       = WORLD_LAYER.
      //   macro_zone    = packed (zoneQ, zoneR) where (zoneQ, zoneR) is
      //                   the floor-to-ZONE_SIZE origin containing (q, r).
      //   micro_zone    = packed (localQ, localR, STACKED_ON_HEX) where
      //                   (localQ, localR) = (q - zoneQ, r - zoneR).
      //   micro_location = card_id of the hex card at this tile if one
      //                   exists in cardsLocal, else 0.
      //
      // `RectCard.applyData`'s STACKED_ON_HEX branch handles both
      // micro_location cases (parent hex card → mount on its hexMount;
      // micro_location == 0 → position from macro_zone + micro_zone
      // bit-fields). When micro_location is 0, downstream code that
      // needs the hex tile's definition (recipe matching, etc.) reads
      // it from the `zones` table — the tile def is encoded in the
      // zone row's `t0..t7` packed columns even when no Card row
      // exists at that tile.
      const zoneQ = Math.floor(state.q / ZONE_SIZE) * ZONE_SIZE;
      const zoneR = Math.floor(state.r / ZONE_SIZE) * ZONE_SIZE;
      const localQ = state.q - zoneQ;
      const localR = state.r - zoneR;
      const newMacroZone = packMacroZone(zoneQ, zoneR);
      const newMicroZone = packMicroZone(localQ, localR, STACKED_ON_HEX);

      // Find the hex card (if any) sitting at this tile. Search is
      // O(cardsLocal.size) but fine — hex cards on a world surface
      // are scarce relative to inventory cards, and this fires once
      // per drop.
      let hexParentId = 0;
      for (const [id, r] of this.ctx.data.cardsLocal) {
        if (id === cardId) continue;
        if (r.surface !== WORLD_LAYER) continue;
        if (r.macroZone !== newMacroZone) continue;
        const otherLocalQ = (r.microZone >> 5) & 0x7;
        const otherLocalR = (r.microZone >> 2) & 0x7;
        if (otherLocalQ !== localQ || otherLocalR !== localR) continue;
        const other = this.cards.get(id);
        if (!other) continue;
        if (!(other.gameCard instanceof GameHexCard)) continue;
        hexParentId = id;
        break;
      }

      newRow = {
        ...row,
        surface:       WORLD_LAYER,
        macroZone:     newMacroZone,
        microZone:     newMicroZone,
        microLocation: hexParentId,
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
   *   The immediate parent could be another `Slot` (continue
   *   walking), an `OnRoot` (then one more hop to the root), a
   *   `Free` card (the root itself), or `OnHex` (continue the hex
   *   walk).
   * - `STACKED_ON_HEX`: same parent-pointer walk shape, hex semantics.
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
      // STACKED_SLOT or STACKED_ON_HEX: hop to immediate parent and
      // continue the walk. Slot parents may themselves be slots,
      // OnRoot, Free, or OnHex; the loop dispatches per state.
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
   * Handles all three child states uniformly:
   *
   * 1. Direct children of `rootId` are enumerated — any card whose
   *    `microLocation === rootId`. For each, the chain index is:
   *    - `STACKED_ON_ROOT` (state 2): reads the `position` field, and
   *      filters by `getStackDirection` matching the requested direction.
   *    - `STACKED_SLOT` (state 1): chain index 1, filtered by
   *      direction.
   *    - `STACKED_ON_HEX` (state 3): chain index 1, NO direction
   *      filter — a rect mounted on a hex root has no per-direction
   *      semantics and is the first chain member for both up- and
   *      down-walks. State-3's microZone bit 2 is part of the legacy
   *      localR field, not a direction bit, so reading it as direction
   *      would give nonsense.
   * 2. Direct children sort by chain index ascending.
   * 3. For each direct child in order, push to the result and
   *    recursively append its state-1 sub-chain (cards whose
   *    `microLocation === thisCard`, state `SLOT`, direction matches —
   *    walking parent-pointer style until a leaf).
   *
   * The result is the visual chain: every member from `rootId` outward,
   * regardless of how state-1 islands, state-2 chunks, and state-3
   * mounts interleave. Sparse state-2 positions appear as gaps in chain
   * index space — the matcher treats them like any other chain (recipes
   * that need contiguity won't match across gaps).
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
      if (state === STACKED_ON_HEX) {
        // Rect mounted on a hex root. The mount has no direction of
        // its own — the mounted rect is the first chain member for
        // BOTH up- and down-walks off this root. State-3's microZone
        // bit 2 is part of the legacy localR field, not a direction
        // bit, so we don't filter it. The recursion below picks up
        // only state-1 children of the mount in the requested
        // direction.
        chainIdx = 1;
      } else if (state === STACKED_ON_ROOT) {
        if (getStackDirection(row.microZone) !== direction) continue;
        chainIdx = getStackPosition(row.microZone);
      } else if (state === STACKED_SLOT) {
        if (getStackDirection(row.microZone) !== direction) continue;
        chainIdx = 1; // state-1 directly on root sits at chain index 1
      } else {
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
    const card = Card.create(cardId, this.ctx, this);
    if (!card) return;
    this.cards.set(cardId, card);
    this.addToZone(card.zoneId(), card);
  }

  private destroy(cardId: number): void {
    const card = this.cards.get(cardId);
    if (!card) return;
    this.removeFromZone(card.zoneId(), card);
    card.destroy();
    this.cards.delete(cardId);
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
      if (
        state !== STACKED_ON_ROOT &&
        state !== STACKED_ON_HEX &&
        state !== STACKED_SLOT
      ) {
        continue;
      }
      // Resolve immediate parent + direction:
      //  - STACKED_ON_HEX: microLocation IS the parent (hex card).
      //  - STACKED_SLOT:   microLocation IS the immediate parent
      //                    (server-written parent-pointer chain).
      //  - STACKED_ON_ROOT: the immediate parent is the chain member
      //                    at position-1 in the same direction (or
      //                    the chain root if position == 1).
      let parentId: number;
      let direction = STACK_DIRECTION_UP;
      if (state === STACKED_ON_HEX) {
        parentId = row.microLocation;
      } else if (state === STACKED_SLOT) {
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
      if (state === STACKED_ON_HEX) {
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
