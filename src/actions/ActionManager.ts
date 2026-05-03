import type { CardManager } from "../cards/CardManager";
import type { CardDefinition } from "../definitions/DefinitionManager";
import type { RecipeType } from "../definitions/RecipeManager";
import type { GameContext } from "../GameContext";
import type { Action as ActionRow, InventoryStack } from "../server/bindings/types";
import type { ShadowedChange } from "../state/ShadowedStore";
import { packZoneId, type ZoneId } from "../zones/zoneId";

export interface CachedAction {
  actionId: number;
  cardId: number;
  /** Required top-stack chain length. 0 means no top requirement. */
  participantsUp: number;
  /** Required bottom-stack chain length. 0 means no bottom requirement. */
  participantsDown: number;
}

export type ActionListener = (action: CachedAction | null) => void;

type StackDirection = "top" | "bottom";

const CHAIN_MAX_DEPTH = 64;

/**
 * Owns two responsibilities, both driven by `CardManager.subscribeStackChange`:
 *
 *   1. **Cancel broken recipes.** For every actor in an affected chain,
 *      check whether the chain length still meets `Action.participants`;
 *      if not, ask `SpacetimeManager.cancelRecipe`.
 *   2. **Detect newly-valid recipes.** Run `RecipeManager.match` against
 *      the affected chain to find any recipe whose slot window now fits.
 *      The actual recipe start happens server-side via
 *      `submit_inventory_stacks`; this is detection-only — for UI hints
 *      and debugging.
 *
 * Stack roots can have both a top and a bottom branch ("Y" of children),
 * so on every event we walk each direction independently:
 *   - `top_stack` recipes match against `[root, …stackedTop walk]`.
 *   - `bottom_stack` recipes match against `[root, …stackedBottom walk]`.
 *   - Cancel checks each direction's chain separately, so an actor at
 *     root counts the longer of its two branches.
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
    if (reverseId === actionId) this.byCardId.delete(action.cardId);
    this.emitCard(action.cardId, null);
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
   * Walks both branches of the affected root and:
   *   - cancels actions whose actors no longer have enough chain to satisfy
   *     their direction-specific `participantsUp` / `participantsDown`.
   *   - detects whether the new shape of either branch matches a recipe
   *     and logs the match (server still does the actual start).
   */
  private onStackChange(rootId: number): void {
    const top = this.collectChain(rootId, "top");
    const bottom = this.collectChain(rootId, "bottom");

    if (this.byCardId.size > 0) {
      const stack: InventoryStack = {
        root: rootId,
        stackUp: top.slice(1),
        stackDown: bottom.slice(1),
      };
      this.checkCancels(top, "top", stack);
      this.checkCancels(bottom, "bottom", stack);
    }

    if (top.length >= 2) this.detectRecipe(top, "top_stack");
    if (bottom.length >= 2) this.detectRecipe(bottom, "bottom_stack");
  }

  /**
   * For each actor in `chain`, cancel its action if the chain has shrunk
   * below the required length for this direction. A required length of 0
   * means no constraint in that direction — those actors are skipped.
   */
  private checkCancels(chain: readonly number[], direction: StackDirection, stack: InventoryStack): void {
    if (chain.length === 0) return;
    for (const cardId of chain) {
      const actionId = this.byCardId.get(cardId);
      if (actionId === undefined) continue;
      const action = this.byActionId.get(actionId);
      if (!action) continue;
      const required = direction === "top" ? action.participantsUp : action.participantsDown;
      if (required > 0 && chain.length < required) {
        console.log(
          `[ActionManager] cancel action=${action.actionId} reason="${direction} chain too short: ${chain.length} < ${required}"`,
        );
        this.ctx.spacetime.cancelRecipe(action.actionId, stack);
      }
    }
  }

  private detectRecipe(chain: readonly number[], type: RecipeType): void {
    const defs = this.resolveDefinitions(chain);
    const match = this.ctx.recipes.match(defs, type);
    if (!match) return;

    // Skip if any card in the matched slot window is already in a running
    // action — those cards are occupied and can't start a new recipe.
    const slotEnd = match.actorPos + match.recipe.slots.length;
    for (let i = match.actorPos; i < slotEnd; i++) {
      if (this.byCardId.has(chain[i])) return;
    }

    // Build the complete resulting stack state from the root.
    const rootId = chain[0];
    const topBranch = this.collectChain(rootId, "top");
    const bottomBranch = this.collectChain(rootId, "bottom");

    // stackUp and stackDown exclude the root (index 0 is root in collectChain).
    const inventoryStack = {
      root: rootId,
      stackUp: topBranch.slice(1),
      stackDown: bottomBranch.slice(1),
    };

    console.log(
      `[ActionManager] submit recipe="${match.recipe.id}" type=${type} actor=${chain[match.actorPos]} root=${rootId}`,
    );
    void this.ctx.spacetime.submitStacks([inventoryStack]);
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
