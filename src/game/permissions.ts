import type { GameContext } from "../GameContext";
import type { Card as CardRow } from "../server/spacetime/bindings/types";

/** The slice of `GameContext` the owner-chain walks read: the local card
 *  overlay and the definition decoder. Narrowed (rather than the full
 *  `GameContext`) so non-GameContext callers with the same fields —
 *  `LifecycleResolutionManager`'s `MagneticResolutionContext` — can pass
 *  themselves without a cast. */
type OwnerWalkCtx = Pick<GameContext, "data" | "definitions">;

/** `is_owned_by_player` lives in `cards_state` (bit 4 post unified-
 *  hold-counts rework — see `content/cards/flags.json`). Marks the
 *  player-boundary card: set → this row's `ownerId` is a `player_id`
 *  (the thin player_soul that *is* the player); clear → `ownerId` is
 *  a `card_id` (the immediate container, `0` for world). It is NOT a
 *  "this is a soul" marker — playable world souls (human, etc.) carry
 *  it clear; their `ownerId` points at the player_soul card. So this
 *  flag answers "who is the controlling player," never "which soul." */
const FLAG_OWNED_BY_PLAYER = 1 << 4;
/** Walker depth cap mirroring the server's
 *  `cards::OWNER_WALK_DEPTH_CAP`. Defensive against cycles that
 *  slipped past server-side `would_cycle` checks. */
const OWNER_WALK_DEPTH_CAP = 32;

/**
 * Walk the `ownerId` chain (inclusive of `cardId` itself) to the
 * nearest `card_type == soul` ancestor and return its `card_id`.
 * Generic and recursion-safe: a `player_soul → human → human` chain
 * stops at the FIRST soul, so the card's *immediate* owning soul wins.
 * Returns `null` when the walk hits a card not present locally
 * (subscription gap), terminates at the world (`ownerId === 0` with no
 * soul seen), or trips the depth cap.
 *
 * Independent of `FLAG_OWNED_BY_PLAYER` — souls are identified by their
 * card_type, not the player-boundary flag. Centralized so drop-side-
 * effect resolvers and the active-soul pointer agree on which soul a
 * given card belongs to.
 */
export function owningSoul(ctx: OwnerWalkCtx, cardId: number): number | null {
  let cur = cardId;
  for (let i = 0; i < OWNER_WALK_DEPTH_CAP; i++) {
    const row = ctx.data.cardsLocal.get(cur);
    if (!row) return null;
    if (ctx.definitions.isCardType(row.packedDefinition, "soul")) return cur;
    if (row.ownerId === 0) return null;
    cur = row.ownerId;
  }
  return null;
}

/**
 * Walk the `ownerId` chain (inclusive) to the controlling player.
 * Terminates at the first `FLAG_OWNED_BY_PLAYER` card — that row's
 * `ownerId` is the `player_id` — and returns it. A chain reaching the
 * world (`ownerId === 0` without the flag) belongs to no player
 * (world / NPC-controller cards) and returns `null`; same for a
 * subscription gap or the depth cap. This is the only place the
 * player-boundary flag is consulted.
 */
export function owningPlayer(ctx: OwnerWalkCtx, cardId: number): number | null {
  let cur = cardId;
  for (let i = 0; i < OWNER_WALK_DEPTH_CAP; i++) {
    const row = ctx.data.cardsLocal.get(cur);
    if (!row) return null;
    if ((row.flags & FLAG_OWNED_BY_PLAYER) !== 0) return row.ownerId;
    if (row.ownerId === 0) return null;
    cur = row.ownerId;
  }
  return null;
}

/**
 * Centralized "click on something soul-related → make its soul the
 * active (last-interacted) soul" helper. Used by:
 *
 *   - Clicking a soul card / a card in the world (the card's owning
 *     soul becomes active — `owningSoul` resolves it at any chain
 *     depth, so clicking an item activates the soul that holds it).
 *   - Clicking / focusing an inventory panel.
 *
 * Resolves `cardId`'s owning soul via [`owningSoul`] (the card itself
 * when it IS a soul). Returns `true` when a soul resolved (and is now
 * active), `false` when the card's chain reaches no soul. No-op when
 * that soul is already active.
 *
 * No ownership gate — activation just points the UI at a soul; whether
 * the local player may *act* through it is the (future) card-vs-card
 * permission layer's concern, not activation's. `canPickUpCard` remains
 * the gate for initiating drags.
 */
export function tryActivateSoul(ctx: GameContext, cardId: number): boolean {
  // Resolve the soul this card belongs to (the card itself if it IS a
  // soul). No ownership gate — activation is "this soul is now the one
  // the UI tracks"; who may *act* through it is the coming card-vs-card
  // permission layer's job, not activation's.
  const soulCardId = owningSoul(ctx, cardId);
  if (soulCardId === null) return false;
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
  return owningPlayer(ctx, card.cardId) === player.playerId;
}
