import {
  type CardId,
  server_cards,
  client_cards,
  removeClientCard,
} from "./Data";

type Mode = "simulated" | "connected";

/**
 * Single interface point for all SpacetimeDB operations.
 *
 * In "simulated" mode (default) each method directly applies the table changes
 * that SpacetimeDB subscription callbacks would normally push.
 *
 * In "connected" mode each method calls the corresponding generated reducer and
 * lets the real subscription callbacks drive state.  Signatures stay identical.
 *
 * Listeners: register a callback keyed by card_id to be notified when that
 * card's state changes (dead=1 on deletion, dead=2 when animation completes).
 * Card widgets use this to start their death animation; CardStack uses it to
 * detect when cleanup is due.
 */
class SpacetimeManager {
  private _mode: Mode = "simulated";
  private _cardListeners = new Map<CardId, Set<() => void>>();

  get mode(): Mode { return this._mode; }

  // ─── Listener registry ─────────────────────────────────────────────────────

  /** Register a callback fired whenever the named card's state changes.
   *  Returns an unregister function — call it when the listener is no longer needed. */
  registerCardListener(card_id: CardId, fn: () => void): () => void {
    let set = this._cardListeners.get(card_id);
    if (!set) { set = new Set(); this._cardListeners.set(card_id, set); }
    set.add(fn);
    return () => {
      const s = this._cardListeners.get(card_id);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this._cardListeners.delete(card_id);
    };
  }

  /** Fire all listeners registered for card_id.  Called by Card when dead
   *  transitions to 2 so CardStack knows to finalize removal. */
  notifyCardListeners(card_id: CardId): void {
    this._cardListeners.get(card_id)?.forEach(fn => fn());
  }

  // ─── Card reducers ─────────────────────────────────────────────────────────

  /**
   * Delete a card row.
   *
   * Simulated: removes the row from server_cards and marks client_cards[card_id].dead = 1,
   * then fires listeners so Card widgets start their death animation.
   * removeClientCard is deferred until finalizeCardRemoval is called.
   */
  deleteCard(card_id: CardId): void {
    if (this._mode === "simulated") {
      this._simDeleteCard(card_id);
    } else {
      // TODO: connection.reducers.deleteCard({ cardId: card_id });
    }
  }

  /**
   * Called by the card's owner (e.g. CardStack) after dead===2 is detected and
   * the Card widget has been destroyed.  Removes the card from all client tables
   * and indexes and clears its listener set.
   */
  finalizeCardRemoval(card_id: CardId): void {
    removeClientCard(card_id);
    this._cardListeners.delete(card_id);
  }

  // ─── Simulation helpers ────────────────────────────────────────────────────

  private _simDeleteCard(card_id: CardId): void {
    const card = client_cards[card_id];
    if (!card || card.dead !== 0) return;
    delete server_cards[card_id];
    card.dead = 1;
    this.notifyCardListeners(card_id);
  }
}

export const spacetime = new SpacetimeManager();
