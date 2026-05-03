import type { GameContext } from "../GameContext";
import type { ZoneId } from "../zones/zoneId";
import { Card, type StackDirection } from "./Card";
import {
  getStackedState,
  STACKED_ON_RECT_X,
  STACKED_ON_RECT_Y,
} from "./cardData";

export type CardChangeKind = "added" | "removed";
export type CardListener = (kind: CardChangeKind, card: Card) => void;

export class CardManager {
  private readonly cards = new Map<number, Card>();
  private readonly byZone = new Map<ZoneId, Set<Card>>();
  private readonly listeners = new Map<ZoneId, Set<CardListener>>();
  private readonly unsubscribe: () => void;

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

      const candidateId =
        direction === "top" ? leaf.stackedTop : leaf.stackedBottom;
      if (candidateId === 0) break;
      // If A is currently in this chain (e.g. dragging a stacked card and
      // dropping back near its existing parent), don't descend through
      // ourselves — that would make A its own leaf and self-stack. Stop at
      // leaf and let setPosition do the (possibly no-op) write. Don't repair
      // the pointer either: A's data still says it's stacked here, and
      // onDataChange will clear the pointer when A's row updates.
      if (candidateId === aId) break;

      const next = this.validatedSlot(leafId, direction);
      if (next === 0) break;
      leafId = next;
    }

    a.setPosition({ kind: "stacked", parentId: leafId, direction });
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
      const card = this.cards.get(id);
      if (!card) continue;
      const row = this.ctx.data.get("cards", id);
      if (!row) continue;
      card.setPosition({
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
      }
    }
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
    let set = this.listeners.get(zoneId);
    if (!set) {
      set = new Set();
      this.listeners.set(zoneId, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(zoneId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(zoneId);
    };
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

    const oldBucket = this.byZone.get(oldZoneId);
    if (oldBucket) {
      oldBucket.delete(card);
      if (oldBucket.size === 0) this.byZone.delete(oldZoneId);
    }
    this.fireZone(oldZoneId, "removed", card);

    let newBucket = this.byZone.get(newZoneId);
    if (!newBucket) {
      newBucket = new Set();
      this.byZone.set(newZoneId, newBucket);
    }
    newBucket.add(card);
    this.fireZone(newZoneId, "added", card);
  }

  dispose(): void {
    this.unsubscribe();
    for (const card of this.cards.values()) card.destroy();
    this.cards.clear();
    this.byZone.clear();
    this.listeners.clear();
  }

  private spawn(cardId: number): void {
    if (this.cards.has(cardId)) return;
    const card = Card.create(cardId, this.ctx, this);
    if (!card) return;
    this.cards.set(cardId, card);

    const zoneId = card.zoneId();
    let bucket = this.byZone.get(zoneId);
    if (!bucket) {
      bucket = new Set();
      this.byZone.set(zoneId, bucket);
    }
    bucket.add(card);
    this.fireZone(zoneId, "added", card);
  }

  private destroy(cardId: number): void {
    const card = this.cards.get(cardId);
    if (!card) return;

    const zoneId = card.zoneId();
    const bucket = this.byZone.get(zoneId);
    if (bucket) {
      bucket.delete(card);
      if (bucket.size === 0) this.byZone.delete(zoneId);
    }
    this.fireZone(zoneId, "removed", card);

    card.destroy();
    this.cards.delete(cardId);
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
