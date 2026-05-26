import type { GameContext } from "../GameContext";
import type { Card as CardRow } from "../server/spacetime/bindings/types";

/** `is_owned_by_player` lives in `cards_state` (bit 4 post unified-
 *  hold-counts rework — see `content/cards/flags.json`). Set on
 *  soul cards (their `ownerId` is a `player_id`); clear on every
 *  other card (their `ownerId` is a `card_id` — the immediate
 *  container card, `0` for world). */
const FLAG_OWNED_BY_PLAYER = 1 << 4;
/** Walker depth cap mirroring the server's
 *  `cards::OWNER_WALK_DEPTH_CAP`. Defensive against cycles that
 *  slipped past server-side `would_cycle` checks. */
const OWNER_WALK_DEPTH_CAP = 32;

/**
 * Walk `ownerId` through the local card overlay until a row with
 * `FLAG_OWNED_BY_PLAYER` set is reached. Returns `{ soulCardId,
 * playerId }` — `soulCardId` is the row's id (the soul card),
 * `playerId` is the row's `ownerId` (a player id under the
 * post-flag-20 model). Returns `null` if the walk reaches a card
 * not present locally (subscription gap), terminates at a
 * world-owned card (`ownerId === 0` without the flag), or trips
 * the depth cap.
 *
 * Centralized so drop-side-effect resolvers and permission gates
 * agree on which soul a given card chain belongs to.
 */
export function owningSoul(ctx: GameContext, cardId: number): { soulCardId: number; playerId: number } | null {
  let cur = cardId;
  for (let i = 0; i < OWNER_WALK_DEPTH_CAP; i++) {
    const row = ctx.data.cardsLocal.get(cur);
    if (!row) return null;
    if ((row.flagsState & FLAG_OWNED_BY_PLAYER) !== 0) {
      return { soulCardId: cur, playerId: row.ownerId };
    }
    if (row.ownerId === 0) return null;
    cur = row.ownerId;
  }
  return null;
}

/** Convenience: just the player id. Returns `null` for cards whose
 *  chain doesn't end at a player-owned soul. */
function owningPlayerId(ctx: GameContext, cardId: number): number | null {
  return owningSoul(ctx, cardId)?.playerId ?? null;
}

/**
 * Centralized "click on something soul-related → activate it if the
 * local player owns it" helper. Used by:
 *
 *   - Clicking a soul card in the game view (focused gameview
 *     retargets to this soul; drag of the same card switches to
 *     ghost-drag for movement).
 *   - Clicking / focusing an inventory panel (drags of cards inside
 *     the inventory are then permission-gated against the new
 *     active soul).
 *   - Selecting a soul in the chooser (Play / drag pathways read
 *     the active soul next).
 *
 * Returns `true` when activation succeeded, `false` when the card
 * isn't a soul card or isn't owned by the local player. No-op when
 * the soul is already active. The check mirrors `canPickUpCard`'s
 * shape but reads the row directly rather than walking the
 * `owner_id` chain — soul cards carry `is_owned_by_player` and have
 * their `owner_id` set to the player_id directly, so a one-row read
 * suffices.
 */
export function tryActivateSoul(ctx: GameContext, soulCardId: number): boolean {
  const row = ctx.data.cardsLocal.get(soulCardId);
  if (!row) return false;
  if ((row.flagsState & FLAG_OWNED_BY_PLAYER) === 0) return false;
  const player = ctx.playerSession.getPlayer();
  if (!player || row.ownerId !== player.playerId) return false;
  if (ctx.souls.getSoulId() === soulCardId) return true;
  ctx.souls.setActiveSoul(soulCardId);
  return true;
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
