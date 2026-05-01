import { client_actions, client_cards, type CardId } from "@/spacetime/Data";
import { spacetime } from "@/spacetime/SpacetimeManager";
import {
  selectGreedy, getTileDef,
  type RecipeActivation,
} from "@/definitions/RecipeDefinitions";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CachedActivation {
  recipe_index: number;
  /** Card that owns the server-side Action row (used for cancellation lookup). */
  actor_card:   CardId;
  /** Every card locked to this activation (catalyst + reagent). */
  participants: readonly CardId[];
}

// ── Cache ─────────────────────────────────────────────────────────────────────

/**
 * Per-card action cache.  Each participating card (catalyst or reagent) gets
 * its own entry so lookups and cancellations are O(participants) without
 * needing to know which stack root currently owns the card.
 */
const card_action_cache = new Map<CardId, CachedActivation[]>();

// ── Internals ─────────────────────────────────────────────────────────────────

function _findAction(actorCard: CardId, recipeIndex: number) {
  for (const key in client_actions) {
    const a = client_actions[Number(key)];
    if (a.card_id === actorCard && a.recipe === recipeIndex) return a;
  }
  return null;
}

function _actionCount(cardId: CardId): number {
  return card_action_cache.get(cardId)?.length ?? 0;
}

function _isRunningRecipe(cardId: CardId, recipeIndex: number): boolean {
  return card_action_cache.get(cardId)?.some(a => a.recipe_index === recipeIndex) ?? false;
}

/**
 * Cancel all cached activations whose participants are not fully present in
 * the given set.  Removes evicted entries from every participant's cache.
 */
function _validateAndCancel(presentCardIds: readonly CardId[]): void {
  const present = new Set<CardId>(presentCardIds);
  const toCancel: CachedActivation[] = [];
  const seen = new Set<string>(); // "actor:recipe" dedup key

  for (const cardId of presentCardIds) {
    for (const act of card_action_cache.get(cardId) ?? []) {
      const key = `${act.actor_card}:${act.recipe_index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!act.participants.every(id => present.has(id))) toCancel.push(act);
    }
  }

  for (const act of toCancel) {
    const action = _findAction(act.actor_card, act.recipe_index);
    if (action) spacetime.cancelAction(action.action_id);
    for (const pid of act.participants) {
      const entries = card_action_cache.get(pid);
      if (!entries) continue;
      const filtered = entries.filter(
        a => !(a.actor_card === act.actor_card && a.recipe_index === act.recipe_index),
      );
      if (filtered.length === 0) card_action_cache.delete(pid);
      else card_action_cache.set(pid, filtered);
    }
  }
}

/**
 * Find new recipe activations for a set of cards, then start and cache them.
 *
 * Filtering applied before matching:
 *   - Cards with 2 or more running actions are globally excluded.
 *   - Cards already running a specific recipe are excluded from that recipe,
 *     so the same recipe is never duplicated for the same participants.
 */
function _acquireAndStart(
  cards:      readonly CardId[],
  recipeType: string,
  tileDef:    ReturnType<typeof getTileDef>,
  pos:        { world_q: number; world_r: number; layer: number },
  ownerId:    CardId,
): void {
  const eligible = cards.filter(id => _actionCount(id) < 2);
  if (eligible.length === 0) return;

  const activations: RecipeActivation[] = selectGreedy(
    recipeType,
    eligible,
    tileDef,
    _isRunningRecipe,
  );

  for (const activation of activations) {
    spacetime.startActionNow(
      activation.actorCard,
      ownerId,
      activation.recipe.index,
      pos.world_q,
      pos.world_r,
      pos.layer,
    );
    const entry: CachedActivation = {
      recipe_index: activation.recipe.index,
      actor_card:   activation.actorCard,
      participants: activation.participants,
    };
    for (const pid of activation.participants) {
      const existing = card_action_cache.get(pid);
      if (existing) existing.push(entry);
      else card_action_cache.set(pid, [entry]);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called whenever a CardStack's chain changes (card added or removed).
 *
 * `upChain` and `downChain` must be the chains the CardStack computed via its
 * own walk (which excludes dragging/animating cards), with rootId prepended to
 * each.  Using the caller's chains — rather than re-deriving them from the raw
 * stacking indexes — ensures validation sees exactly which cards are actually
 * present, not which cards are still referenced in the index because a drag
 * started but hasn't committed yet.
 *
 * 1. Cancels any cached actions whose participants are no longer all present.
 * 2. Finds new top_stack recipes from the up-chain and bottom_stack recipes
 *    from the down-chain, skipping cards already saturated (≥2 actions) or
 *    already running the candidate recipe.
 * 3. Starts matching actions on the server and caches them per participant.
 */
export function syncStackActions(
  rootId:    CardId,
  upChain:   readonly CardId[],
  downChain: readonly CardId[],
  ownerId:   CardId,
): void {
  const allPresent = new Set<CardId>(upChain);
  for (const id of downChain) allPresent.add(id);

  _validateAndCancel([...allPresent]);

  const rootCard = client_cards[rootId];
  if (!rootCard) return;

  const tileDef = getTileDef(rootCard.macro_location, rootCard.micro_location);
  const pos = { world_q: rootCard.world_q, world_r: rootCard.world_r, layer: rootCard.layer };

  _acquireAndStart(upChain,   "top_stack",    tileDef, pos, ownerId);
  _acquireAndStart(downChain, "bottom_stack", tileDef, pos, ownerId);
}
