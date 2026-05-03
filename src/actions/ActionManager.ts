import type { CardManager } from "../cards/CardManager";
import type { CardDefinition } from "../definitions/DefinitionManager";
import {
  RecipeManager,
  type ActorMatch,
  type RecipeType,
} from "../definitions/RecipeManager";
import type { GameContext } from "../GameContext";
import type { Action as ActionRow, InventoryStack } from "../server/bindings/types";
import type { ShadowedChange } from "../state/ShadowedStore";
import { packZoneId, type ZoneId } from "../zones/zoneId";

export interface CachedAction {
  actionId: number;
  cardId: number;
  /** Stable recipe ID (`Action.recipe`). Used to check "is the best
   *  recipe at this actor still the one we're running?" during the
   *  upgrade pre-filter. */
  recipe: number;
  /** Required top-stack chain length (count includes the actor). 0
   *  means no top requirement. */
  participantsUp: number;
  /** Required bottom-stack chain length (count includes the actor).
   *  0 means no bottom requirement. */
  participantsDown: number;
}

export type ActionListener = (action: CachedAction | null) => void;

type StackDirection = "top" | "bottom";

const CHAIN_MAX_DEPTH = 64;

/**
 * Owns the client-side **upgrade pre-filter** — mirrors the server's
 * `actions.rs::process_branch` machinery so the client can decide
 * whether a stack submission would actually change server state, and
 * skip submitting when it wouldn't.
 *
 * Driven by `CardManager.subscribeStackChange`: every parent / direction
 * change fires `onStackChange(rootId)` for the affected root. We collect
 * the top and bottom branches, walk every potential actor in each, and
 * for each one apply the four-way upgrade decision:
 *
 *   - none + none → nothing
 *   - none + match → server would start → submit
 *   - existing + no match → server would cancel → submit
 *   - existing + same recipe → keep running → noop
 *   - existing + different recipe → server would upgrade → submit
 *
 * If no candidate would trigger a change, the submission is skipped —
 * a no-op stack reshuffle doesn't burn a server round-trip and doesn't
 * reset any action timer. The server is the **authoritative** evaluator
 * and re-runs the same calculation independently; the client doesn't
 * trust its own prediction.
 *
 * Strict slot-filler equality (server enforces it; same recipe but
 * different filler identities ⇒ cancel + restart) is **not** mirrored
 * here — `CardHold` rows aren't in the client's subscription, so the
 * pre-filter can't see the action's frozen claim. A user swapping a
 * slot filler away typically also fires `onStackChange` for the
 * destination chain, which submits and gives the server the chance
 * to re-validate; the worst case is a brief lag before the action's
 * stale claim is reconciled.
 */
export class ActionManager {
  /** action_id → cached action. */
  private readonly byActionId = new Map<number, CachedAction>();
  /** card_id → action_id. Reverse index. One action per actor today. */
  private readonly byCardId = new Map<number, number>();
  /** card_id → listeners waiting for that card's action to change. */
  private readonly cardListeners = new Map<number, Set<ActionListener>>();

  private readonly unsubStackChange: () => void;
  private readonly unsubActionData: () => void;

  constructor(
    private readonly ctx: GameContext,
    private readonly zoneId: ZoneId,
  ) {
    if (!ctx.cards) {
      throw new Error("[ActionManager] ctx.cards is null");
    }

    // Pick up any actions already in the store for our zone (if our zone
    // subscription landed before us, rows may already be present).
    for (const row of ctx.data.valuesByIndex("actions", "zone", zoneId)) {
      this.upsert(row as ActionRow);
    }

    this.unsubActionData = ctx.data.subscribe("actions", (change) => {
      this.onActionChange(change as ShadowedChange<ActionRow>);
    });
    this.unsubStackChange = ctx.cards.subscribeStackChange(zoneId, (rootId) => {
      this.onStackChange(rootId);
    });
  }

