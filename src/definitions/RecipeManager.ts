import type { CardDefinition } from "./DefinitionManager";
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
  | { kind: "and"; a: RecipeEntity; b: RecipeEntity }
  | { kind: "or"; a: RecipeEntity; b: RecipeEntity };

/** Progress bar style attached to a recipe. Colors may be CSS hex strings or
 *  the sentinel `"default"`, which tells the renderer to use the card's own
 *  title-bar color. `direction` controls which end fills first. */
export interface RecipeProgressStyle {
  readonly direction: "ltr" | "rtl";
  readonly colorLeft: string;
  readonly colorRight: string;
}

export interface RecipeDef {
  /** Declaration-order index across all recipe files — also the priority
   *  (lower wins when multiple recipes match the same chain). */
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

export interface RecipeMatch {
  readonly recipe: RecipeDef;
  /** Index into the chain where slot 1 (the actor) sits. */
  readonly actorPos: number;
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
  "../data/recipes/*.json",
  { eager: true },
);

/**
 * Loads and matches recipes. Mirrors the server-side matcher in
 * `actions.rs::try_match_stack`: the actor slides from `min_actor_pos`
 * (`1` if rooted, else `0`); slot `i` fills `chain[actor_pos + i]`; first
 * recipe in declaration order whose slot window fits + every entity
 * matches wins.
 *
 * Client-side use is detection-only — actual recipe starts happen on the
 * server via `submit_inventory_stacks`. We exist so the UI can hint
 * "this stack will trigger X recipe" before the user submits it.
 */
export class RecipeManager {
  private readonly all: RecipeDef[] = [];
  private readonly byType: Record<RecipeType, RecipeDef[]> = {
    top_stack: [],
    bottom_stack: [],
    on_create: [],
  };
  private readonly byIndex = new Map<number, RecipeDef>();

  constructor() {
    this.load();
  }

  /**
   * Try to match `chain` against `type`'s recipes. Returns the first
   * recipe whose slots all fill (priority = declaration order). Chain
   * shape: `[root, …branch]`, with `branch` going outward in the
   * direction implied by `type`.
   *
   * `chain[i]` may be `null` when the row's `packed_definition` doesn't
   * decode (missing card definition); such positions never match.
   */
  match(
    chain: readonly (CardDefinition | null)[],
    type: RecipeType,
  ): RecipeMatch | null {
    const candidates = this.byType[type];
    for (const recipe of candidates) {
      const result = this.tryMatch(chain, recipe);
      if (result) return result;
    }
    return null;
  }

  /** Read-only snapshot of every parsed recipe. */
  recipes(): readonly RecipeDef[] {
    return this.all;
  }

  /** Look up a recipe by its declaration-order index (matches `ActionRow.recipe`). */
  getByIndex(index: number): RecipeDef | undefined {
    return this.byIndex.get(index);
  }

  private tryMatch(
    chain: readonly (CardDefinition | null)[],
    recipe: RecipeDef,
  ): RecipeMatch | null {
    if (recipe.slots.length === 0) return null;

    if (recipe.root !== null) {
      const rootDef = chain[0];
      if (!rootDef || !this.entityMatches(recipe.root, rootDef)) return null;
    }
    const minActorPos = recipe.root !== null ? 1 : 0;

    for (let actorPos = minActorPos; actorPos < chain.length; actorPos++) {
      if (actorPos + recipe.slots.length > chain.length) break;
      let allMatch = true;
      for (let i = 0; i < recipe.slots.length; i++) {
        const def = chain[actorPos + i];
        if (!def || !this.entityMatches(recipe.slots[i], def)) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) return { recipe, actorPos };
    }
    return null;
  }

  private entityMatches(entity: RecipeEntity, def: CardDefinition): boolean {
    switch (entity.kind) {
      case "key":
        return def.key === entity.key;
      case "aspect": {
        for (const [name, value] of def.aspects) {
          if (name === entity.name) return value >= entity.min;
        }
        return false;
      }
      case "and":
        return (
          this.entityMatches(entity.a, def) && this.entityMatches(entity.b, def)
        );
      case "or":
        return (
          this.entityMatches(entity.a, def) || this.entityMatches(entity.b, def)
        );
    }
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
      if (!Array.isArray(arr)) {
        console.warn(`[RecipeManager] ${path}: top-level not an array, skipping`);
        continue;
      }
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
   *   `[X]`              → unwrap and reparse `X`
   *   `[name, n]`        → `{kind: "aspect"}` (when 2nd is number)
   *   `[A, B]`           → `{kind: "and"}` (when 2nd is not number)
   *   `[A, [], B]`       → `{kind: "or"}`
   *   `[A, [w1,w2], B]`  → `{kind: "or"}` (weights ignored — slots don't care)
   */
  private parseEntity(value: unknown, path: string): RecipeEntity {
    if (typeof value === "string") {
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
