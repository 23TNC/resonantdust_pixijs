# AGENT.md — definitions/

## Purpose
Typed interfaces, loaders, and query helpers for card definitions and recipe definitions.

## Important files
- `CardDefinitions.ts`: loads card JSON, provides lookup by `packed_definition` or definition id. Exports `getDefinition`, `getDefinitionByPacked`, `getRegistry`, `bootstrapCardDefinitions`.
- `RecipeDefinitions.ts`: loads recipe JSON, parses entity trees and duration conditions, provides matching helpers. Exports `bootstrapRecipeDefinitions`, `getRecipeById`, `getRecipeByIndex`, `getAllRecipes`, `matchesInputs`, `validateRecipe`, `findMatchingRecipes`, `findTopStackRecipes`.
- `index.ts`: barrel re-exports from both files.

## Bootstrap (call once at startup in main.ts)
    bootstrapCardDefinitions()
    bootstrapRecipeDefinitions()

Both are idempotent (guarded by registry size check). `getRecipeByIndex` returns `undefined` until bootstrap runs.

## Card definition lookup
    getDefinition(id: string)            // by string id ("corpus", etc.)
    getDefinitionByPacked(packed: number) // by packed_definition u16

## Recipe entity format (parsed from JSON)

    EntityLeaf  { kind: "leaf"; defId: string; qty: number }   // card id or aspect name
    EntityAnd   { kind: "and"; a: RecipeEntity; b: RecipeEntity }
    EntityOr    { kind: "or"; a: RecipeEntity; weights: [number, number]; b: RecipeEntity }
    EntityEmpty { kind: "empty" }

### JSON encoding

| JSON form | Parses as |
|-----------|-----------|
| `"defId"` | Leaf (qty=1). Bare string — valid as a standalone entity or as an OR branch. |
| `["defId"]` | Leaf (qty=1). |
| `["defId", qty]` | Leaf with qty. |
| `[A, [wa, wb], C]` | OR — A and C may be bare strings or entity arrays. |
| `[A, [], C]` | OR with equal weights `[1, 1]`. |
| `[A, B]` | AND. |
| `[A, B, []]` | AND (trailing empty ignored). |
| `[]` | Empty — always satisfied. |

**OR detection rule:** `raw[1]` is an array whose every element is a number (including `[]`). This check runs before the string-leaf check so `["log", [4, 1], "vigor"]` parses as OR, not a leaf named "log".

**`catalysts` and `reagents`** in the JSON are **arrays of entities** (the surrounding `[]` is the array, each element is an entity). A single-entity array `["corpus"]` is the common case.

**`products`** values (`owner`, `root`, `world`) are also **arrays of entities**. Each element is an entity; all are generated independently.

## Recipe duration format

    RecipeDuration = number | DurationCondition[]
    DurationCondition = { duration: number; condition?: RecipeEntity }

JSON: fixed number, or an array of entries evaluated in order — first match wins:
- `[seconds, entity]` — use `seconds` if `entity` conditions are met by the card pool.
- bare `seconds` (number) — unconditional catch-all; stops the search.

Always place the bare number last. `parseDuration` handles both array-entry forms.

## Card pool (for matching)

`buildPool(cardIds)` mirrors the server's `build_card_pool`:
- Each card contributes its definition id with count **1**.
- Each card contributes each of its aspect **keys** with count **1** — regardless of the aspect's numeric value.

A card with `"corpus": 2` adds 1 to pool["corpus"], not 2. A recipe requiring `["corpus", 2]` needs two separate corpus cards.

Aspects are defined in `data/aspects.json` and attached to card definitions under the `aspects` field.

## Matching API

    validateRecipe(recipe, cardIds)              // check a specific Recipe object
    matchesInputs(recipeId, cardIds)             // check by string id
    findMatchingRecipes(type, cardIds)           // all recipes of given type that match (unordered)
    findTopStackRecipes(rootId)                  // priority-selected top_stack recipes for a stack

### Priority selection (`findTopStackRecipes`)

Uses greedy priority: each iteration picks the highest-weight matching recipe, removes only its **reagent** cards from the working pool, then repeats. Tile and catalyst cards are preserved across iterations (a tile card can satisfy multiple consecutive recipes).

Match weight accumulates per entity node:
- Exact def id match: **4**
- Aspect name match: **3**
- `"any"` wildcard: **1**

The recipe with the highest total weight wins each round. Returns all selected recipes in order.

Tile matching: pass the tile's CardId inside `cardIds` when tile input is required.

Catalyst cards are NOT consumed; reagent cards ARE consumed. Both draw from the same scratch pool during validation, so a card shared between catalyst and reagent slots requires separate physical cards.

## Recipe JSON location
`data/recipes/*.json` — files loaded in alphabetical order; recipe indices are assigned globally across files in that order. Indices are what the server uses on the wire (u16 recipe field in Action).

## Conventions
- Keep type changes backward-compatible; update all downstream call sites together.
- All recipe validation logic stays in `RecipeDefinitions.ts`; call into it from UI components.
- Do not add game-rule logic (stacking checks, server calls) to this folder — it owns parsing and querying only.

## Pitfalls
- Forgetting to call `bootstrapRecipeDefinitions()` causes `getRecipeByIndex` to always return `undefined`, making recipe-based progress bar colors invisible (both default to `titleColor`).
- Duplicate definition IDs across JSON files cause nondeterministic lookup behavior.