  /** Subscribe to action changes for a specific card. Fires immediately with
   *  the current action if one exists, then on every upsert or removal.
   *  Returns an unsubscribe function. */
  subscribeCard(cardId: number, listener: ActionListener): () => void {
    let set = this.cardListeners.get(cardId);
    if (!set) {
      set = new Set();
      this.cardListeners.set(cardId, set);
    }
    set.add(listener);

    const actionId = this.byCardId.get(cardId);
    const current = actionId !== undefined ? this.byActionId.get(actionId) ?? null : null;
    listener(current);

    return () => {
      const s = this.cardListeners.get(cardId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.cardListeners.delete(cardId);
    };
  }

  dispose(): void {
    this.unsubStackChange();
    this.unsubActionData();
    this.byActionId.clear();
    this.byCardId.clear();
    this.cardListeners.clear();
  }

  private onActionChange(change: ShadowedChange<ActionRow>): void {
    if (change.kind === "delete") {
      const old = change.oldValue;
      if (old) this.remove(old.actionId);
      return;
    }
    const row = change.newValue;
    if (!row) return;
    if (packZoneId(row.macroZone, row.layer) !== this.zoneId) {
      // Out of our zone — drop any stale entry we might have. Defensive
      // against a row updating its zone (an action moving across zones is
      // probably nonsense, but if it happens we don't want a ghost entry).
      this.remove(row.actionId);
      return;
    }
    this.upsert(row);
  }

  private upsert(row: ActionRow): void {
    const previous = this.byActionId.get(row.actionId);
    if (previous && previous.cardId !== row.cardId) {
      const reverseId = this.byCardId.get(previous.cardId);
      if (reverseId === row.actionId) this.byCardId.delete(previous.cardId);
      this.emitCard(previous.cardId, null);
    }
    const action: CachedAction = {
      actionId: row.actionId,
      cardId: row.cardId,
      recipe: row.recipe,
      participantsUp: (row.participants >> 4) & 0x0F,
      participantsDown: row.participants & 0x0F,
    };
    this.byActionId.set(row.actionId, action);
    this.byCardId.set(row.cardId, row.actionId);
    this.emitCard(row.cardId, action);
  }

  private remove(actionId: number): void {
    const action = this.byActionId.get(actionId);
    if (!action) return;
    this.byActionId.delete(actionId);
    const reverseId = this.byCardId.get(action.cardId);
    if (reverseId === actionId) {
      this.byCardId.delete(action.cardId);
      this.emitCard(action.cardId, null);
    }
    // If reverseId !== actionId, a newer action already claimed this card;
    // don't emit null — that would overwrite a valid currentAction.
  }

  private emitCard(cardId: number, action: CachedAction | null): void {
    const listeners = this.cardListeners.get(cardId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(action);
      } catch (err) {
        console.error("[ActionManager] card listener threw", err);
      }
    }
  }

  /**
   * Run the upgrade pre-filter for both branches of the affected root.
   * If any actor candidate in either branch would trigger a server-side
   * state change (start, cancel, or upgrade), submit the stack so the
   * server can do its authoritative pass.
   */
  private onStackChange(rootId: number): void {
    const top = this.collectChain(rootId, "top");
    const bottom = this.collectChain(rootId, "bottom");

    let needsSubmit = false;
    if (top.length >= 1) needsSubmit = this.evaluateBranch(top, "top_stack") || needsSubmit;
    if (bottom.length >= 1) needsSubmit = this.evaluateBranch(bottom, "bottom_stack") || needsSubmit;

    if (!needsSubmit) return;

    const stack: InventoryStack = {
      root: rootId,
      stackUp: top.slice(1),
      stackDown: bottom.slice(1),
    };
    void this.ctx.spacetime.submitStacks([stack]);
  }

  /**
   * Walk every potential actor in `chain` and apply the four-way
   * upgrade decision. Returns `true` if any candidate would trigger a
   * server-side change (and the stack should be submitted). Visits all
   * candidates (not short-circuiting) so a future debug logger can see
   * every decision.
   */
  private evaluateBranch(chain: readonly number[], type: RecipeType): boolean {
    const defs = this.resolveDefinitions(chain);
    const claimedBy = this.buildClaimedMap(chain, type);
    let needsSubmit = false;
    for (let actorIdx = 0; actorIdx < chain.length; actorIdx++) {
      if (this.evaluateActorCandidate(chain, defs, actorIdx, type, claimedBy)) {
        needsSubmit = true;
      }
    }
    return needsSubmit;
  }

  /**
   * Build the claim map for a chain in one direction. For every actor
   * with an action in the chain, mark cards in its claim window
   * (`[actorIdx, actorIdx + slotCount)` in this direction's array) as
   * belonging to that action. Mirrors the server reading `CardHold`s —
   * the client can't see those rows directly, so we reconstruct the
   * claims from the actor positions and `participantsUp` /
   * `participantsDown`.
   *
   * Limitation vs. server: an actor may have an action of the *opposite*
   * branch type (e.g. a `BottomStack` action whose actor is also at
   * `chain[0]` of the top branch). For this branch's evaluation, that
   * action's claim is in the other direction — its `participantsUp` /
   * `participantsDown` for *this* branch is `0` and we map nothing from
   * it here. The actor candidate evaluator below treats that actor as
   * "not ours to touch" via the same-type guard, so the mismatch is
   * benign.
   */
  private buildClaimedMap(
    chain: readonly number[],
    type: RecipeType,
  ): Map<number, number> {
    const map = new Map<number, number>();
    for (let i = 0; i < chain.length; i++) {
      const actionId = this.byCardId.get(chain[i]);
      if (actionId === undefined) continue;
      const action = this.byActionId.get(actionId);
      if (!action) continue;
      const count = type === "top_stack" ? action.participantsUp : action.participantsDown;
      if (count === 0) continue;
      for (let j = i; j < i + count && j < chain.length; j++) {
        map.set(chain[j], actionId);
      }
    }
    return map;
  }

