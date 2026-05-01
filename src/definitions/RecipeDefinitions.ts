import {
  client_cards, type CardId, CARD_FLAG_SLOT_HOLD,
} from "@/spacetime/Data";
import { getDefinitionByPacked, type CardDefinition } from "@/definitions/CardDefinitions";

// ── Raw JSON shapes ───────────────────────────────────────────────────────────
//
// The recipe JSON schema is documented in RECIPE_REDESIGN.md.  This file
// implements the adjacency matcher and the public API consumed by
// ActionCoordinator and DragController.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawEntity = any;

interface RawRecipe {
  id:        string;
  type?:     string;
  /** Optional precondition on the root card (chain index 0). */
  root?:     RawEntity;
  /** Ordered slot entities — one per chain position outward from the actor. */
  slots?:    RawEntity[];
  /** Chain indexes consumed at completion.  0 = root, 1+ = chain positions. */
  reagents?: number[];
  /** Object keyed by destination, each value an array of entities. */
  products?: Partial<Record<ProductTarget, RawEntity[]>>;
  /** [direction, leftColor, rightColor] — colors are hex strings or "default". */
  style?:    [string, string, string];
  /** Fixed seconds, or [[seconds, entity?], ...] conditional list. */
  duration:  number | (number | [number, RawEntity?])[];
}

// ── Parsed entity tree ────────────────────────────────────────────────────────

export interface EntityLeaf  { kind: "leaf"; defId: string; qty: number; }
export interface EntityAnd   { kind: "and"; a: RecipeEntity; b: RecipeEntity; }
export interface EntityOr    { kind: "or"; a: RecipeEntity; weights: [number, number]; b: RecipeEntity; }
export interface EntityEmpty { kind: "empty"; }

export type RecipeEntity = EntityLeaf | EntityAnd | EntityOr | EntityEmpty;

export interface DurationCondition {
  duration:   number;
  /** Undefined means this entry always matches (catch-all). */
  condition?: RecipeEntity;
}

export type RecipeDuration = number | DurationCondition[];

export type ProductTarget =
  | "actor_panel"
  | "root_panel"
  | "actor_world"
  | "root_owner_world"
  | "root_world";

export interface ProductGroup {
  target: ProductTarget;
  entity: RecipeEntity;
}

export interface RecipeStyle {
  direction:  "ltr" | "rtl";
  leftColor:  string;
  rightColor: string;
}

export interface Recipe {
  id:          string;
  /** 0-based wire index — the value stored in Action::recipe. */
  index:       number;
  /** "top_stack" | "bottom_stack" | "on_create" | "explicit". */
  recipeType:  string;
  /** Optional precondition on chain[0]. */
  root?:       RecipeEntity;
  /** Ordered slot entities; slot[i] matches chain[actorIndex + i]. */
  slots:       RecipeEntity[];
  /** Chain indexes consumed.  Sorted, deduped. */
  reagents:    number[];
  products:    ProductGroup[];
  style?:      RecipeStyle;
  duration:    RecipeDuration;
}

// ── Match weights ─────────────────────────────────────────────────────────────
// Higher = more specific.  Matched recipes at the same chain position are
// ranked by their summed weights.

const WEIGHT_DEF_ID = 4;
const WEIGHT_ASPECT = 3;
const WEIGHT_ANY    = 1;

// ── Registry ──────────────────────────────────────────────────────────────────

const byId    = new Map<string, Recipe>();
const byIndex = new Map<number, Recipe>();

// ── Parsing ───────────────────────────────────────────────────────────────────

