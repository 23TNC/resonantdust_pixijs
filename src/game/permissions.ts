import type { GameContext } from "../GameContext";
import type { Card as CardRow } from "../server/spacetime/bindings/types";

/** `is_owned_by_player` (bit 20). Mirrors server-side
 *  `cards::FLAG_OWNED_BY_PLAYER`. Set on soul cards (their `ownerId`
 *  is a `player_id`); clear on every other card (their `ownerId` is
 *  a `card_id` — the immediate container card, `0` for world). */
const FLAG_OWNED_BY_PLAYER = 1 << 20;
/** Walker depth cap mirroring the server's
 *  `cards::OWNER_WALK_DEPTH_CAP`. Defensive against cycles that
 *  slipped past server-side `would_cycle` checks. */
const OWNER_WALK_DEPTH_CAP = 32;

/**
 * Resolve the player who ultimately owns `cardId` by walking
 * `ownerId` through the local card overlay until a row with
 * `FLAG_OWNED_BY_PLAYER` set is reached; that row's `ownerId` is
 * the player_id. Returns `null` if the walk reaches a card not
 * present in the local view (subscription gap), terminates at a
 * world-owned card (`ownerId === 0` without the flag), or trips
 * the depth cap.
 */
function owningPlayerId(ctx: GameContext, cardId: number): number | null {
  let cur = cardId;
  for (let i = 0; i < OWNER_WALK_DEPTH_CAP; i++) {
    const row = ctx.data.cardsLocal.get(cur);
    if (!row) return null;
    if ((row.flags & FLAG_OWNED_BY_PLAYER) !== 0) {
      return row.ownerId;
    }
    if (row.ownerId === 0) return null;
    cur = row.ownerId;
  }
  return null;
}

/**
 * Can the local player pick this card up?
 *
 * **Today's rule:** ownership — walking the card's `ownerId` chain
 * up to a soul, the soul's `ownerId` (a player_id under the post-
 * flag-20 card-owner model) must equal the local player's
 * `playerId`. Returns `false` if no player is logged in or the
 * walk can't resolve to a player (world cards, missing parents).
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
  return owningPlayerId(ctx, card.cardId) === player.playerId;
}
