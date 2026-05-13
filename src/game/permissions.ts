import type { GameContext } from "../GameContext";
import type { Card as CardRow } from "../server/spacetime/bindings/types";

/**
 * Can the local player pick this card up?
 *
 * **Today's rule:** ownership — `card.ownerId` must equal the local
 * player's `playerId`. Returns `false` if no player is logged in.
 *
 * **Why a function:** this is the single decision point for "may the
 * local player initiate a drag on this card?" The check WILL widen
 * over time:
 *
 * - Soul / party shared cards: members of the same soul-group may
 *   handle each other's cards.
 * - World tile occupants: any player standing on or adjacent to the
 *   tile may pick up its non-locked occupants (chopping trees,
 *   collecting drops, etc.).
 * - Faction / region rules: cards in a hostile faction's territory
 *   may be pickup-locked for non-members.
 * - GM / admin override.
 *
 * Every new rule lands here. Call sites that need "can the local
 * player touch this card" should always go through this function
 * rather than re-deriving the ownership check inline — that's how the
 * rule set stays consistent across drag, magnetic pull, target
 * filtering, etc.
 *
 * Separate from the `position_hold` / `position_locked` flag checks
 * which encode the card's *state* ("currently held by an action") —
 * those live in `DragManager.pickupBlocked` and remain orthogonal.
 * Both must pass for a successful pickup.
 */
export function canPickUpCard(ctx: GameContext, card: CardRow): boolean {
  const player = ctx.playerSession.getPlayer();
  if (!player) return false;
  return card.ownerId === player.playerId;
}
