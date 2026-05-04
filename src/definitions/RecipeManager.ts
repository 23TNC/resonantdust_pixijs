import type { CardDefinition, DefinitionManager } from "./DefinitionManager";
import recipeIdsData from "../data/recipes/id.json";

/**
 * What kind of trigger fires the recipe. We only run the matcher on stack
 * changes here, so `top_stack` / `bottom_stack` are the live cases; the
 * `on_create` type is parsed for completeness (server-side trigger only).
 */
export type RecipeType = "top_stack" | "bottom_stack" | "on_create";

/**
 * Parsed entity grammar (see `data/recipes/AGENT.md`). Discriminated union;
 * `WeightedOr` is folded into `or` because slots only care whether a card
 * matches one alternative, not which one (weights are products-only).
 */
export type RecipeEntity =
  | { kind: "key"; key: string }
  | { kind: "aspect"; name: string; min: number }
  | { kind: "type"; typeId: number }
  | { kind: "any" }
  | { kind: "and"; a: RecipeEntity; b: RecipeEntity }
  | { kind: "or"; a: RecipeEntity; b: RecipeEntity };

// Per-leaf entity weights — must match the server's `actions.rs` constants.
// Higher = more specific.
const ENTITY_WEIGHT_CARD = 4;
const ENTITY_WEIGHT_ASPECT = 3;
const ENTITY_WEIGHT_TYPE = 2;
const ENTITY_WEIGHT_ANY = 1;

/**
 * Lex-ordered priority for a successful recipe match. Field order **is** the
 * comparison order: `tile` outranks `root` outranks `slot`. Recipes with no
 * `tile` / `root` field score `0` for that tier — so a recipe with a satisfied
 * tile beats any combination of root and slot weights.
 *
 * Today the matcher always sets `tile = 0` (tile context isn't wired up).
 */
export interface MatchWeight {
  readonly tile: number;
  readonly root: number;
  readonly slot: number;
}

/** Progress bar style attached to a recipe. Colors may be CSS hex strings or
 *  the sentinel `"default"`, which tells the renderer to use the card's own
 *  title-bar color. `direction` controls which end fills first. */
export interface RecipeProgressStyle {
  readonly direction: "ltr" | "rtl";
  readonly colorLeft: string;
  readonly colorRight: string;
}

export interface RecipeDef {
  /** Stable integer ID from `data/recipes/id.json`. Matches `Action.recipe`
   *  on the wire. Used as the priority tiebreak too — declaration order. */
  readonly index: number;
  readonly id: string;
  readonly type: RecipeType;
  /** Optional precondition on the chain root (`chain[0]`). When set, the
   *  actor must start at `chain[1]+`. */
  readonly root: RecipeEntity | null;
  /** Slot list. Slot 1 (index 0 here) is the actor; subsequent slots fill
   *  outward at increasing chain indices. Empty for `on_create`. */
  readonly slots: readonly RecipeEntity[];
  /** Recipe duration in seconds. 0 if unspecified or non-numeric. */
  readonly duration: number;
  /** Progress bar style, or null if the recipe has no style entry. */
  readonly style: RecipeProgressStyle | null;
}

/**
 * Outcome of scoring a recipe at a specific actor position. Mirrors
 * `actions.rs::ActorMatch` so the client can apply the same upgrade
 * decisions as a pre-filter.
 */
export interface ActorMatch {
  readonly recipe: RecipeDef;
  readonly weight: MatchWeight;
  /** card_ids the action would claim — chain root (if recipe is rooted)
   *  followed by the actor and each slot filler in chain order. */
  readonly claimed: readonly number[];
  /** Position of the actor in the branch chain. */
  readonly actorIdx: number;
}

interface RawRecipe {
  id: string;
  type: string;
  slots?: unknown[];
  root?: unknown;
  reagents?: unknown;
  products?: unknown;
  duration?: unknown;
  style?: unknown;
}

const recipeModules = import.meta.glob<{ default: RawRecipe[] }>(
  "../data/recipes/[0-9]*.json",
  { eager: true },
);

