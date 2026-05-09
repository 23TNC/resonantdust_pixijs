import { debug } from "../../debug";
import type { GameContext } from "../../GameContext";
import type { Card as CardRow } from "../../server/spacetime/bindings/types";
import {
  packSlotMicroZone,
  packStackMicroZone,
  type ZoneId,
} from "../../server/data/packing";
import { Card, type CardPositionState, type StackDirection } from "./Card";
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
    this.unsubscribe = ctx.data.subscribeLocalCard((change) => {
      if (change.kind === "added") this.spawn(change.key);
      else if (change.kind === "removed") this.destroy(change.key);
      // "updated" — same id, position/flag bits changed. Cards subscribe
      // to their own key for data changes; CardManager only cares about
      // spawn/destroy transitions.
    });
  }

  /**
   * Remove `cardId` from its chain, bridging the gap it leaves behind.
   *
   * Splicing is a CLIENT-side concern. The server has no view of the
   * client's board layout and can't resolve chain repair on our behalf
   * — when a card is removed we are responsible for keeping survivors
   * in a coherent state.
   *
   * - **State 0 (loose root):** the heaviest re-root case. State-2
   *   chain members get re-rooted onto a promoted survivor; hex child
   *   gets re-anchored to the dying card's hex (or loose XY); any
   *   state-1 descendants get force-released to owner inventory.
   * - **State 2 (mid-chain on root):** position-renumber every
   *   surviving state-2 sibling past the gap (same direction only),
   *   then force-release any state-1 descendants of the dying card.
   * - **State 3 (on hex):** top child takes the dying card's hex slot;
   *   bottom child re-stacks onto that new top; hex child re-anchors;
   *   state-1 descendants get force-released.
   * - **State 1 (slot):** the dying card was a server-written recipe
   *   slot. Server doesn't see the local chain, so it can't splice —
   *   we force-release every state-1 descendant back to owner
   *   inventory. Without this, state-1 survivors would point at a
   *   nonexistent parent and live forever as orphans.
   */
  spliceCard(cardId: number): void {
    const card = this.cards.get(cardId);
    if (!card) return;
    const row = this.ctx.data.cardsLocal.get(cardId);
    if (!row) return;

    this.splicing.add(cardId);
    const state = getStackedState(row.microZone);

    debug.log(
      ["splice"],
      `[splice] enter card=${cardId} state=${state} microZone=0x${row.microZone.toString(16)} microLocation=${row.microLocation} macroZone=${row.macroZone} surface=${row.surface} stackedTop=${card.stackedTop} stackedBottom=${card.stackedBottom} stackedHex=${card.stackedHex}`,
      1,
    );

    // World branches stripped — when world tier returns, route
    // `row.surface >= WORLD_LAYER` to a different release path here.

    if (state === STACKED_LOOSE) {
      // Loose root dying. Every chain member had `microLocation = cardId`
      // and now needs re-rooting under whichever survivor we promote.
      const { x, y } = decodeLooseXY(row.microLocation);
      const topMembers = this.collectChainMembers(cardId, STACK_DIRECTION_UP);
      const bottomMembers = this.collectChainMembers(cardId, STACK_DIRECTION_DOWN);
      const hexChildId = card.stackedHex;

      debug.log(
        ["splice"],
        `[splice] LOOSE branch xy=(${x},${y}) topMembers=[${topMembers.join(",")}] bottomMembers=[${bottomMembers.join(",")}] hexChildId=${hexChildId}`,
        1,
      );

      let newRootId = 0;
      if (topMembers.length > 0) {
        newRootId = topMembers[0];
        debug.log(["splice"], `[splice] promoting top[0]=${newRootId} to loose root at (${x},${y})`, 2);
        this.setCardPosition(newRootId, { kind: "loose", x, y });
        let parent = newRootId;
        for (let i = 1; i < topMembers.length; i++) {
          debug.log(["splice"], `[splice]   re-stack top[${i}]=${topMembers[i]} onto ${parent} dir=top`, 2);
          this.setCardPosition(topMembers[i], { kind: "stacked", parentId: parent, direction: "top" });
          parent = topMembers[i];
        }
      } else if (bottomMembers.length > 0) {
        newRootId = bottomMembers[0];
        debug.log(["splice"], `[splice] promoting bottom[0]=${newRootId} to loose root at (${x},${y})`, 2);
        this.setCardPosition(newRootId, { kind: "loose", x, y });
        let parent = newRootId;
        for (let i = 1; i < bottomMembers.length; i++) {
          debug.log(["splice"], `[splice]   re-stack bottom[${i}]=${bottomMembers[i]} onto ${parent} dir=bottom`, 2);
          this.setCardPosition(bottomMembers[i], { kind: "stacked", parentId: parent, direction: "bottom" });
          parent = bottomMembers[i];
        }
      }

      // If we used top members for the new root and there are also
      // bottom members, re-stack the bottom chain onto the new root
      // (each bottom member onto its predecessor, starting from the
      // new root).
      if (topMembers.length > 0 && bottomMembers.length > 0) {
        let parent = newRootId;
        for (const id of bottomMembers) {
          debug.log(["splice"], `[splice]   re-stack bottom=${id} under new top-root chain via ${parent}`, 2);
          this.setCardPosition(id, { kind: "stacked", parentId: parent, direction: "bottom" });
          parent = id;
        }
      }

      if (hexChildId !== 0) {
        const dest = this.releasedHexChildPosition(row);
        debug.log(["splice"], `[splice]   hex child=${hexChildId} -> ${dest ? JSON.stringify(dest) : "no dest"}`, 2);
        if (dest) this.setCardPosition(hexChildId, dest);
      }
      this.transplantSlotChildren(cardId, row);
    } else if (state === STACKED_ON_ROOT) {
      // Mid-chain death. `microLocation` is the chain root and stays put
      // for survivors; the only change is renumbering positions down by
      // 1 for every chain member past the gap (in the SAME direction —
      // top and bottom chains have independent position spaces under one
      // root). Detach the dying card first so it's not at any chain
      // position when we renumber, then walk surviving members in
      // ascending old-position order.
      const dyingPos = getStackPosition(row.microZone);
      const dyingDirection = getStackDirection(row.microZone);
      const dyingRoot = row.microLocation;
      const renumber: { id: number; oldPos: number }[] = [];
      for (const [id, r] of this.ctx.data.cardsLocal) {
        if (id === cardId) continue;
        if (r.microLocation !== dyingRoot) continue;
        if (getStackedState(r.microZone) !== STACKED_ON_ROOT) continue;
        if (getStackDirection(r.microZone) !== dyingDirection) continue;
        const pos = getStackPosition(r.microZone);
        if (pos > dyingPos) renumber.push({ id, oldPos: pos });
      }
      renumber.sort((a, b) => a.oldPos - b.oldPos);

      debug.log(
        ["splice"],
        `[splice] ON_ROOT branch dyingPos=${dyingPos} dyingDirection=${dyingDirection} dyingRoot=${dyingRoot} renumber=[${renumber.map((r) => `${r.id}@${r.oldPos}`).join(",")}]`,
        1,
      );

      // Order matters: transplant FIRST, then renumber.
      //
      // Transplant changes the dying card's state-1 child (if any) to
      // state-2 inheriting the dying card's microZone — i.e. it drops
      // a state-2 card at the dying card's old chain position. Once
      // that row exists in cardsLocal, any subsequent state-2 card
      // whose `stackParentOf` lookup runs ("find my state-2 sibling
      // at position N-1") will find the inheritor and reparent
      // correctly.
      //
      // If transplant ran AFTER the renumber, the renumbered cards'
      // onDataChange would fire while the inheritor was still state-1
      // (filtered out by the position-1-sibling lookup), fall back to
      // the chain root, and reparent to R's stackTopHost. The later
      // transplant fixes the inheritor's row but doesn't re-fire
      // onDataChange for the renumbered cards — they sit in R's
      // stackTopHost forever, overlapping whatever's already there.
      //
      // We do NOT detach the dying card to a loose 0,0 position. The
      // dying card's row already carries `dead === 2` (set by
      // `RectCard.layout` before calling spliceCard) and
      // `stackParentOf` filters those out, so it can't be picked up
      // as a position-1 sibling of any survivor. Letting it die in
      // place avoids `InventoryGame.tryPush` repositioning a card
      // that's about to vanish.
      this.transplantSlotChildren(cardId, row);
      for (const { id, oldPos } of renumber) {
        const r = this.ctx.data.cardsLocal.get(id);
        if (!r) continue;
        const newPos = getStackPosition(r.microZone) - 1;
        debug.log(["splice"], `[splice]   renumber ${id}: pos ${oldPos} -> ${newPos}`, 2);
        this.ctx.data.setLocalCard(id, {
          ...r,
          microZone: packStackMicroZone(newPos, dyingDirection, STACKED_ON_ROOT),
        });
      }
    } else if (state === STACKED_ON_HEX) {
      // Hex chains kept on the legacy parent-pointer model; the
      // back-pointer cache here is the source of truth.
      const hexId = row.microLocation;
      const topId = card.stackedTop;
      const bottomId = card.stackedBottom;
      const hexChildId = card.stackedHex;
      debug.log(
        ["splice"],
        `[splice] ON_HEX branch hexId=${hexId} topId=${topId} bottomId=${bottomId} hexChildId=${hexChildId}`,
        1,
      );
      if (topId !== 0) {
        debug.log(["splice"], `[splice]   re-anchor top=${topId} to hex=${hexId}`, 2);
        this.setCardPosition(topId, { kind: "stacked", parentId: hexId, direction: "hex" });
        if (bottomId !== 0) {
          debug.log(["splice"], `[splice]   re-stack bottom=${bottomId} below new top=${topId}`, 2);
          this.stack(bottomId, topId, "bottom");
        }
      } else if (bottomId !== 0) {
        debug.log(["splice"], `[splice]   re-anchor bottom=${bottomId} to hex=${hexId}`, 2);
        this.setCardPosition(bottomId, { kind: "stacked", parentId: hexId, direction: "hex" });
      }
      if (hexChildId !== 0) {
        const dest = this.releasedHexChildPosition(row);
        debug.log(["splice"], `[splice]   hex child=${hexChildId} -> ${dest ? JSON.stringify(dest) : "no dest"}`, 2);
        if (dest) this.setCardPosition(hexChildId, dest);
      }
      // Dying card is left in place; `dead === 2` prevents it from
      // being picked up as a chain sibling. See ON_ROOT branch.
      this.transplantSlotChildren(cardId, row);
    } else if (state === STACKED_SLOT) {
      debug.log(["splice"], `[splice] SLOT branch (state-1 dying)`, 1);
      // The dying card is itself a state-1 recipe slot. Server can't
      // see the client's board, so it doesn't run chain repair — the
      // top state-1 child inherits this card's slot exactly (which is
      // also state-1 with `microLocation` = our predecessor); the
      // bottom child re-anchors to the new top. Transitive descendants
      // stay in place — their `microLocation` references survive
      // because we promoted the immediate child rather than removing
      // it.
      this.transplantSlotChildren(cardId, row);
    }

    card.stackedTop = 0;
    card.stackedBottom = 0;
    card.stackedHex = 0;
    this.splicing.delete(cardId);
    debug.log(["splice"], `[splice] exit card=${cardId}`, 1);
  }

  /** Collect every card currently rooted at `rootId` in `direction`,
   *  sorted by `position` ascending. Filters `cardsLocal` directly —
   *  slower than walking the back-pointer cache but tolerates gaps and
   *  is independent of cache state (used by `spliceCard` where the
   *  cache may still hold stale predecessors). `direction` is a
   *  `STACK_DIRECTION_UP` / `STACK_DIRECTION_DOWN` value. */
  private collectChainMembers(rootId: number, direction: number): number[] {
    const members: { id: number; pos: number }[] = [];
    for (const [id, r] of this.ctx.data.cardsLocal) {
      if (r.microLocation !== rootId) continue;
      if (getStackedState(r.microZone) !== STACKED_ON_ROOT) continue;
      if (getStackDirection(r.microZone) !== direction) continue;
      members.push({ id, pos: getStackPosition(r.microZone) });
    }
    members.sort((a, b) => a.pos - b.pos);
    return members.map((m) => m.id);
  }

  /**
   * Where a `STACKED_ON_HEX` child of a dying hex should land. Mirrors the
   * dying hex's own position so the child stays put visually — wherever the
   * hex was, the child takes its place loose:
   *
   *   - hex loose in inventory → child loose at the same `(x, y)`
   *   - hex stacked on another hex (state 3, microLocation=parentId)
   *       → child re-anchors to the same parent hex
   *
   * World cases (hex loose in world, hex on a bare world tile) are stripped
   * for now; they'd return `kind: "world"` positions when world returns.
   */
  private releasedHexChildPosition(row: CardRow): CardPositionState | null {
    const state = getStackedState(row.microZone);
    if (state === STACKED_LOOSE) {
      const { x, y } = decodeLooseXY(row.microLocation);
      return { kind: "inventory", x, y };
    }
    if (state === STACKED_ON_HEX) {
      if (row.microLocation === 0) {
        return null; // would be a world position; stripped
      }
      return { kind: "stacked", parentId: row.microLocation, direction: "hex" };
    }
    return null;
  }

  /** Repair the state-1 chain anchored at a dying card by transplanting
   *  its IMMEDIATE slot children. The dying card has at most one state-1
   *  child per direction; this function:
   *
   *  1. Finds the (top, bottom) immediate state-1 children of
   *     `dyingCardId` — rows with `microLocation === dyingCardId` AND
   *     state == STACKED_SLOT, partitioned by direction.
   *  2. Promotes one child to inherit the dying card's row exactly:
   *     copies `macroZone`, `surface`, `microZone`, `microLocation`
   *     onto it. The inheritor takes the dying card's place wherever
   *     it sat — loose, state-2 mid-chain, state-3 on hex, or even
   *     state-1 itself. Top wins by convention; bottom inherits only
   *     when there is no top.
   *  3. If both directions had children, the bottom child re-anchors
   *     to the (newly-positioned) top child — stays state-1, direction
   *     stays DOWN, `microLocation = topChildId`. Subscriptions follow
   *     by inheriting `macroZone` / `surface`.
   *
   *  Transitive descendants (state-1 grandchildren and below) are NOT
   *  touched — their immediate parents (the children we just
   *  transplanted) still exist, so their `microLocation` references
   *  remain valid. The chain shape is preserved minus the dying card.
   *
   *  Caller passes the dying card's ORIGINAL row (`dyingRow`) — splice
   *  branches that mutate the dying card mid-procedure (e.g. setting
   *  it to loose 0,0 to detach it from a chain) must call this before
   *  the mutation OR pass the captured pre-mutation row. */
  private transplantSlotChildren(dyingCardId: number, dyingRow: CardRow): void {
    let topChildId = 0;
    let bottomChildId = 0;
    for (const [id, r] of this.ctx.data.cardsLocal) {
      if (id === dyingCardId) continue;
      if (r.microLocation !== dyingCardId) continue;
      if (getStackedState(r.microZone) !== STACKED_SLOT) continue;
      if (getStackDirection(r.microZone) === STACK_DIRECTION_UP) {
        topChildId = id;
      } else {
        bottomChildId = id;
      }
    }
    if (topChildId === 0 && bottomChildId === 0) {
      debug.log(["splice"], `[splice] transplantSlotChildren dyingCard=${dyingCardId} no state-1 children`, 2);
      return;
    }

    const inheritorId = topChildId !== 0 ? topChildId : bottomChildId;
    const inheritorRow = this.ctx.data.cardsLocal.get(inheritorId);
    debug.log(
      ["splice"],
      `[splice] transplantSlotChildren dyingCard=${dyingCardId} topChild=${topChildId} bottomChild=${bottomChildId} inheritor=${inheritorId} (inheriting microZone=0x${dyingRow.microZone.toString(16)} microLocation=${dyingRow.microLocation} macroZone=${dyingRow.macroZone} surface=${dyingRow.surface})`,
      2,
    );
    if (inheritorRow !== undefined) {
      this.ctx.data.setLocalCard(inheritorId, {
        ...inheritorRow,
        macroZone:     dyingRow.macroZone,
        surface:       dyingRow.surface,
        microZone:     dyingRow.microZone,
        microLocation: dyingRow.microLocation,
      });
    }

    if (topChildId !== 0 && bottomChildId !== 0) {
      const bottomRow = this.ctx.data.cardsLocal.get(bottomChildId);
      if (bottomRow !== undefined) {
        debug.log(
          ["splice"],
          `[splice]   re-anchor bottomChild=${bottomChildId} as state-1 onto new top=${topChildId}`,
          2,
        );
        this.ctx.data.setLocalCard(bottomChildId, {
          ...bottomRow,
          macroZone:     dyingRow.macroZone,
          surface:       dyingRow.surface,
          microZone:     packSlotMicroZone(STACK_DIRECTION_DOWN),
          microLocation: topChildId,
        });
      }
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
      newRow = {
        ...row,
        macroZone: row.ownerId,
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
      // World position — stripped while world tier is gone. Restore the
      // packMacroZone / packMicroZone path from `server/data/packing` here
      // when world returns.
      return;
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
   * Mixes state-2 (`STACKED_ON_ROOT`) and state-1 (`STACKED_SLOT`) chain
   * members correctly:
   *
   * 1. Direct children of `rootId` are enumerated — any card whose
   *    `microLocation === rootId` AND state is `ON_ROOT` or `SLOT` AND
   *    `getStackDirection` matches.
   * 2. Each direct child gets a chain index: state-2 reads the
   *    `position` field; state-1 directly on root sits at chain index 1
   *    (one hop above root).
   * 3. Direct children sort by chain index ascending.
   * 4. For each direct child in order, push to the result and
   *    recursively append its state-1 sub-chain (cards whose
   *    `microLocation === thisCard`, state `SLOT`, direction matches —
   *    walking parent-pointer style until a leaf).
   *
   * The result is the visual chain: every member from `rootId` outward,
   * regardless of how state-1 islands and state-2 chunks interleave.
   * Sparse state-2 positions appear as gaps in chain index space — the
   * matcher treats them like any other chain (recipes that need
   * contiguity won't match across gaps).
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
      if (getStackDirection(row.microZone) !== direction) continue;
      const state = getStackedState(row.microZone);
      if (state !== STACKED_ON_ROOT && state !== STACKED_SLOT) continue;
      const card = this.cards.get(id);
      if (!card) continue;
      const chainIdx =
        state === STACKED_ON_ROOT
          ? getStackPosition(row.microZone)
          : 1; // state-1 directly on root sits at chain index 1
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