function parseEntity(raw: RawEntity): RecipeEntity {
  // Bare string: "defId" → leaf with qty 1.  Allows strings as OR branches.
  if (typeof raw === "string") {
    return { kind: "leaf", defId: raw, qty: 1 };
  }

  if (!Array.isArray(raw) || raw.length === 0) return { kind: "empty" };

  // OR form: [A, [wa, wb], C] — middle element is a number-array (including []).
  if (raw.length === 3 && Array.isArray(raw[1]) && raw[1].every((x: unknown) => typeof x === "number")) {
    const rawW = raw[1] as number[];
    const weights: [number, number] =
      rawW.length === 2 ? [rawW[0], rawW[1]] : [1, 1];
    return {
      kind: "or",
      a:    parseEntity(raw[0]),
      weights,
      b:    parseEntity(raw[2]),
    };
  }

  // Leaf: ["defId"] or ["defId", qty] — qty applies to aspect leaves.
  if (typeof raw[0] === "string") {
    return { kind: "leaf", defId: raw[0], qty: typeof raw[1] === "number" ? raw[1] : 1 };
  }

  // AND form: [A, B] or [A, B, []]
  return {
    kind: "and",
    a:    parseEntity(raw[0]),
    b:    raw.length >= 2 ? parseEntity(raw[1]) : { kind: "empty" },
  };
}

function parseDuration(raw: number | (number | [number, RawEntity?])[]): RecipeDuration {
  if (typeof raw === "number") return raw;
  return raw.map(entry => {
    if (typeof entry === "number") return { duration: entry };
    const [duration, condRaw] = entry;
    const condition = condRaw != null && Array.isArray(condRaw) && condRaw.length > 0
      ? parseEntity(condRaw)
      : undefined;
    return { duration, condition };
  });
}

function normaliseProductTarget(key: string): ProductTarget | null {
  switch (key) {
    case "actor_panel":      return "actor_panel";
    case "root_panel":       return "root_panel";
    case "actor_world":      return "actor_world";
    case "root_owner_world": return "root_owner_world";
    case "root_world":       return "root_world";
    // Legacy aliases — accepted with warning until cleanup sweep.
    case "owner": return "actor_panel";
    case "root":  return "root_panel";
    case "world": return "root_world";
    default:      return null;
  }
}