/**
 * Loads recipes and runs the priority/upgrade matcher. Mirrors the
 * server-side machinery in `actions.rs`:
 *
 *   - Per-leaf entity weights (`Card`=4, `Aspect`=3, `Type`=2, `Any`=1).
 *   - Lex-ordered `MatchWeight { tile, root, slot }` picks the best recipe
 *     across all candidates of a type.
 *   - `scoreRecipeForActor` evaluates one recipe at one actor position over
 *     the visible window starting there; `findBestForActor` iterates all
 *     recipes of a type and returns the highest-scoring match.
 *
 * Client-side this is the **pre-filter** — it decides whether a stack
 * submission would actually change server-side state. The server is the
 * authoritative evaluator and re-runs the calculation independently. Both
 * sides must produce identical results; see
 * `data/recipes/AGENT.md` ("Where this is implemented").
 */
export class RecipeManager {
  private readonly all: RecipeDef[] = [];
  private readonly byType: Record<RecipeType, RecipeDef[]> = {
    top_stack: [],
    bottom_stack: [],
    on_create: [],
  };
  private readonly byIndex = new Map<number, RecipeDef>();

  constructor(private readonly definitions: DefinitionManager) {
    this.load();
  }

  /** Read-only snapshot of every parsed recipe. */
  recipes(): readonly RecipeDef[] {
    return this.all;
  }

  /** All recipes of one type, in declaration order. Used by the matcher
   *  loop in ActionManager. */
  recipesOfType(type: RecipeType): readonly RecipeDef[] {
    return this.byType[type];
  }

  /** Look up a recipe by its stable ID (matches `ActionRow.recipe`). */
  getByIndex(index: number): RecipeDef | undefined {
    return this.byIndex.get(index);
  }

  /**
   * Lex compare for `MatchWeight`. Returns positive if `a > b`, negative if
   * `a < b`, zero if equal. The triple is compared field-by-field —
   * comparison stops at the first non-equal tier.
   */
  static compareWeight(a: MatchWeight, b: MatchWeight): number {
    if (a.tile !== b.tile) return a.tile - b.tile;
    if (a.root !== b.root) return a.root - b.root;
    return a.slot - b.slot;
  }

  /**
   * Score how specifically `entity` matches `def`. `0` means no match; any
   * positive value indicates a match, with higher = more specific. Mirrors
   * `actions.rs::entity_match_weight`.
   */
  static entityMatchWeight(entity: RecipeEntity, def: CardDefinition): number {
    switch (entity.kind) {
      case "key":
        return def.key === entity.key ? ENTITY_WEIGHT_CARD : 0;
      case "aspect": {
        for (const [name, value] of def.aspects) {
          if (name === entity.name) return value >= entity.min ? ENTITY_WEIGHT_ASPECT : 0;
        }
        return 0;
      }
      case "type":
        return def.typeId === entity.typeId ? ENTITY_WEIGHT_TYPE : 0;
      case "any":
        return ENTITY_WEIGHT_ANY;
      case "and": {
        const wa = RecipeManager.entityMatchWeight(entity.a, def);
        const wb = RecipeManager.entityMatchWeight(entity.b, def);
        return wa > 0 && wb > 0 ? wa + wb : 0;
      }
      case "or": {
        const wa = RecipeManager.entityMatchWeight(entity.a, def);
        if (wa > 0) return wa;
        return RecipeManager.entityMatchWeight(entity.b, def);
      }
    }
  }

