import type { CardDefinition, DefinitionManager } from "./DefinitionManager";
import { debug } from "../debug";
import recipeIdsData from "../data/recipes/id.json";
import recipeTypesData from "../data/recipe_types.json";

interface RecipeTypesJson {
  types: Record<string, { id: number }>;
  categories: Record<string, { id: number }>;
}

type RecipeIdsJson = Record<string, Record<string, Record<string, number>>>;

/**
 * Top-level recipe group type from the JSON schema.
 * `"stack"` recipes fire on stack topology changes; `"on_create"` fires
 * server-side when a card is created (parsed here for completeness).
 */
export type RecipeCategory = "stack" | "on_create";

/**
 * Direction key within a recipe group.
 * `"up"` / `"down"` are the two stack branches evaluated by the client
 * pre-filter; `"self"` is the `on_create` target (server-side only).
 */
export type RecipeDirection = "up" | "down" | "self";

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
  readonly direction: "ltr" | "rtl" | "cw" | "ccw";
  readonly colorLeft: string;
  readonly colorRight: string;
}

export interface RecipeDef {
  /** Packed integer ID: u3 typeId | u3 categoryId | u10 recipeId.
   *  Matches `Action.recipe` on the wire. */
  readonly packed: number;
  readonly id: string;
  /** Group type from the JSON schema (`"stack"` or `"on_create"`). */
  readonly type: RecipeCategory;
  /** Direction key within the group (`"up"`, `"down"`, or `"self"`). */
  readonly direction: RecipeDirection;
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
  /** Optional condition on the hex card that chain[0] is mounted on.
   *  Only evaluated when chain[0] has stackedState == STACKED_ON_HEX (3).
   *  When null the recipe has no hex precondition. */
  readonly hex: RecipeEntity | null;
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

interface RawRecipeGroup {
  type?: unknown;
  up?: unknown[];
  down?: unknown[];
  self?: unknown[];
}

/** Extract a usable duration number from a value that may be a plain number
 *  or a tiered array `[[dur, conditions], ..., fallback]`. Returns the last
 *  numeric element found, or 0 if none. */
function parseDuration(d: unknown): number {
  if (typeof d === "number") return d;
  if (Array.isArray(d)) {
    for (let i = d.length - 1; i >= 0; i--) {
      if (typeof d[i] === "number") return d[i] as number;
    }
  }
  return 0;
}

const recipeModules = import.meta.glob<{ default: RawRecipeGroup[] }>(
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
  private readonly byType = new Map<string, RecipeDef[]>([
    ["stack:up", []],
    ["stack:down", []],
    ["on_create:self", []],
  ]);
  private readonly byPacked = new Map<number, RecipeDef>();

  constructor(private readonly definitions: DefinitionManager) {
    this.load();
  }

  /** Read-only snapshot of every parsed recipe. */
  recipes(): readonly RecipeDef[] {
    return this.all;
  }

  /** All recipes for a category + direction, in declaration order. Used by
   *  the matcher loop in ActionManager. */
  recipesOfType(category: RecipeCategory, direction: RecipeDirection): readonly RecipeDef[] {
    return this.byType.get(`${category}:${direction}`) ?? [];
  }

  /** Look up a recipe by its packed ID (matches `ActionRow.recipe` on the wire). */
  decode(packed: number): RecipeDef | undefined {
    return this.byPacked.get(packed);
  }

  /** Pack typeId (u3), categoryId (u3), and recipeId (u10) into one integer. */
  static pack(typeId: number, categoryId: number, recipeId: number): number {
    return ((typeId & 0x7) << 13) | ((categoryId & 0x7) << 10) | (recipeId & 0x3ff);
  }

  static unpack(packed: number): { typeId: number; categoryId: number; recipeId: number } {
    return {
      typeId:     (packed >>> 13) & 0x7,
      categoryId: (packed >>> 10) & 0x7,
      recipeId:    packed         & 0x3ff,
    };
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
    hexDef: CardDefinition | null,
  ): ActorMatch | null {
    const slotCount = recipe.slots.length;
    if (slotCount === 0) return null;
    if (actorIdx + slotCount > visibleEnd) return null;
    if (recipe.root !== null && actorIdx === 0) return null;

    // Hex precondition: chain[0] must be mounted on a matching hex card.
    // hexDef is null when chain[0] is not on a hex (loose or on rect).
    let tileWeight = 0;
    if (recipe.hex !== null) {
      if (hexDef === null) return null;
      const w = RecipeManager.entityMatchWeight(recipe.hex, hexDef);
      if (w === 0) return null;
      tileWeight = w;
    }

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
      weight: { tile: tileWeight, root: rootWeight, slot: slotWeight },
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
   * already held by another action) should iterate
   * `recipesOfType(category, direction)` and call `scoreRecipeForActor`
   * directly so they can drop conflicting candidates before picking the winner.
   */
  findBestForActor(
    chain: readonly number[],
    defs: readonly (CardDefinition | null)[],
    actorIdx: number,
    visibleEnd: number,
    category: RecipeCategory,
    direction: RecipeDirection,
    hexDef: CardDefinition | null,
  ): ActorMatch | null {
    let best: ActorMatch | null = null;
    for (const recipe of this.recipesOfType(category, direction)) {
      const m = this.scoreRecipeForActor(recipe, chain, defs, actorIdx, visibleEnd, hexDef);
      if (!m) continue;
      if (!best || RecipeManager.compareWeight(m.weight, best.weight) > 0) best = m;
    }
    return best;
  }

  private load(): void {
    const entries = Object.entries(recipeModules);
    if (entries.length === 0) {
      debug.warn(["recipes"], "[RecipeManager] no recipe files matched ../data/recipes/*.json — symlink missing?");
      return;
    }
    entries.sort(([a], [b]) => a.localeCompare(b));

    const types = recipeTypesData as unknown as RecipeTypesJson;
    const typeIdByName = new Map<string, number>();
    const categoryIdByName = new Map<string, number>();
    for (const [name, entry] of Object.entries(types.types)) typeIdByName.set(name, entry.id);
    for (const [name, entry] of Object.entries(types.categories)) categoryIdByName.set(name, entry.id);

    const recipeIds = recipeIdsData as unknown as RecipeIdsJson;
    const seenIds = new Set<string>();

    debug.log(["recipes"], `[RecipeManager] loading from ${entries.length} file(s): ${entries.map(([p]) => p).join(", ")}`);

    for (const [path, module] of entries) {
      const groups = module.default;
      if (!Array.isArray(groups)) {
        debug.warn(["recipes"], `[RecipeManager] ${path}: default export is not an array, skipping`);
        continue;
      }
      debug.log(["recipes"], `[RecipeManager] ${path}: ${groups.length} group(s) found`);

      for (const group of groups) {
        const groupType = group.type;
        if (groupType === "stack") {
          const typeId = typeIdByName.get("stack")!;
          const directions: [RecipeDirection, unknown[]][] = [
            ["up",   Array.isArray(group.up)   ? group.up   : []],
            ["down", Array.isArray(group.down) ? group.down : []],
          ];
          for (const [dir, entries_] of directions) {
            const categoryId = categoryIdByName.get(dir)!;
            debug.log(["recipes"], `[RecipeManager] ${path}: stack:${dir} — ${entries_.length} recipe(s)`);
            for (const raw of entries_) {
              this.loadEntry(raw, "stack", dir, typeId, categoryId, path, recipeIds, seenIds);
            }
          }
        } else if (groupType === "on_create") {
          const typeId = typeIdByName.get("on_create")!;
          const categoryId = categoryIdByName.get("self")!;
          const selfEntries = Array.isArray(group.self) ? group.self : [];
          debug.log(["recipes"], `[RecipeManager] ${path}: on_create:self — ${selfEntries.length} recipe(s)`);
          for (const raw of selfEntries) {
            this.loadEntry(raw, "on_create", "self", typeId, categoryId, path, recipeIds, seenIds);
          }
        } else {
          debug.warn(["recipes"], `[RecipeManager] ${path}: unknown group type "${String(groupType)}", skipping`);
        }
      }
    }

    debug.log(["recipes"], `[RecipeManager] done — ${this.all.length} total recipe(s): ${[...this.byType.entries()].map(([k, v]) => `${k}=${v.length}`).join(", ")}`);
  }

  private loadEntry(
    raw: unknown,
    category: RecipeCategory,
    direction: RecipeDirection,
    typeId: number,
    categoryId: number,
    path: string,
    recipeIds: RecipeIdsJson,
    seenIds: Set<string>,
  ): void {
    const entry = raw as Record<string, unknown>;
    if (typeof entry?.id !== "string") {
      debug.warn(["recipes"], `[RecipeManager] ${path}: recipe entry missing id, skipping`);
      return;
    }
    const id = entry.id;
    const recipeId = recipeIds[category]?.[direction]?.[id];
    if (recipeId === undefined) {
      throw new Error(`[RecipeManager] ${path}: recipe "${id}" missing from data/recipes/id.json under ${category}/${direction}`);
    }
    const packed = RecipeManager.pack(typeId, categoryId, recipeId);
    const def = this.parseRecipe(entry, category, direction, path, packed);
    if (!def) return;
    if (seenIds.has(def.id)) {
      debug.warn(["recipes"], `[RecipeManager] ${path}: duplicate recipe id "${def.id}", keeping first`);
      return;
    }
    seenIds.add(def.id);
    this.all.push(def);
    this.byType.get(`${category}:${direction}`)!.push(def);
    this.byPacked.set(def.packed, def);
    debug.log(["recipes"], `[RecipeManager] registered "${id}" [${category}:${direction}] packed=0x${packed.toString(16)} slots=${def.slots.length} root=${def.root !== null} hex=${def.hex !== null}`);
  }

  private parseRecipe(
    raw: Record<string, unknown>,
    category: RecipeCategory,
    direction: RecipeDirection,
    path: string,
    packed: number,
  ): RecipeDef | null {
    const id = raw.id as string;

    let root: RecipeEntity | null = null;
    if (raw.root !== undefined) {
      try {
        root = this.parseEntity(raw.root, `${id}.root`);
      } catch (err) {
        debug.warn(["recipes"], `[RecipeManager] ${path}: ${(err as Error).message}`);
        return null;
      }
    }

    let hex: RecipeEntity | null = null;
    if (raw.hex !== undefined) {
      try {
        hex = this.parseEntity(raw.hex, `${id}.hex`);
      } catch (err) {
        debug.warn(["recipes"], `[RecipeManager] ${path}: ${(err as Error).message}`);
        return null;
      }
    }

    const slotsRaw = Array.isArray(raw.slots) ? raw.slots : [];
    const slots: RecipeEntity[] = [];
    for (let i = 0; i < slotsRaw.length; i++) {
      try {
        slots.push(this.parseEntity(slotsRaw[i], `${id}.slots[${i}]`));
      } catch (err) {
        debug.warn(["recipes"], `[RecipeManager] ${path}: ${(err as Error).message}`);
        return null;
      }
    }

    const duration = parseDuration(raw.duration);

    let style: RecipeProgressStyle | null = null;
    if (Array.isArray(raw.style) && raw.style.length === 3) {
      const [dir, left, right] = raw.style;
      if (
        (dir === "ltr" || dir === "rtl" || dir === "cw" || dir === "ccw") &&
        typeof left === "string" &&
        typeof right === "string"
      ) {
        style = { direction: dir, colorLeft: left, colorRight: right };
      }
    }

    return { packed, id, type: category, direction, root, slots, duration, style, hex };
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