function parseRecipe(raw: RawRecipe, index: number): Recipe {
  const slots: RecipeEntity[] = (raw.slots ?? []).map(parseEntity);

  // Sort + dedupe reagent indices; warn on out-of-range entries.
  const maxChainIdx = slots.length + 1;  // root + slots
  const reagents = Array.from(new Set(raw.reagents ?? [])).sort((a, b) => a - b);
  for (const r of reagents) {
    if (r < 0 || r >= maxChainIdx) {
      console.warn(`recipe '${raw.id}': reagent index ${r} out of range (max ${maxChainIdx - 1})`);
    }
  }

  const r: Recipe = {
    id:         raw.id,
    index,
    recipeType: raw.type ?? "on_create",
    root:       raw.root != null ? parseEntity(raw.root) : undefined,
    slots,
    reagents,
    products:   [],
    duration:   parseDuration(raw.duration),
  };

  if (raw.products) {
    for (const [key, entities] of Object.entries(raw.products)) {
      const target = normaliseProductTarget(key);
      if (!target) {
        console.warn(`recipe '${raw.id}': unknown product target '${key}'`);
        continue;
      }
      if (!Array.isArray(entities)) continue;
      for (const e of entities) {
        r.products.push({ target, entity: parseEntity(e) });
      }
    }
  }

  if (raw.style) {
    const [dir, left, right] = raw.style;
    r.style = {
      direction:  dir === "rtl" ? "rtl" : "ltr",
      leftColor:  left  ?? "default",
      rightColor: right ?? "default",
    };
  }
  return r;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export function bootstrapRecipeDefinitions(): void {
  if (byId.size > 0) return;

  const files = import.meta.glob<RawRecipe[]>("../data/recipes/*.json", {
    eager:  true,
    import: "default",
  });

  let globalIndex = 0;
  for (const raw of Object.values(files)) {
    if (!Array.isArray(raw)) continue;
    for (const rawRecipe of raw) {
      const recipe = parseRecipe(rawRecipe, globalIndex++);
      byId.set(recipe.id, recipe);
      byIndex.set(recipe.index, recipe);
    }
  }
}

export function getRecipeById(id: string):       Recipe | undefined { return byId.get(id); }
export function getRecipeByIndex(index: number): Recipe | undefined { return byIndex.get(index); }
export function getAllRecipes(): ReadonlyMap<string, Recipe>          { return byId; }

/**
 * Determine the actor's chain index for a recipe.
 *
 * - `on_create` / `explicit`: actor IS the root at chain[0].
 * - `top_stack` / `bottom_stack`:
 *   - With an explicit `root` precondition → actor at chain[1] (root and
 *     actor are distinct chain positions).
 *   - Without a `root` precondition → actor at chain[0]; the chain root
 *     IS the actor and slots match outward from there.  Whether root is
 *     consumed is then controlled by listing `0` in `reagents`.
 *
 * Mirrors `actor_index_for(recipe: &RecipeDef)` in the Rust matcher.
 */
export function actorIndexFor(recipe: Recipe): number {
  switch (recipe.recipeType) {
    case "top_stack":
    case "bottom_stack":
      return recipe.root !== undefined ? 1 : 0;
    default:
      return 0;
  }
}

// ── Adjacency matching ────────────────────────────────────────────────────────

/** Match a single entity against a card definition.  Returns weight or null. */
export function matchEntityCard(entity: RecipeEntity, def: CardDefinition): number | null {
  switch (entity.kind) {
    case "empty":
      return 0;
    case "leaf": {
      // Aspect-with-qty: card's aspect value must meet the threshold.
      if (entity.qty > 1) {
        const val = def.aspects?.[entity.defId] ?? 0;
        return val >= entity.qty ? WEIGHT_ASPECT : null;
      }
      if (entity.defId === "any")        return WEIGHT_ANY;
      if (def.id === entity.defId)       return WEIGHT_DEF_ID;
      if (def.aspects && entity.defId in def.aspects) return WEIGHT_ASPECT;
      return null;
    }
    case "and": {
      const wa = matchEntityCard(entity.a, def); if (wa === null) return null;
      const wb = matchEntityCard(entity.b, def); if (wb === null) return null;
      return wa + wb;
    }
    case "or": {
      const wa = matchEntityCard(entity.a, def);
      const wb = matchEntityCard(entity.b, def);
      if (wa === null && wb === null) return null;
      return Math.max(wa ?? 0, wb ?? 0);
    }
  }
}

export interface RecipeMatchResult {
  weight:           number;
  /** card_ids of cards at chain positions named by recipe.reagents. */
  reagentCardIds:   readonly CardId[];
  /** All chain positions claimed by this match (root + slot range). */
  claimedCardIds:   readonly CardId[];
}

/**
 * Try to match a recipe at a specific chain position.  `chain` is the
 * ordered card_id list from root (index 0) outward.  Returns null if any
 * slot doesn't match, the chain is too short, or any candidate has
 * `CARD_FLAG_SLOT_HOLD` set (claimed by another action).
 */
export function tryMatchRecipeAt(
  recipe:     Recipe,
  chain:      readonly CardId[],
  actorIndex: number,
): RecipeMatchResult | null {
  if (chain.length === 0) return null;

  let weight = 0;

  // Root precondition.
  if (recipe.root) {
    const rootCard = client_cards[chain[0]];
    if (!rootCard) return null;
    const rootDef = getDefinitionByPacked(rootCard.packed_definition);
    if (!rootDef) return null;
    const w = matchEntityCard(recipe.root, rootDef);
    if (w === null) return null;
    weight += w;
  }

  // Slots fit?
  if (actorIndex + recipe.slots.length > chain.length) return null;

  // Per-slot positional check; bail on mismatch or held card.
  for (let slot_i = 0; slot_i < recipe.slots.length; slot_i++) {
    const card_id = chain[actorIndex + slot_i];
    const card    = client_cards[card_id];
    if (!card) return null;
    if (card.flags & CARD_FLAG_SLOT_HOLD) return null;
    const def = getDefinitionByPacked(card.packed_definition);
    if (!def) return null;
    const w = matchEntityCard(recipe.slots[slot_i], def);
    if (w === null) return null;
    weight += w;
  }

  // Build reagent card_id list in recipe order.
  const reagentCardIds: CardId[] = [];
  for (const idx of recipe.reagents) {
    if (idx < 0 || idx >= chain.length) return null;
    reagentCardIds.push(chain[idx]);
  }

  // Claimed range — root (if recipe declared one) plus the slot window.
  const claimedCardIds: CardId[] = [];
  if (recipe.root) claimedCardIds.push(chain[0]);
  for (let i = 0; i < recipe.slots.length; i++) claimedCardIds.push(chain[actorIndex + i]);

  return { weight, reagentCardIds, claimedCardIds };
}

// ── Priority selection ────────────────────────────────────────────────────────

/**
 * Activation result for ActionCoordinator: a chosen recipe + the actor card
 * (the chain position that gets the Action row + progress bar) + the full
 * set of claimed cards (so the cancel-on-shrink check can detect when any
 * leave the chain).
 */
export interface RecipeActivation {
  recipe:        Recipe;
  actorCardId:   CardId;
  /** All cards claimed by the recipe (root + slot range).  Used by
   *  ActionCoordinator to detect cancel-on-shrink. */
  claimedCardIds: readonly CardId[];
}

/**
 * Greedy adjacency-based recipe selection.
 *
 * Walks `chain` from the earliest valid actor position; at each position
 * picks the highest-weight matching recipe of `recipeType`, advances past
 * the matched window, and repeats.  Skips chain positions whose card has
 * `CARD_FLAG_SLOT_HOLD` (already claimed by another action).
 *
 * `isExcluded(actorCardId, recipeIndex)` lets the caller veto specific
 * activations — used to suppress recipes already running on the same actor
 * so they aren't double-started.
 */
export function selectGreedy(
  recipeType:  string,
  chain:       readonly CardId[],
  isExcluded?: (actorCardId: CardId, recipeIndex: number) => boolean,
): RecipeActivation[] {
  const results: RecipeActivation[] = [];
  if (chain.length === 0) return results;

  // Walk every chain position so root-less recipes (actor_index = 0) get a
  // chance at chain[0]; rooted recipes opt out via the eligibility check.
  let startIndex = 0;

  while (startIndex < chain.length) {
    let best: RecipeActivation | null = null;
    let bestWeight = -1;

    for (const recipe of byId.values()) {
      if (recipe.recipeType !== recipeType) continue;
      // Phase 9 eligibility: rooted recipes only fire at startIndex >= 1
      // (root sits at chain[0], slot window outward).  Root-less recipes
      // only fire at startIndex == 0 (chain root IS the actor).
      const eligible = recipe.root !== undefined ? startIndex >= 1 : startIndex === 0;
      if (!eligible) continue;

      const actorCardId = chain[startIndex];
      if (isExcluded?.(actorCardId, recipe.index)) continue;

      const result = tryMatchRecipeAt(recipe, chain, startIndex);
      if (!result) continue;
      if (result.weight > bestWeight) {
        bestWeight = result.weight;
        best = {
          recipe,
          actorCardId,
          claimedCardIds: result.claimedCardIds,
        };
      }
    }

    if (best === null) {
      startIndex += 1;
      continue;
    }

    results.push(best);
    startIndex += best.recipe.slots.length;
    if (best.recipe.slots.length === 0) startIndex += 1;       // empty-slot recipe (on_create-style); always advance
  }

  return results;
}

// ── Validation helpers (kept for compatibility) ───────────────────────────────

/** True if the recipe matches `chain` at its natural actor position. */
export function validateRecipe(recipe: Recipe, chain: readonly CardId[]): boolean {
  const ai = actorIndexFor(recipe);
  return tryMatchRecipeAt(recipe, chain, ai) !== null;
}

export function matchesInputs(recipeId: string, chain: readonly CardId[]): boolean {
  const recipe = byId.get(recipeId);
  return recipe ? validateRecipe(recipe, chain) : false;
}

export function findMatchingRecipes(recipeType: string, chain: readonly CardId[]): Recipe[] {
  const out: Recipe[] = [];
  for (const recipe of byId.values()) {
    if (recipe.recipeType !== recipeType) continue;
    if (validateRecipe(recipe, chain)) out.push(recipe);
  }
  return out;
}