  /**
   * Score `recipe` for an actor at `chain[actorIdx]` over the visible
   * window `chain[actorIdx..visibleEnd]`. Returns the match plus its
   * weight, or `null` if the recipe doesn't fit or doesn't match.
   *
   * The chain root is always `chain[0]` (the submitted root) regardless
   * of where the actor sits — for `top_stack` and `bottom_stack` recipes
   * alike. Rooted recipes pin the chain root at index 0 and the actor
   * sits *above* it, so `actorIdx === 0` is reserved for the root and
   * skipped.
   */
  scoreRecipeForActor(
    recipe: RecipeDef,
    chain: readonly number[],
    defs: readonly (CardDefinition | null)[],
    actorIdx: number,
    visibleEnd: number,
  ): ActorMatch | null {
    const slotCount = recipe.slots.length;
    if (slotCount === 0) return null;
    if (actorIdx + slotCount > visibleEnd) return null;
    if (recipe.root !== null && actorIdx === 0) return null;

    let rootWeight = 0;
    if (recipe.root !== null) {
      const def = defs[0];
      if (!def) return null;
      const w = RecipeManager.entityMatchWeight(recipe.root, def);
      if (w === 0) return null;
      rootWeight = w;
    }

    let slotWeight = 0;
    for (let i = 0; i < slotCount; i++) {
      const def = defs[actorIdx + i];
      if (!def) return null;
      const w = RecipeManager.entityMatchWeight(recipe.slots[i], def);
      if (w === 0) return null;
      slotWeight += w;
    }

    const claimed: number[] = [];
    if (recipe.root !== null) claimed.push(chain[0]);
    for (let i = 0; i < slotCount; i++) {
      const id = chain[actorIdx + i];
      if (!claimed.includes(id)) claimed.push(id);
    }

    return {
      recipe,
      weight: { tile: 0, root: rootWeight, slot: slotWeight },
      claimed,
      actorIdx,
    };
  }

  /**
   * Iterate every recipe of `type` and pick the highest-weight match for
   * an actor at `chain[actorIdx]` over the visible window
   * `chain[actorIdx..visibleEnd]`. Ties go to declaration order (first
   * wins), matching the server.
   *
   * Callers needing to filter out claim conflicts (e.g. a slot filler
   * already held by another action) should iterate `recipesOfType(type)`
   * and call `scoreRecipeForActor` directly so they can drop conflicting
   * candidates before picking the winner.
   */
  findBestForActor(
    chain: readonly number[],
    defs: readonly (CardDefinition | null)[],
    actorIdx: number,
    visibleEnd: number,
    type: RecipeType,
  ): ActorMatch | null {
    let best: ActorMatch | null = null;
    for (const recipe of this.byType[type]) {
      const m = this.scoreRecipeForActor(recipe, chain, defs, actorIdx, visibleEnd);
      if (!m) continue;
      if (!best || RecipeManager.compareWeight(m.weight, best.weight) > 0) best = m;
    }
    return best;
  }

  private load(): void {
    const entries = Object.entries(recipeModules);
    if (entries.length === 0) {
      console.warn(
        "[RecipeManager] no recipe files matched ../data/recipes/*.json — symlink missing?",
      );
      return;
    }
    // Sort by path so the load order is deterministic across hot-reload.
    entries.sort(([a], [b]) => a.localeCompare(b));

    const recipeIds = recipeIdsData as Record<string, number>;
    const seenIds = new Set<string>();
    for (const [path, module] of entries) {
      const arr = module.default;
      if (!Array.isArray(arr)) continue;
      for (const raw of arr) {
        if (typeof raw?.id !== "string") {
          console.warn(`[RecipeManager] ${path}: recipe missing id, skipping`);
          continue;
        }
        const index = recipeIds[raw.id];
        if (index === undefined) {
          throw new Error(`[RecipeManager] ${path}: recipe "${raw.id}" missing from data/recipes/id.json`);
        }
        const def = this.parseRecipe(raw, path, index);
        if (!def) continue;
        if (seenIds.has(def.id)) {
          console.warn(
            `[RecipeManager] ${path}: duplicate recipe id "${def.id}", keeping first`,
          );
          continue;
        }
        seenIds.add(def.id);
        this.all.push(def);
        this.byType[def.type].push(def);
        this.byIndex.set(def.index, def);
      }
    }
  }

