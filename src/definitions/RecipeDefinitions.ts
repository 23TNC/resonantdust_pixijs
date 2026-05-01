import {
  client_cards, client_zones, macro_location_cards,
  stacked_up_children, stacked_down_children, SURFACE_WORLD, CARD_TYPE_TILE,
  surfaceFromMacro, localQFromMicro, localRFromMicro,
  type CardId,
} from "@/spacetime/Data";
import { getDefinitionByPacked, type CardDefinition } from "@/definitions/CardDefinitions";

// ── Raw JSON shapes ───────────────────────────────────────────────────────────

type RawEntity = any[];

interface RawRecipe {
  id:        string;
  type?:     string;
  tile?:     RawEntity;
  catalysts?: RawEntity;
  reagents?:  RawEntity;
  /** Object keyed by target ("owner" | "root"), each value a raw entity. */
  products?:  Partial<Record<"owner" | "root", RawEntity>>;
  /** [direction, leftColor, rightColor] — colors are hex strings or "default". */
  style?:     [string, string, string];
  /** Fixed seconds, or [[seconds, entity?], ...] conditional list (first match wins; no entity = catch-all). A bare number in the array is a catch-all default. */
  duration:   number | (number | [number, RawEntity?])[];
}

// ── Parsed entity tree ────────────────────────────────────────────────────────

/**
 * A leaf requirement: a card definition id (e.g. "corpus"), "any", or a
 * future aspect id. qty is the number of cards/aspect-points required.
 */
export interface EntityLeaf  { kind: "leaf"; defId: string; qty: number; }

/**
 * Both sub-entities must be satisfied (AND).
 * Parsed from [A, B] or [A, B, []] in JSON.
 */
export interface EntityAnd   { kind: "and"; a: RecipeEntity; b: RecipeEntity; }

/**
 * Either sub-entity satisfies the requirement (OR).
 * Parsed from [A, [wa, wb], C] in JSON. For products, weights govern the
 * probability of choosing A vs C; for inputs, weights are ignored.
 */
export interface EntityOr    { kind: "or"; a: RecipeEntity; weights: [number, number]; b: RecipeEntity; }

/** No requirement — always satisfied, produces nothing. */
export interface EntityEmpty { kind: "empty"; }

export type RecipeEntity = EntityLeaf | EntityAnd | EntityOr | EntityEmpty;

export interface DurationCondition {
  duration:   number;
  /** Undefined means this entry always matches (catch-all). */
  condition?: RecipeEntity;
}

/** Fixed duration in seconds, or a prioritised condition list (first match wins). */
export type RecipeDuration = number | DurationCondition[];

export interface Recipe {
  id:          string;
  /** 0-based position across all recipe files (the wire format sent to spacetime). */
  index:       number;
  /** Recipe type string matching the server enum: "top_stack", "bottom_stack", "both_stack", "on_create", "explicit". */
  recipeType:  string;
  /** If present, the stack must be on a matching tile. */
  tile?:       RecipeEntity;
  /** Required cards that are NOT consumed when the recipe fires. */
  catalysts?:  RecipeEntity;
  /** Required cards that ARE consumed when the recipe fires. */
  reagents?:   RecipeEntity;
  /** Cards produced by the recipe. Each group is produced independently; OR nodes use weights for random selection. */
  products?:   ProductGroup[];
  style?:      RecipeStyle;
  duration:    RecipeDuration;
}

export interface ProductGroup {
  /** Where produced cards are placed: "owner" = owner_id panel, "root" = card_id panel. */
  target: "owner" | "root";
  entity: RecipeEntity;
}

export interface RecipeStyle {
  direction:  "ltr" | "rtl";
  /** Hex color string or "default" (use the card's title bar color). */
  leftColor:  string;
  /** Hex color string or "default" (use the card's title bar color). */
  rightColor: string;
}

// ── Registry ──────────────────────────────────────────────────────────────────

const byId    = new Map<string, Recipe>();
const byIndex = new Map<number, Recipe>();

