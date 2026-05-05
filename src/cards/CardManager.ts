import type { GameContext } from "../GameContext";
import type { Card as CardRow } from "../server/bindings/types";
import type { ZoneId } from "../zones/zoneId";
import { Card, type CardPositionState, type StackDirection } from "./Card";
import {
  clearStackedState,
  decodeLooseXY,
  encodeLooseXY,
  getStackedState,
  setStackedState,
  STACKED_LOOSE,
  STACKED_ON_HEX,
  STACKED_ON_RECT_X,
  STACKED_ON_RECT_Y,
} from "./cardData";
import { packMacroZone, unpackMacroZone, WORLD_LAYER, ZONE_SIZE } from "../world/worldCoords";

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
    for (const cardId of ctx.data.keys("cards")) {
      this.spawn(cardId as number);
    }
    // Spawn order is arbitrary so a child may have spawned before its
    // parent and missed setting its back-pointer. Repair once now that
    // every card is in the registry.
    this.repairBackPointers();
    this.unsubscribe = ctx.data.subscribeKeys("cards", ({ kind, key }) => {
      const cardId = key as number;
      if (kind === "added") this.spawn(cardId);
      else this.destroy(cardId);
    });
  }

  /**
   * Remove `cardId` from its chain, bridging the gap it leaves behind.
   *
   * - State 0 (loose/root): both stacked children are freed to loose positions
   *   offset one title-height above/below the dying card's packed XY.
   * - State 1/2 (mid-chain): the continuation child (same direction as this
   *   card's attachment) inherits this card's `microZone` and `microLocation`
   *   verbatim, transplanting its chain position exactly. The cross child is
   *   left for orphan-detection to recover (uncommon case).
   * - State 3 (hex/world-root): top child becomes the new root; bottom child
   *   is directly re-parented onto the new root's bottom slot.
   */
  spliceCard(cardId: number): void {
    const card = this.cards.get(cardId);
    if (!card) return;
    const row = this.ctx.data.get("cards", cardId);
    if (!row) return;

    this.splicing.add(cardId);
    const state = getStackedState(row.microZone);

    const isWorld = row.layer >= WORLD_LAYER;

    if (state === STACKED_LOOSE) {
      const topId    = card.stackedTop;
      const bottomId = card.stackedBottom;
      if (isWorld) {
        const { zoneQ, zoneR } = unpackMacroZone(row.macroZone);
        const q = zoneQ + ((row.microZone >> 5) & 0x7);
        const r = zoneR + ((row.microZone >> 2) & 0x7);
        if (topId !== 0) {
          this.setCardPosition(topId, { kind: "world", q, r });
          if (bottomId !== 0) this.stack(bottomId, topId, "bottom");
        } else if (bottomId !== 0) {
          this.setCardPosition(bottomId, { kind: "world", q, r });
        }
      } else {
        // Make the top child the new root, then re-stack the bottom child onto
        // it so the two survivors stay paired rather than scattering loose.
        const { x, y } = decodeLooseXY(row.microLocation);
        if (topId !== 0) {
          this.setCardPosition(topId, { kind: "loose", x, y });
          if (bottomId !== 0) this.stack(bottomId, topId, "bottom");
        } else if (bottomId !== 0) {
          this.setCardPosition(bottomId, { kind: "loose", x, y });
        }
      }
    } else if (state === STACKED_ON_RECT_X || state === STACKED_ON_RECT_Y) {
      // stack() does a leaf walk from the parent which still sees this card
      // as a live child, so attach the continuation child directly instead.
      const dir: StackDirection = state === STACKED_ON_RECT_X ? "top" : "bottom";
      const continuationId = dir === "top" ? card.stackedTop : card.stackedBottom;
      this.setCardPosition(continuationId, {
        kind: "stacked",
        parentId: row.microLocation,
        direction: dir,
      });
      // Detach this card from its parent so it is no longer part of the chain.
      this.setCardPosition(cardId, { kind: "loose", x: 0, y: 0 });
      // Cross child left for orphan-detection.
    } else if (state === STACKED_ON_HEX) {
      const hexId = row.microLocation;
      const topId = card.stackedTop;
      const bottomId = card.stackedBottom;
      if (isWorld) {
        // microLocation=0 → bare tile, coords come from the dying card's own row.
        // microLocation!=0 → stacked on a hex card, coords come from that card.
        const coordRow = hexId !== 0 ? this.ctx.data.get("cards", hexId) : row;
        if (coordRow) {
          const { zoneQ, zoneR } = unpackMacroZone(coordRow.macroZone);
          const q = zoneQ + ((coordRow.microZone >> 5) & 0x7);
          const r = zoneR + ((coordRow.microZone >> 2) & 0x7);
          if (topId !== 0) {
            this.setCardPosition(topId, { kind: "world", q, r });
            if (bottomId !== 0) {
              // Direct re-parent — bypass stack()'s leaf walk which would fire
              // fireStackChange on the intermediate single-card state.
              this.setCardPosition(bottomId, { kind: "stacked", parentId: topId, direction: "bottom" });
            }
          } else if (bottomId !== 0) {
            this.setCardPosition(bottomId, { kind: "world", q, r });
          }
        }
      } else {
        if (topId !== 0) {
          this.setCardPosition(topId, { kind: "stacked", parentId: hexId, direction: "hex" });
          if (bottomId !== 0) this.stack(bottomId, topId, "bottom");
        } else if (bottomId !== 0) {
          this.setCardPosition(bottomId, { kind: "stacked", parentId: hexId, direction: "hex" });
        }
      }
      this.setCardPosition(cardId, { kind: "loose", x: 0, y: 0 });
    }

    card.stackedTop = 0;
    card.stackedBottom = 0;
    this.splicing.delete(cardId);
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
    const aRequestedSlot = this.validatedSlot(aId, direction);
    const aOppositeSlot = this.validatedSlot(aId, oppositeDir);

    if (aRequestedSlot !== 0 && aOppositeSlot !== 0) return;

    if (aRequestedSlot === 0 && aOppositeSlot !== 0) {
      this.flipChain(aId, oppositeDir, direction);
    }

    let leafId = bId;
    while (true) {
      const leaf = this.cards.get(leafId);
      if (!leaf) return;
      // Check for self-stack before validatedSlot can repair the pointer away.
      const raw = direction === "top" ? leaf.stackedTop : leaf.stackedBottom;
      if (raw === aId) break;
      const next = this.validatedSlot(leafId, direction);
      if (next === 0) break;
      leafId = next;
    }

    this.setCardPosition(aId, { kind: "stacked", parentId: leafId, direction });
  }

  /**
   * Build and write a client-side position update for `cardId`. The row is
   * read from the data store, the position fields are replaced, and the
   * result is written back via `setClientCard` — which fires `Card.onDataChange`
   * synchronously, triggering back-pointer maintenance and layout re-parenting.
   */
  setCardPosition(cardId: number, state: CardPositionState): void {
    const row = this.ctx.data.get("cards", cardId);
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
        layer: 1,
        microLocation: encodeLooseXY(state.x, state.y),
        microZone: clearStackedState(row.microZone),
      };
    } else if (state.kind === "stacked") {
      const stateBits =
        state.direction === "top" ? STACKED_ON_RECT_X :
        state.direction === "bottom" ? STACKED_ON_RECT_Y :
        STACKED_ON_HEX;
      const parentRow = this.ctx.data.get("cards", state.parentId);
      newRow = {
        ...row,
        macroZone:     parentRow?.macroZone ?? row.macroZone,
        layer:         parentRow?.layer     ?? row.layer,
        microLocation: state.parentId,
        microZone:     setStackedState(row.microZone, stateBits),
      };
    } else {
      // world: encode absolute (q, r) as macroZone + localQ/localR in microZone
      const localQ = ((state.q % ZONE_SIZE) + ZONE_SIZE) % ZONE_SIZE;
      const localR = ((state.r % ZONE_SIZE) + ZONE_SIZE) % ZONE_SIZE;
      const zoneQ  = state.q - localQ;
      const zoneR  = state.r - localR;
      newRow = {
        ...row,
        macroZone:     packMacroZone(zoneQ, zoneR),
        layer:         WORLD_LAYER,
        microZone:     setStackedState((localQ << 5) | (localR << 2), STACKED_ON_HEX),
        microLocation: 0,
      };
    }
    this.ctx.data.setClientCard(newRow);
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
   * Walk up the stack chain from `cardId` via row data and return the loose
   * root (the first ancestor whose stackedState is 0). Doesn't depend on
   * local back-pointers — uses microZone+microLocation directly so it's
   * usable from `onDataChange` after the local pointers have been updated
   * (since the data is the source of truth for `microLocation`/parent, and
   * only THIS card's row changed in any given onDataChange firing).
   */
  rootOf(cardId: number): number {
    let id = cardId;
    for (let i = 0; i < FIND_ROOT_MAX_DEPTH; i++) {
      const row = this.ctx.data.get("cards", id);
      if (!row) return id;
      const state = getStackedState(row.microZone);
      if (state !== STACKED_ON_RECT_X && state !== STACKED_ON_RECT_Y) return id;
      const parentId = row.microLocation;
      if (!this.cards.get(parentId)) return id;
      id = parentId;
    }
    return id;
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
   * Returns the validated child card-id stacked on `parentId` in `direction`,
   * or 0 if there is none. Validates the local pointer against current data
   * (does the candidate exist? does its row still claim to be stacked here
   * in the same direction?) and repairs the pointer to 0 when stale. Used by
   * `stack`'s leaf walk and by `flipChain`'s collection step.
   */
  private validatedSlot(parentId: number, direction: StackDirection): number {
    const parent = this.cards.get(parentId);
    if (!parent) return 0;
    const childId = direction === "top" ? parent.stackedTop : parent.stackedBottom;
    if (childId === 0) return 0;

    const child = this.cards.get(childId);
    const childRow = this.ctx.data.get("cards", childId);
    const expectedState =
      direction === "top" ? STACKED_ON_RECT_X : STACKED_ON_RECT_Y;
    if (
      !child ||
      !childRow ||
      getStackedState(childRow.microZone) !== expectedState ||
      childRow.microLocation !== parentId
    ) {
      if (direction === "top") parent.stackedTop = 0;
      else parent.stackedBottom = 0;
      return 0;
    }
    return childId;
  }

  /**
   * Walks the chain rooted at `rootId` in `fromDir` and rewrites every link
   * to `toDir`. Each card stays stacked on the same parent — only the
   * stackedState bits in `microZone` flip (and the titlebar swaps top↔bottom
   * via applyData). Used to keep a card's chain uniform when accepting a
   * stack opposite to what it currently holds.
   *
   * Collects the chain ids before mutating so each setPosition sees a
   * coherent pre-flip view. setPosition fires onDataChange synchronously
   * which clears the from-side back-pointer and sets the to-side pointer,
   * so the chain ends up consistent in `toDir` after the loop completes.
   */
  private flipChain(
    rootId: number,
    fromDir: StackDirection,
    toDir: StackDirection,
  ): void {
    const chain: number[] = [];
    let currentId = rootId;
    while (true) {
      const childId = this.validatedSlot(currentId, fromDir);
      if (childId === 0) break;
      chain.push(childId);
      currentId = childId;
    }

    for (const id of chain) {
      const row = this.ctx.data.get("cards", id);
      if (!row) continue;
      this.setCardPosition(id, {
        kind: "stacked",
        parentId: row.microLocation,
        direction: toDir,
      });
    }
  }

  private repairBackPointers(): void {
    for (const card of this.cards.values()) {
      const row = this.ctx.data.get("cards", card.cardId);
      if (!row) continue;
      const state = getStackedState(row.microZone);
      if (state === STACKED_ON_RECT_X) {
        const parent = this.cards.get(row.microLocation);
        if (parent) parent.stackedTop = card.cardId;
      } else if (state === STACKED_ON_RECT_Y) {
        const parent = this.cards.get(row.microLocation);
        if (parent) parent.stackedBottom = card.cardId;
      } else if (state === STACKED_ON_HEX) {
        const parent = this.cards.get(row.microLocation);
        if (parent) parent.stackedHex = card.cardId;
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
