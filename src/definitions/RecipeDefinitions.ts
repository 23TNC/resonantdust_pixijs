import { client_cards, type CardId } from "@/spacetime/Data";
import { getDefinitionByPacked } from "@/definitions/CardDefinitions";

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
  /** Fixed seconds, or [[seconds, entity?], ...] conditional list (first match wins; no entity = catch-all). */
  duration:   number | [number, RawEntity?][];
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

// ── Parsing ───────────────────────────────────────────────────────────────────

function parseEntity(raw: any): RecipeEntity {
  if (!Array.isArray(raw) || raw.length === 0) return { kind: "empty" };

  // Leaf: ["defId", qty]
  if (typeof raw[0] === "string") {
    return { kind: "leaf", defId: raw[0], qty: typeof raw[1] === "number" ? raw[1] : 1 };
  }

  // Compound: first element must be an array
  if (!Array.isArray(raw[0])) return { kind: "empty" };

  // OR form: three elements where the third is a non-empty array (entity).
  // [A, [wa, wb], C]  —  B is [number, number] weights (or [] for equal).
  if (raw.length === 3 && Array.isArray(raw[2]) && raw[2].length > 0) {
    const rawW = raw[1];
    const weights: [number, number] =
      Array.isArray(rawW) && rawW.length === 2 && typeof rawW[0] === "number"
        ? [rawW[0] as number, rawW[1] as number]
        : [1, 1];
    return {
      kind: "or",
      a:    parseEntity(raw[0]),
      weights,
      b:    parseEntity(raw[2]),
    };
  }

  // AND form: [A, B] or [A, B, []]  —  C absent or empty.
  return {
    kind: "and",
    a:    parseEntity(raw[0]),
    b:    raw.length >= 2 ? parseEntity(raw[1]) : { kind: "empty" },
  };
}

function parseDuration(raw: number | [number, RawEntity?][]): RecipeDuration {
  if (typeof raw === "number") return raw;
  return raw.map(entry => {
    const [duration, condRaw] = entry;
    const condition = condRaw != null && (Array.isArray(condRaw) && condRaw.length > 0)
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

export function getRecipeById(id: string):     Recipe | undefined { return byId.get(id); }
export function getRecipeByIndex(index: number): Recipe | undefined { return byIndex.get(index); }
export function getAllRecipes(): ReadonlyMap<string, Recipe>        { return byId; }

// ── Matching ──────────────────────────────────────────────────────────────────

/** Build a pool of { definitionId → count } from a list of runtime CardIds. */
function buildPool(cardIds: readonly CardId[]): Map<string, number> {
  const pool = new Map<string, number>();
  for (const id of cardIds) {
    const card = client_cards[id];
    if (!card) continue;
    const def = getDefinitionByPacked(card.packed_definition);
    if (!def?.id) continue;
    pool.set(def.id, (pool.get(def.id) ?? 0) + 1);
  }
  return pool;
}

function clonePool(pool: Map<string, number>): Map<string, number> {
  return new Map(pool);
}

function restorePool(pool: Map<string, number>, snapshot: Map<string, number>): void {
  pool.clear();
  snapshot.forEach((v, k) => pool.set(k, v));
}

/**
 * Try to satisfy `entity` by consuming cards from `pool`.
 * Mutates pool on success. Leaves pool unmodified on failure.
 * Returns true iff the entity is satisfied.
 *
 * Note: "any" is matched greedily in tree-traversal order.  If a recipe mixes
 * "any" with specific requirements at the same AND level, put specific branches
 * first so they consume cards before the "any" slot does.
 *
 * Aspects are not yet implemented; aspect defIds will always fail to match.
 */
function matchEntity(entity: RecipeEntity, pool: Map<string, number>): boolean {
  switch (entity.kind) {
    case "empty": return true;

    case "leaf": {
      if (entity.defId === "any") {
        let need = entity.qty;
        const taken: [string, number][] = [];
        for (const [key, count] of pool) {
          if (need <= 0) break;
          const take = Math.min(count, need);
          taken.push([key, take]);
          need -= take;
        }
        if (need > 0) return false;
        for (const [key, take] of taken) {
          const after = (pool.get(key) ?? 0) - take;
          if (after <= 0) pool.delete(key);
          else pool.set(key, after);
        }
        return true;
      }
      const have = pool.get(entity.defId) ?? 0;
      if (have < entity.qty) return false;
      const after = have - entity.qty;
      if (after <= 0) pool.delete(entity.defId);
      else pool.set(entity.defId, after);
      return true;
    }

    case "and": {
      const snap = clonePool(pool);
      if (!matchEntity(entity.a, pool)) return false;
      if (!matchEntity(entity.b, pool)) { restorePool(pool, snap); return false; }
      return true;
    }

    case "or": {
      const snap = clonePool(pool);
      if (matchEntity(entity.a, pool)) return true;
      restorePool(pool, snap);
      return matchEntity(entity.b, pool);
    }
  }
}

/**
 * Returns true if `cardIds` satisfies all input requirements (tile, catalysts,
 * reagents) of the given recipe.
 *
 * Catalysts and reagents each draw from the same card pool, so a card type
 * that appears in both requires separate physical cards for each slot.
 *
 * Tile checking: pass the tile's CardId as part of `cardIds` if you want tile
 * requirements to be evaluated (e.g. include the underlying tile card of the stack).
 */
export function matchesInputs(recipeId: string, cardIds: readonly CardId[]): boolean {
  const recipe = byId.get(recipeId);
  if (!recipe) return false;

  const pool = buildPool(cardIds);

  if (recipe.tile      && !matchEntity(recipe.tile,      pool)) return false;
  if (recipe.catalysts && !matchEntity(recipe.catalysts, pool)) return false;
  if (recipe.reagents  && !matchEntity(recipe.reagents,  pool)) return false;

  return true;
}