// ── Match weights ─────────────────────────────────────────────────────────────
// Higher weight = higher priority when multiple recipes match the same stack.
//
//   tile exact    (16) — recipe specifies the current tile's exact def id
//   tile any       (4) — recipe accepts any tile (just requires world surface)
//   card def id    (4) — card matched by its definition id ("corpus", etc.)
//   card aspect    (3) — card matched by an aspect key ("labor", etc.)
//   card_type      (2) — reserved for future entity syntax
//   any            (1) — matched by the "any" wildcard
//
// Tile weight is set above the max achievable card weight so that a recipe
// requiring the current tile is always preferred over one that ignores it.

const WEIGHT_TILE   = 16;
const WEIGHT_DEF_ID =  4;
const WEIGHT_ASPECT =  3;
// const WEIGHT_CARD_TYPE = 2;  // reserved
const WEIGHT_ANY    =  1;




// ── Parsing ───────────────────────────────────────────────────────────────────

function parseEntity(raw: any): RecipeEntity {
  // Bare string: "defId" → leaf with qty 1.  Allows strings as OR branches.
  if (typeof raw === "string") {
    return { kind: "leaf", defId: raw, qty: 1 };
  }

  if (!Array.isArray(raw) || raw.length === 0) return { kind: "empty" };

  // OR form: [A, [wa, wb], C]  —  middle element is the weights array ([] for equal).
  // Detected by: length === 3 AND raw[1] is an array whose elements are all numbers.
  // This must come before the string-leaf check so "defId" branches are supported.
  if (raw.length === 3 && Array.isArray(raw[1]) && raw[1].every((x: unknown) => typeof x === "number")) {
    const rawW = raw[1];
    const weights: [number, number] =
      rawW.length === 2 ? [rawW[0] as number, rawW[1] as number] : [1, 1];
    return {
      kind: "or",
      a:    parseEntity(raw[0]),
      weights,
      b:    parseEntity(raw[2]),
    };
  }

  // Leaf: ["defId"] or ["defId", qty]
  if (typeof raw[0] === "string") {
    return { kind: "leaf", defId: raw[0], qty: typeof raw[1] === "number" ? raw[1] : 1 };
  }

  // AND form: [A, B] or [A, B, []]  —  C absent or empty.
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

function parseRecipe(raw: RawRecipe, index: number): Recipe {
  const r: Recipe = {
    id:         raw.id,
    index,
    recipeType: raw.type ?? "on_create",
    duration:   parseDuration(raw.duration),
  };
  if (raw.tile)      r.tile      = parseEntity(raw.tile);
  if (raw.catalysts) r.catalysts = parseEntity(raw.catalysts);
  if (raw.reagents)  r.reagents  = parseEntity(raw.reagents);
  if (raw.products) {
    r.products = (Object.entries(raw.products) as ["owner" | "root", RawEntity][])
      .map(([target, entity]) => ({ target, entity: parseEntity(entity) }));
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

/**
 * Load all recipe JSON files from src/data/recipes/ into the registry.
 * Files are loaded in path order (alphabetical); indices are assigned globally
 * across files in that order. Call once at startup before accessing any recipes.
 */
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

export function getRecipeById(id: string):      Recipe | undefined { return byId.get(id); }
export function getRecipeByIndex(index: number): Recipe | undefined { return byIndex.get(index); }
export function getAllRecipes(): ReadonlyMap<string, Recipe>         { return byId; }

// ── Matching ──────────────────────────────────────────────────────────────────

/** One matchable slot — a single card is required to satisfy it. */
interface Slot {
  readonly defId: string;
}

/**
 * Resolve the tile definition at a world hex position.
 * Checks for a CARD_TYPE_TILE (type 6) card override first, then falls
 * back to the zone's decoded tile grid.  Returns null if the location is
 * not on the world surface, the zone is unknown, or the cell is empty.
 */
export function getTileDef(macroLocation: bigint, microLocation: number): CardDefinition | null {
  if (surfaceFromMacro(macroLocation) !== SURFACE_WORLD) return null;
  const local_q = localQFromMicro(microLocation);
  const local_r = localRFromMicro(microLocation);

  // Type-6 card override at this exact hex.
  const atMacro = macro_location_cards.get(macroLocation);
  if (atMacro) {
    for (const cid of atMacro) {
      const c = client_cards[cid];
      if (!c) continue;
      if (((c.packed_definition >> 12) & 0xF) !== CARD_TYPE_TILE) continue;
      if (localQFromMicro(c.micro_location) !== local_q) continue;
      if (localRFromMicro(c.micro_location) !== local_r) continue;
      const def = getDefinitionByPacked(c.packed_definition);
      if (def) return def;
    }
  }

  // Fall back to zone tile grid.
  const zone = client_zones.get(macroLocation);
  if (!zone) return null;
  const packed = zone.tile_definitions[local_r]?.[local_q];
  if (!packed) return null;
  return getDefinitionByPacked(packed) ?? null;
}

/**
 * Recursively match a recipe tile entity against the actual tile definition.
 *
 * Leaf matching checks the tile's def id (exact → WEIGHT_TILE) or its aspects
 * (aspect value >= required qty → WEIGHT_TILE).  "any" matches any tile for
 * WEIGHT_ANY.  OR returns the best-scoring branch; AND requires both branches
 * and sums their weights.
 */
function matchTileEntity(
  entity:  RecipeEntity,
  tileDef: CardDefinition | null,
): { matched: boolean; weight: number } {
  switch (entity.kind) {
    case "empty":
      return { matched: true, weight: 0 };

    case "leaf": {
      if (!tileDef) return { matched: false, weight: 0 };
      if (entity.defId === "any") return { matched: true, weight: WEIGHT_ANY };
      if (tileDef.id === entity.defId) return { matched: true, weight: WEIGHT_TILE };
      const aspectValue = tileDef.aspects?.[entity.defId];
      if (aspectValue !== undefined && aspectValue >= entity.qty)
        return { matched: true, weight: WEIGHT_TILE };
      return { matched: false, weight: 0 };
    }

    case "or": {
      const a = matchTileEntity(entity.a, tileDef);
      const b = matchTileEntity(entity.b, tileDef);
      if (!a.matched && !b.matched) return { matched: false, weight: 0 };
      return { matched: true, weight: Math.max(a.matched ? a.weight : 0, b.matched ? b.weight : 0) };
    }

    case "and": {
      const a = matchTileEntity(entity.a, tileDef);
      const b = matchTileEntity(entity.b, tileDef);
      if (!a.matched || !b.matched) return { matched: false, weight: 0 };
      return { matched: true, weight: a.weight + b.weight };
    }
  }
}

/**
 * Score a specific card against a slot.
 * Returns the match weight (higher = more specific) or false if incompatible.
 *
 *   def id match   → WEIGHT_DEF_ID (4)
 *   aspect match   → WEIGHT_ASPECT (3)
 *   "any" wildcard → WEIGHT_ANY    (1)
 */
function scoreCardSlot(cardId: CardId, slot: Slot): number | false {
  const card = client_cards[cardId];
  if (!card) return false;
  const def = getDefinitionByPacked(card.packed_definition);
  if (!def) return false;

  if (slot.defId === "any") return WEIGHT_ANY;
  if (def.id === slot.defId) return WEIGHT_DEF_ID;
  if (def.aspects && slot.defId in def.aspects) return WEIGHT_ASPECT;
  return false;
}

/**
 * Enumerate all slot configurations from an entity.
 *
 * A "configuration" is one fully-expanded flat list of Slots — one entry per
 * individual card required.  OR nodes produce multiple alternative configs
 * (either branch); AND nodes cross-product their children's configs so all
 * branches are required simultaneously.
 *
 * The cross-product for AND can grow exponentially with nested ORs, but recipe
 * entities are small in practice.
 */
function enumSlots(entity: RecipeEntity): Slot[][] {
  switch (entity.kind) {
    case "empty":
      return [[]];
    case "leaf": {
      const slot: Slot = { defId: entity.defId };
      return [Array.from({ length: entity.qty }, () => slot)];
    }
    case "and": {
      const aAlts = enumSlots(entity.a);
      const bAlts = enumSlots(entity.b);
      return aAlts.flatMap(a => bAlts.map(b => [...a, ...b]));
    }
    case "or":
      return [...enumSlots(entity.a), ...enumSlots(entity.b)];
  }
}

/**
 * Maximum-weight bipartite matching between cards and slots.
 *
 * Assigns each slot to exactly one card; no card may fill more than one slot.
 * Tries all valid assignments and returns the one with the highest total weight,
 * or false if no complete assignment exists.
 *
 * Complexity: O(|cards|^|slots|) — feasible for the small stacks and slot
 * counts found in practice (≤ 10 cards, ≤ 5 slots).
 */
function maxWeightMatch(
  cards: readonly CardId[],
  slots: readonly Slot[],
): { assignment: readonly CardId[]; weight: number } | false {
  if (slots.length > cards.length) return false;

  const n    = cards.length;
  const used = new Uint8Array(n);

  function recurse(si: number): { assignment: CardId[]; weight: number } | false {
    if (si === slots.length) return { assignment: [], weight: 0 };
    let best: { assignment: CardId[]; weight: number } | false = false;
    for (let ci = 0; ci < n; ci++) {
      if (used[ci]) continue;
      const w = scoreCardSlot(cards[ci], slots[si]);
      if (w === false) continue;
      used[ci] = 1;
      const rest = recurse(si + 1);
      used[ci] = 0;
      if (rest === false) continue;
      const total = w + rest.weight;
      if (best === false || total > best.weight) {
        best = { assignment: [cards[ci], ...rest.assignment], weight: total };
      }
    }
    return best;
  }

  return recurse(0);
}

/** Result of attempting to match a recipe against a set of cards. */
interface RecipeMatch {
  /** Sum of per-slot match weights — higher = more specific assignment. */
  weight:       number;
  /** Cards that filled reagent slots; these are consumed when the recipe fires. */
  reagentCards: readonly CardId[];
  /** The bottom-most card in the stack that participated in the match. Used as
   *  the action anchor so progress bars appear on the actor, not the root. */
  actorCard:    CardId;
  /** All cards assigned to any slot (catalyst + reagent). Owned exclusively by
   *  this activation — removed from the pool each greedy round. */
  participants: readonly CardId[];
}

/** A matched recipe together with the card that should own the resulting action. */
export interface RecipeActivation {
  recipe:       Recipe;
  actorCard:    CardId;
  /** All card ids locked to this activation (catalyst + reagent). */
  participants: readonly CardId[];
}

/**
 * Try to match a recipe against a set of cards plus the tile at the stack's
 * hex position.
 *
 * The tile requirement is checked separately against `tileDefId` (not as a
 * card in the pool) — there is exactly one tile per hex and it is never
 * consumed.  Catalysts and reagents are matched via bipartite assignment;
 * each card fills at most one slot across both sections.  OR nodes produce
 * alternative slot configurations; all combinations are tried and the one
 * yielding the highest total weight is returned.
 *
 * Only reagent cards are returned in `reagentCards`; catalysts are matched
 * but not consumed.
 */
function tryMatchRecipe(
  recipe:  Recipe,
  cards:   readonly CardId[],
  tileDef: CardDefinition | null,
): RecipeMatch | false {
  const { matched: tileMatched, weight: tileWeight } = recipe.tile
    ? matchTileEntity(recipe.tile, tileDef)
    : { matched: true, weight: 0 };
  if (!tileMatched) return false;

  const catalystAlts = recipe.catalysts ? enumSlots(recipe.catalysts) : [[]];
  const reagentAlts  = recipe.reagents  ? enumSlots(recipe.reagents)  : [[]];

  let best: RecipeMatch | false = false;

  for (const catalystSlots of catalystAlts) {
    for (const reagentSlots of reagentAlts) {
      const allSlots = [...catalystSlots, ...reagentSlots];
      if (allSlots.length === 0) {
        if (best === false || tileWeight > best.weight)
          best = { weight: tileWeight, reagentCards: [], actorCard: cards[0], participants: [] };
        continue;
      }
      const match = maxWeightMatch(cards, allSlots);
      if (match === false) continue;
      const totalWeight = tileWeight + match.weight;
      if (best === false || totalWeight > best.weight) {
        const participantSet = new Set(match.assignment);
        best = {
          weight:       totalWeight,
          reagentCards: match.assignment.slice(catalystSlots.length),
          actorCard:    cards.find(cid => participantSet.has(cid)) ?? cards[0],
          participants: [...match.assignment],
        };
      }
    }
  }

  return best;
}

/**
 * Returns true if `cardIds` satisfies all input requirements (tile, catalysts,
 * reagents) of the given recipe.  Each card may fill at most one slot.
 * `tileDefId` is the definition id of the tile at the stack's hex position,
 * or null if the stack is not on the world surface.
 */
export function matchesInputs(
  recipeId: string,
  cardIds:  readonly CardId[],
  tileDef:  CardDefinition | null = null,
): boolean {
  const recipe = byId.get(recipeId);
  if (!recipe) return false;
  return validateRecipe(recipe, cardIds, tileDef);
}

/**
 * Returns true if `cardIds` satisfies all input requirements of `recipe`.
 * Prefer this over matchesInputs when you already have the Recipe object.
 */
export function validateRecipe(
  recipe:  Recipe,
  cardIds: readonly CardId[],
  tileDef: CardDefinition | null = null,
): boolean {
  return tryMatchRecipe(recipe, cardIds, tileDef) !== false;
}

/**
 * Returns all recipes of the given type whose inputs are satisfied by `cardIds`.
 * `tileDef` is the tile definition at the stack's hex position, or null if the
 * stack is not on the world surface.
 *
 * Common recipeType values: "top_stack", "bottom_stack", "both_stack",
 * "on_create", "explicit".
 *
 * Note: this returns every matching recipe with no priority ordering.
 * Use findTopStackRecipes (or selectGreedy) for priority-based selection.
 */
export function findMatchingRecipes(
  recipeType: string,
  cardIds:    readonly CardId[],
  tileDef:    CardDefinition | null = null,
): Recipe[] {
  const results: Recipe[] = [];
  for (const recipe of byId.values()) {
    if (recipe.recipeType !== recipeType) continue;
    if (validateRecipe(recipe, cardIds, tileDef)) results.push(recipe);
  }
  return results;
}

// ── Priority selection ────────────────────────────────────────────────────────

/**
 * Greedy priority-based recipe selection.
 *
 * Each round picks the highest-weight matching recipe, removes its participants
 * from the working pool, then repeats.  `isExcluded(cardId, recipeIndex)`
 * provides per-recipe exclusions on top of the within-run consumed set —
 * use this to exclude cards already running a specific recipe from a previous
 * call so the same recipe isn't duplicated for the same participants.
 */
export function selectGreedy(
  recipeType: string,
  cards:      CardId[],
  tileDef:    CardDefinition | null,
  isExcluded?: (cardId: CardId, recipeIndex: number) => boolean,
): RecipeActivation[] {
  const results:   RecipeActivation[] = [];
  const available: CardId[]           = [...cards];

  let found = true;
  while (found) {
    found = false;
    let best:             Recipe | null   = null;
    let bestWeight                        = -1;
    let bestParticipants: CardId[] | null = null;
    let bestActorCard:    CardId          = cards[0];

    for (const recipe of byId.values()) {
      if (recipe.recipeType !== recipeType) continue;
      const pool = isExcluded
        ? available.filter(id => !isExcluded(id, recipe.index))
        : available;
      const match = tryMatchRecipe(recipe, pool, tileDef);
      if (match === false) continue;
      if (match.weight > bestWeight) {
        bestWeight       = match.weight;
        best             = recipe;
        bestParticipants = [...match.participants];
        bestActorCard    = match.actorCard;
      }
    }

    if (best !== null && bestParticipants !== null) {
      results.push({ recipe: best, actorCard: bestActorCard, participants: bestParticipants });
      for (const id of bestParticipants) {
        const idx = available.indexOf(id);
        if (idx !== -1) available.splice(idx, 1);
      }
      found = true;
    }
  }

  return results;
}

export function collectUpChain(rootId: CardId): CardId[] {
  const ids: CardId[] = [];
  const seen = new Set<CardId>();
  const queue: CardId[] = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    ids.push(current);
    const children = stacked_up_children.get(current);
    if (children) for (const child of children) queue.push(child);
  }
  return ids;
}

export function collectDownChain(rootId: CardId): CardId[] {
  const ids: CardId[] = [];
  const seen = new Set<CardId>();
  const queue: CardId[] = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    ids.push(current);
    const children = stacked_down_children.get(current);
    if (children) for (const child of children) queue.push(child);
  }
  return ids;
}