  /**
   * Decide whether one actor candidate in `chain` would trigger a
   * server-side state change. Returns `true` to mean "submit needed".
   * Mirrors `actions.rs::process_actor_candidate`.
   */
  private evaluateActorCandidate(
    chain: readonly number[],
    defs: readonly (CardDefinition | null)[],
    actorIdx: number,
    type: RecipeType,
    claimedBy: Map<number, number>,
  ): boolean {
    const actorId = chain[actorIdx];
    const actorActionId = this.byCardId.get(actorId);
    const actorAction = actorActionId !== undefined
      ? this.byActionId.get(actorActionId) ?? null
      : null;

    // If this card is a slot filler in someone else's action, leave it.
    // That action's actor will reach its own decision in its own
    // iteration step.
    if (actorAction && actorAction.cardId !== actorId) return false;

    // If the actor's current action is for the *other* branch direction
    // (e.g. a TopStack action while we're evaluating bottom_stack), leave
    // it alone — the other branch's iteration owns that action's fate.
    // Without this guard, a Y-stack root could have one branch's
    // evaluator unilaterally cancel the other branch's running action.
    if (actorAction) {
      const recipeDef = this.ctx.recipes.getByIndex(actorAction.recipe);
      if (recipeDef && recipeDef.type !== type) return false;
    }

    // Visible window walks outward from the actor and includes free
    // cards or cards in the actor's own action; stops at the first card
    // claimed by a different action.
    let visibleEnd = actorIdx;
    for (let j = actorIdx; j < chain.length; j++) {
      const cardActionId = claimedBy.get(chain[j]);
      const visible = cardActionId === undefined || cardActionId === actorActionId;
      if (visible) visibleEnd = j + 1;
      else break;
    }

    // Score every recipe of this type, skipping ones whose claim would
    // conflict with another action. Pick the highest-weight winner;
    // declaration order breaks ties (handled implicitly by the matcher's
    // first-wins-on-equal logic).
    let best: ActorMatch | null = null;
    for (const recipe of this.ctx.recipes.recipesOfType(type)) {
      const m = this.ctx.recipes.scoreRecipeForActor(recipe, chain, defs, actorIdx, visibleEnd);
      if (!m) continue;
      const blocked = m.claimed.some((id) => {
        const a = claimedBy.get(id);
        return a !== undefined && a !== actorActionId;
      });
      if (blocked) continue;
      if (!best || RecipeManager.compareWeight(m.weight, best.weight) > 0) best = m;
    }

    // Four-way decision. See class docs for the table.
    if (!actorAction && !best) return false;
    if (actorAction && !best) return true;     // server would cancel
    if (!actorAction && best) return true;     // server would start
    // Both present.
    if (actorAction!.recipe !== best!.recipe.index) return true; // upgrade
    // Same recipe at this actor — pre-filter says no-op. Slot-filler
    // identity changes are checked authoritatively on the server.
    return false;
  }

  private resolveDefinitions(
    chain: readonly number[],
  ): (CardDefinition | null)[] {
    const result: (CardDefinition | null)[] = new Array(chain.length);
    for (let i = 0; i < chain.length; i++) {
      const row = this.ctx.data.get("cards", chain[i]);
      if (!row) {
        result[i] = null;
        continue;
      }
      result[i] = this.ctx.definitions.decode(row.packedDefinition) ?? null;
    }
    return result;
  }

  /**
   * Collect the chain rooted at `rootId` walking in `direction`. Includes
   * the root as `chain[0]`; subsequent indices are the cards stacked in
   * that direction. Length 1 means "no stack in this direction" — the
   * root has no `stackedTop`/`stackedBottom` child as appropriate.
   */
  private collectChain(
    rootId: number,
    direction: StackDirection,
  ): number[] {
    const cards: CardManager = this.ctx.cards as CardManager;
    const result: number[] = [];
    let id = rootId;
    for (let i = 0; i < CHAIN_MAX_DEPTH; i++) {
      const card = cards.get(id);
      if (!card) break;
      result.push(id);
      const next = direction === "top" ? card.stackedTop : card.stackedBottom;
      if (next === 0) break;
      id = next;
    }
    return result;
  }
}