  private parseRecipe(
    raw: RawRecipe,
    path: string,
    index: number,
  ): RecipeDef | null {
    if (typeof raw?.id !== "string") {
      console.warn(`[RecipeManager] ${path}: recipe missing id, skipping`);
      return null;
    }
    const id = raw.id;
    if (
      raw.type !== "top_stack" &&
      raw.type !== "bottom_stack" &&
      raw.type !== "on_create"
    ) {
      console.warn(
        `[RecipeManager] ${path}: recipe "${id}" has unknown type "${raw.type}", skipping`,
      );
      return null;
    }
    const type: RecipeType = raw.type;

    let root: RecipeEntity | null = null;
    if (raw.root !== undefined) {
      try {
        root = this.parseEntity(raw.root, `${id}.root`);
      } catch (err) {
        console.warn(`[RecipeManager] ${path}: ${(err as Error).message}`);
        return null;
      }
    }

    const slotsRaw = Array.isArray(raw.slots) ? raw.slots : [];
    const slots: RecipeEntity[] = [];
    for (let i = 0; i < slotsRaw.length; i++) {
      try {
        slots.push(this.parseEntity(slotsRaw[i], `${id}.slots[${i}]`));
      } catch (err) {
        console.warn(`[RecipeManager] ${path}: ${(err as Error).message}`);
        return null;
      }
    }

    const duration = typeof raw.duration === "number" ? raw.duration : 0;

    let style: RecipeProgressStyle | null = null;
    if (Array.isArray(raw.style) && raw.style.length === 3) {
      const [dir, left, right] = raw.style;
      if (
        (dir === "ltr" || dir === "rtl") &&
        typeof left === "string" &&
        typeof right === "string"
      ) {
        style = { direction: dir, colorLeft: left, colorRight: right };
      }
    }

    return { index, id, type, root, slots, duration, style };
  }

  /**
   * Parse the entity grammar:
   *   `"key"`            → `{kind: "key"}`
   *   `"any"`            → `{kind: "any"}`
   *   `"@<type>"`        → `{kind: "type"}` (type name resolved via DefinitionManager)
   *   `[X]`              → unwrap and reparse `X`
   *   `[name, n]`        → `{kind: "aspect"}` (when 2nd is number)
   *   `[A, B]`           → `{kind: "and"}` (when 2nd is not number)
   *   `[A, [], B]`       → `{kind: "or"}`
   *   `[A, [w1,w2], B]`  → `{kind: "or"}` (weights ignored — slots don't care)
   */
  private parseEntity(value: unknown, path: string): RecipeEntity {
    if (typeof value === "string") {
      if (value === "any") return { kind: "any" };
      if (value.startsWith("@")) {
        const typeName = value.slice(1);
        const typeId = this.definitions.typeId(typeName);
        if (typeId === undefined) {
          throw new Error(
            `${path}: unknown card type "${typeName}" (not declared in card_types.json)`,
          );
        }
        return { kind: "type", typeId };
      }
      return { kind: "key", key: value };
    }
    if (!Array.isArray(value)) {
      throw new Error(`${path}: entity not a string or array: ${JSON.stringify(value)}`);
    }
    if (value.length === 1) {
      return this.parseEntity(value[0], path);
    }
    if (value.length === 2) {
      const [a, b] = value;
      if (typeof a === "string" && typeof b === "number") {
        return { kind: "aspect", name: a, min: b };
      }
      return {
        kind: "and",
        a: this.parseEntity(a, `${path}[0]`),
        b: this.parseEntity(b, `${path}[1]`),
      };
    }
    if (value.length === 3) {
      const [a, middle, b] = value;
      if (!Array.isArray(middle)) {
        throw new Error(`${path}: 3-tuple middle not an array: ${JSON.stringify(middle)}`);
      }
      if (middle.length !== 0 && middle.length !== 2) {
        throw new Error(
          `${path}: 3-tuple middle has ${middle.length} elements, expected 0 (Or) or 2 (WeightedOr)`,
        );
      }
      return {
        kind: "or",
        a: this.parseEntity(a, `${path}[0]`),
        b: this.parseEntity(b, `${path}[2]`),
      };
    }
    throw new Error(`${path}: entity array of length ${value.length} not supported`);
  }
}
