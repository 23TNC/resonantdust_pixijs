import type { CardManager } from "../cards/CardManager";
import type { CardDefinition } from "../definitions/DefinitionManager";
import { RecipeManager, type ActorMatch } from "../definitions/RecipeManager";
import { getStackedState, STACKED_ON_HEX, STACKED_ON_RECT_X, STACKED_ON_RECT_Y } from "../cards/cardData";
import type { GameContext } from "../GameContext";
import { debug } from "../debug";
import type { Action as ActionRow, InventoryStack } from "../server/bindings/types";
import type { MagneticActionRow } from "../state/DataManager";
import type { ShadowedChange } from "../state/ShadowedStore";
import { packZoneId, type ZoneId } from "../zones/zoneId";
import { WORLD_LAYER } from "../world/worldCoords";
import { hasFlag, ACTION_FLAG_DYING, CARD_FLAG_DYING } from "../state/flags";

export interface CachedMagneticAction {
  magneticActionId: number;
  cardId: number;
  recipe: number;
  end: number;
  loopCount: number;
  receivedAt: number;
}

export type MagneticActionListener = (action: CachedMagneticAction | null) => void;

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

export type ActionListener = (action: CachedAction | null, completed?: boolean) => void;

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
  /** card_id → listeners for the server-authoritative action (fires before the display delay). */
  private readonly serverCardListeners = new Map<number, Set<ActionListener>>();

  /** magnetic_action_id → cached magnetic action. */
  private readonly magneticById = new Map<number, CachedMagneticAction>();
  /** card_id → magnetic_action_id. */
  private readonly magneticByCardId = new Map<number, number>();
  /** card_id → listeners waiting for that card's magnetic action to change. */
  private readonly magneticCardListeners = new Map<number, Set<MagneticActionListener>>();

  private readonly unsubStackChange: () => void;
  private readonly unsubActionData: () => void;
  private readonly unsubActionServerWrite: () => void;
  private readonly unsubActionServerDelete: () => void;
  private readonly unsubMagneticData: () => void;

  /** Server-authoritative action maps — updated immediately on server writes/deletes,
   *  bypassing the client display delay. Used by the upgrade pre-filter so we compare
   *  against what the server currently knows, not the delayed client view. */
  private readonly serverByActionId = new Map<number, CachedAction>();
  private readonly serverByCardId   = new Map<number, number>();

  constructor(
    private readonly ctx: GameContext,
    private readonly zoneId: ZoneId,
  ) {
    if (!ctx.cards) {
      throw new Error("[ActionManager] ctx.cards is null");
    }

    // Seed server-authoritative maps from the server map (no display delay).
    for (const row of ctx.data.actions.server.values()) {
      const rowZoneId = packZoneId(row.macroZone, row.layer);
      if (rowZoneId === zoneId || row.layer >= WORLD_LAYER) {
        this.upsertServer(row);
      }
    }

    // Seed client-delayed maps for visual display (subscribeCard / emitCard).
    let seedCount = 0;
    for (const row of ctx.data.values("actions")) {
      const rowZoneId = packZoneId((row as ActionRow).macroZone, (row as ActionRow).layer);
      if (rowZoneId === zoneId || (row as ActionRow).layer >= WORLD_LAYER) {
        this.upsert(row as ActionRow);
        seedCount++;
      }
    }
    debug.log(["actions"], `[ActionManager] initialized zone=${zoneId} seeded=${seedCount}`, 2);

    // Server writes: update server maps immediately so the pre-filter sees fresh state.
    this.unsubActionServerWrite = ctx.data.actions.subscribeServerWrite((row) => {
      const rowZoneId = packZoneId(row.macroZone, row.layer);
      if (rowZoneId === zoneId || row.layer >= WORLD_LAYER) {
        this.upsertServer(row);
      }
    });
    // Server deletes: update server maps immediately and trigger re-evaluation now
    // (rather than waiting for the display delay) so the server can restart recipes ASAP.
    this.unsubActionServerDelete = ctx.data.actions.subscribeServerDelete((_key, row) => {
      const rowZoneId = packZoneId(row.macroZone, row.layer);
      if (rowZoneId === zoneId || row.layer >= WORLD_LAYER) {
        this.removeServer(row);
      }
    });

    this.unsubActionData = ctx.data.subscribe("actions", (change) => {
      this.onActionChange(change as ShadowedChange<ActionRow>);
    });
    this.unsubStackChange = ctx.cards.subscribeAllStackChanges((rootId) => {
      this.onStackChange(rootId);
    });

    for (const row of ctx.data.values("magnetic_actions")) {
      const r = row as MagneticActionRow;
      if (packZoneId(r.macroZone, r.layer) === zoneId || r.layer >= WORLD_LAYER) {
        this.upsertMagnetic(r);
      }
    }
    this.unsubMagneticData = ctx.data.subscribe("magnetic_actions", (change) => {
      this.onMagneticChange(change as ShadowedChange<MagneticActionRow>);
    });
  }

  /** Subscribe to server-authoritative action changes for a specific card.
   *  Fires immediately with the current server action (if any), then on every
   *  server write or delete — bypassing the client display delay. Use this to
   *  show immediate visual feedback (e.g. a pending-flush progress bar) before
   *  the action becomes visible in the delayed client map. */
  subscribeServerCard(cardId: number, listener: ActionListener): () => void {
    let set = this.serverCardListeners.get(cardId);
    if (!set) {
      set = new Set();
      this.serverCardListeners.set(cardId, set);
    }
    set.add(listener);
    const actionId = this.serverByCardId.get(cardId);
    listener(actionId !== undefined ? this.serverByActionId.get(actionId) ?? null : null);
    return () => {
      const s = this.serverCardListeners.get(cardId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.serverCardListeners.delete(cardId);
    };
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

  /** Subscribe to magnetic action changes for a specific card. Fires immediately
   *  with the current magnetic action if one exists, then on every change.
   *  Returns an unsubscribe function. */
  subscribeMagneticCard(cardId: number, listener: MagneticActionListener): () => void {
    let set = this.magneticCardListeners.get(cardId);
    if (!set) {
      set = new Set();
      this.magneticCardListeners.set(cardId, set);
    }
    set.add(listener);

    const magneticActionId = this.magneticByCardId.get(cardId);
    const current = magneticActionId !== undefined
      ? this.magneticById.get(magneticActionId) ?? null
      : null;
    listener(current);

    return () => {
      const s = this.magneticCardListeners.get(cardId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.magneticCardListeners.delete(cardId);
    };
  }

  dispose(): void {
    debug.log(["actions"], `[ActionManager] disposed zone=${this.zoneId}`, 3);
    this.unsubStackChange();
    this.unsubActionData();
    this.unsubActionServerWrite();
    this.unsubActionServerDelete();
    this.unsubMagneticData();
    this.byActionId.clear();
    this.byCardId.clear();
    this.serverByActionId.clear();
    this.serverByCardId.clear();
    this.cardListeners.clear();
    this.serverCardListeners.clear();
    this.magneticById.clear();
    this.magneticByCardId.clear();
    this.magneticCardListeners.clear();
  }

  private onActionChange(change: ShadowedChange<ActionRow>): void {
    if (change.kind === "delete") {
      const old = change.oldValue;
      if (old) this.remove(old.actionId);
      return;
    }
    const row = change.newValue;
    if (!row) return;
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
    debug.log(["actions"], `[ActionManager] upsert actionId=${row.actionId} cardId=${row.cardId} recipe=${row.recipe} up=${action.participantsUp} down=${action.participantsDown}`, 2);
    this.byActionId.set(row.actionId, action);
    this.byCardId.set(row.cardId, row.actionId);
    this.emitCard(row.cardId, action);
  }

  private remove(actionId: number): void {
    const action = this.byActionId.get(actionId);
    if (!action) return;
    debug.log(["actions"], `[ActionManager] remove actionId=${actionId} cardId=${action.cardId}`, 2);
    this.byActionId.delete(actionId);
    const reverseId = this.byCardId.get(action.cardId);
    if (reverseId === actionId) {
      this.byCardId.delete(action.cardId);
      this.emitCard(action.cardId, null);
    }
    // Re-evaluation is triggered by removeServer (server delete), not here.
    // If reverseId !== actionId, a newer action already claimed this card;
    // don't emit null — that would clobber a valid running action.
  }

  private upsertServer(row: ActionRow): void {
    const previous = this.serverByActionId.get(row.actionId);
    if (previous && previous.cardId !== row.cardId) {
      const reverseId = this.serverByCardId.get(previous.cardId);
      if (reverseId === row.actionId) this.serverByCardId.delete(previous.cardId);
    }
    const action: CachedAction = {
      actionId: row.actionId,
      cardId: row.cardId,
      recipe: row.recipe,
      participantsUp: (row.participants >> 4) & 0x0F,
      participantsDown: row.participants & 0x0F,
    };
    this.serverByActionId.set(row.actionId, action);
    this.serverByCardId.set(row.cardId, row.actionId);
    this.emitServerCard(row.cardId, action);
  }

  private removeServer(row: ActionRow): void {
    const action = this.serverByActionId.get(row.actionId);
    if (!action) return;
    this.serverByActionId.delete(row.actionId);
    const reverseId = this.serverByCardId.get(action.cardId);
    if (reverseId !== row.actionId) return;
    this.serverByCardId.delete(action.cardId);
    this.emitServerCard(action.cardId, null, hasFlag(row.flags, ACTION_FLAG_DYING));
    // Defer re-evaluation so all changes in the current SpacetimeDB transaction
    // batch are applied first. Check the server card map (not the delayed client
    // map) so a card marked dying in the same transaction is seen immediately.
    const cardId = action.cardId;
    queueMicrotask(() => {
      const cardRow = this.ctx.data.cards.server.get(cardId);
      if (cardRow && !hasFlag(cardRow.flags, CARD_FLAG_DYING)) {
        this.onStackChange(this.findChainRoot(cardId));
      }
    });
  }

  /** Walk parent links (STACKED_ON_RECT_X/Y) up to the chain root. Cards that
   *  are loose or on a hex are already roots and return immediately. */
  private findChainRoot(cardId: number): number {
    let id = cardId;
    for (let i = 0; i < CHAIN_MAX_DEPTH; i++) {
      const row = this.ctx.data.get("cards", id);
      if (!row) break;
      const stacked = getStackedState(row.microZone);
      if (stacked !== STACKED_ON_RECT_X && stacked !== STACKED_ON_RECT_Y) break;
      id = row.microLocation;
    }
    return id;
  }

  private emitServerCard(cardId: number, action: CachedAction | null, completed?: boolean): void {
    const listeners = this.serverCardListeners.get(cardId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(action, completed);
      } catch (err) {
        console.error("[ActionManager] serverCard listener threw", err);
      }
    }
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

    debug.log(["actions"], `[ActionManager] onStackChange root=${rootId} up=[${top.join(",")}] down=[${bottom.join(",")}]`, 5);

    let needsSubmit = false;
    if (top.length >= 1) needsSubmit = this.evaluateBranch(top, "up") || needsSubmit;
    if (bottom.length >= 1) needsSubmit = this.evaluateBranch(bottom, "down") || needsSubmit;

    if (!needsSubmit) {
      // Force submit when the server is already tracking world position (any
      // stack change there must propagate), or when the client has placed the
      // root on the world while an action is already running on it.
      const serverRow = this.ctx.data.cards.server.get(rootId);
      const clientRow = this.ctx.data.get("cards", rootId);
      const serverWorld = serverRow !== undefined && serverRow.layer >= WORLD_LAYER;
      const clientWorldWithAction = clientRow !== undefined && clientRow.layer >= WORLD_LAYER && this.byCardId.has(rootId);
      if (!serverWorld && !clientWorldWithAction) {
        debug.log(["actions"], `[ActionManager] root=${rootId} — no change needed, skipping submit`, 4);
        return;
      }
      debug.log(["actions"], `[ActionManager] root=${rootId} — forcing world submit (serverWorld=${serverWorld} clientWorldWithAction=${clientWorldWithAction})`, 3);
    }

    // The server mirrors whatever (layer, macroZone, microZone,
    // microLocation) we send onto the root's row verbatim, then
    // derives the children's row state from the chain composition.
    // Pull the root's current local view to populate the position
    // fields. If the root row is gone (drag-induced race), bail —
    // the next stack-change tick will retry with fresh data.
    const rootRow = this.ctx.data.get("cards", rootId);
    if (!rootRow) {
      debug.log(["actions"], `[ActionManager] root=${rootId} — row missing, skipping submit`, 4);
      return;
    }
    debug.log(["actions"], `[ActionManager] root=${rootId} — submitting stack (state=${rootRow.microZone & 0b11} parent=${rootRow.microLocation})`, 3);
    const stack: InventoryStack = {
      root: rootId,
      layer: rootRow.layer,
      macroZone: rootRow.macroZone,
      microZone: rootRow.microZone,
      microLocation: rootRow.microLocation,
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
  private evaluateBranch(chain: readonly number[], direction: "up" | "down"): boolean {
    const defs = this.resolveDefinitions(chain);
    const hexDef = this.resolveHexDef(chain);
    debug.log(["actions"], `[ActionManager] evaluateBranch direction=${direction} chain=[${chain.join(",")}] defs=[${defs.map(d => d?.key ?? "null").join(",")}] hexDef=${hexDef?.key ?? "none"}`, 1);
    const claimedBy = this.buildClaimedMap(chain, direction);
    let needsSubmit = false;
    for (let actorIdx = 0; actorIdx < chain.length; actorIdx++) {
      if (this.evaluateActorCandidate(chain, defs, actorIdx, direction, claimedBy, hexDef)) {
        needsSubmit = true;
      }
    }
    return needsSubmit;
  }

  /** Resolve the hex card definition for chain[0] if it is mounted on a hex
   *  (stackedState == STACKED_ON_HEX). Returns null for loose or rect-stacked roots. */
  private resolveHexDef(chain: readonly number[]): CardDefinition | null {
    if (chain.length === 0) return null;
    const rootRow = this.ctx.data.get("cards", chain[0]);
    if (!rootRow) return null;
    if (getStackedState(rootRow.microZone) !== STACKED_ON_HEX) return null;
    const hexRow = this.ctx.data.get("cards", rootRow.microLocation);
    if (!hexRow) return null;
    return this.ctx.definitions.decode(hexRow.packedDefinition) ?? null;
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
    direction: "up" | "down",
  ): Map<number, number> {
    const map = new Map<number, number>();
    for (let i = 0; i < chain.length; i++) {
      const actionId = this.serverByCardId.get(chain[i]);
      if (actionId === undefined) continue;
      const action = this.serverByActionId.get(actionId);
      if (!action) continue;
      const count = direction === "up" ? action.participantsUp : action.participantsDown;
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
    direction: "up" | "down",
    claimedBy: Map<number, number>,
    hexDef: CardDefinition | null,
  ): boolean {
    const actorId = chain[actorIdx];
    const actorActionId = this.serverByCardId.get(actorId);
    const actorAction = actorActionId !== undefined
      ? this.serverByActionId.get(actorActionId) ?? null
      : null;

    if (actorAction && actorAction.cardId !== actorId) {
      debug.log(["actions"], `[ActionManager] card=${actorId} skip — slot filler in action=${actorActionId}`, 1);
      return false;
    }

    if (actorAction) {
      const recipeDef = this.ctx.recipes.decode(actorAction.recipe);
      if (recipeDef && (recipeDef.type !== "stack" || recipeDef.direction !== direction)) {
        debug.log(["actions"], `[ActionManager] card=${actorId} skip — action belongs to other branch (${recipeDef.type}:${recipeDef.direction})`, 1);
        return false;
      }
    }

    let visibleEnd = actorIdx;
    for (let j = actorIdx; j < chain.length; j++) {
      const cardActionId = claimedBy.get(chain[j]);
      const visible = cardActionId === undefined || cardActionId === actorActionId;
      if (visible) visibleEnd = j + 1;
      else break;
    }

    debug.log(["actions"], `[ActionManager] card=${actorId} actorIdx=${actorIdx} direction=${direction} visibleEnd=${visibleEnd} candidateRecipes=${this.ctx.recipes.recipesOfType("stack", direction).length}`, 1);

    let best: ActorMatch | null = null;
    for (const recipe of this.ctx.recipes.recipesOfType("stack", direction)) {
      const m = this.ctx.recipes.scoreRecipeForActor(recipe, chain, defs, actorIdx, visibleEnd, hexDef);
      if (!m) {
        debug.log(["actions"], `[ActionManager]   recipe "${recipe.id}" — no match`, 1);
        continue;
      }
      const blocked = m.claimed.some((id) => {
        const a = claimedBy.get(id);
        return a !== undefined && a !== actorActionId;
      });
      if (blocked) {
        debug.log(["actions"], `[ActionManager]   recipe "${recipe.id}" — blocked by claim conflict`, 1);
        continue;
      }
      debug.log(["actions"], `[ActionManager]   recipe "${recipe.id}" — matched weight={tile:${m.weight.tile} root:${m.weight.root} slot:${m.weight.slot}}`, 1);
      if (!best || RecipeManager.compareWeight(m.weight, best.weight) > 0) best = m;
    }

    debug.log(["actions"], `[ActionManager] card=${actorId} best=${best?.recipe.id ?? "none"} currentAction=${actorAction?.recipe ?? "none"}`, 1);

    if (!actorAction && !best) return false;
    if (actorAction && !best) return true;
    if (!actorAction && best) return true;
    if (actorAction!.recipe !== best!.recipe.packed) return true;
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

  private onMagneticChange(change: ShadowedChange<MagneticActionRow>): void {
    if (change.kind === "delete") {
      const old = change.oldValue;
      if (old) this.removeMagnetic(old.magneticActionId, old.cardId);
      return;
    }
    const row = change.newValue;
    if (!row) return;
    this.upsertMagnetic(row);
  }

  private upsertMagnetic(row: MagneticActionRow): void {
    const cached: CachedMagneticAction = {
      magneticActionId: row.magneticActionId,
      cardId: row.cardId,
      recipe: row.recipe,
      end: row.end,
      loopCount: row.loopCount,
      receivedAt: this.ctx.data.magneticActions.getReceivedAt(row.magneticActionId) ?? Date.now() / 1000,
    };
    this.magneticById.set(row.magneticActionId, cached);
    this.magneticByCardId.set(row.cardId, row.magneticActionId);
    this.emitMagneticCard(row.cardId, cached);
  }

  private removeMagnetic(magneticActionId: number, cardId: number): void {
    this.magneticById.delete(magneticActionId);
    if (this.magneticByCardId.get(cardId) === magneticActionId) {
      this.magneticByCardId.delete(cardId);
      this.emitMagneticCard(cardId, null);
    }
  }

  private emitMagneticCard(cardId: number, action: CachedMagneticAction | null): void {
    const listeners = this.magneticCardListeners.get(cardId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(action);
      } catch (err) {
        console.error("[ActionManager] magnetic card listener threw", err);
      }
    }
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
