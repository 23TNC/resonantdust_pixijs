import type { GameContext } from "../GameContext";
import type { ZoneId } from "../zones/zoneId";
import { Card } from "./Card";

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
    this.unsubscribe = ctx.data.subscribeKeys("cards", ({ kind, key }) => {
      const cardId = key as number;
      if (kind === "added") this.spawn(cardId);
      else this.destroy(cardId);
    });
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
