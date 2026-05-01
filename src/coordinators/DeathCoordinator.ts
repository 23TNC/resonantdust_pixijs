import {
  client_cards,
  removeClientCard,
  resolvePendingUpserts,
  type CardId,
} from "@/spacetime/Data";
import { deathState, setDeathState } from "@/model/CardModel";
import { spacetime } from "@/spacetime/SpacetimeManager";

/**
 * Owns the death lifecycle of a card.  Reads / writes the `dead` slot in
 * CardModel — never mutates client_cards rows for state.
 *
 *   alive  (dead===0)
 *     → DeathCoordinator.beginDeath(cardId)             — server-initiated
 *   dying  (dead===1)
 *     → DeathCoordinator.notifyAnimationComplete(cardId) — view-initiated
 *       when the burn-up fade finishes
 *   dead   (dead===2)
 *     → DeathCoordinator.finalize(cardId)               — owner-initiated
 *       (CardStack orphans branch children first, then calls finalize)
 *
 * Splitting `notifyAnimationComplete` from `finalize` lets owners (like
 * CardStack) react to the dead state in a layout pass before the row is
 * actually removed from `client_cards`.
 */
export class DeathCoordinator {
  /**
   * Mark the card as dying (dead===1) and notify listeners so view widgets
   * can start their animations.  No-op if the card is missing or already non-alive.
   */
  static beginDeath(cardId: CardId): void {
    if (!client_cards[cardId]) return;
    if (deathState(cardId) !== 0) return;
    setDeathState(cardId, 1);
    spacetime.notifyCardListeners(cardId);
  }

  /**
   * Called by the card's view when its death animation completes.  Marks
   * dead===2 and fires listeners; owners observing those listeners react
   * in a subsequent layout pass and eventually call `finalize`.
   */
  static notifyAnimationComplete(cardId: CardId): void {
    if (!client_cards[cardId]) return;
    if (deathState(cardId) === 2) return;
    setDeathState(cardId, 2);
    spacetime.notifyCardListeners(cardId);
  }

  /**
   * Remove the card row, flushing any pending upserts whose dying parent
   * was this card.  Called by the card's owning view (CardStack) after it
   * has handled chain consequences (orphaning branch children, etc.).
   */
  static finalize(cardId: CardId): void {
    resolvePendingUpserts(cardId);
    removeClientCard(cardId);
    spacetime.clearCardListeners(cardId);
  }
}
