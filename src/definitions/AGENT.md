# AGENT.md

## Purpose
Static catalogs bundled at build time — the client's view of the JSON
data submodule. `DefinitionManager` indexes card definitions and
provides the `packed_definition` codec; `RecipeManager` indexes recipes
and runs the same priority/upgrade matcher the server uses, so the
client can pre-filter stack submissions that wouldn't change anything.

## Important files
- `DefinitionManager.ts`: card-definition catalog + codec. Loaded once at bootstrap; bundled into the build via `import.meta.glob` against `../data/cards/[0-9]*.json` (only numeric-prefixed files — keeps `id.json` / `AGENT.md` out of the load).
- `RecipeManager.ts`: recipe registry + matcher. Loaded the same way against `../data/recipes/[0-9]*.json`. Reads recipe IDs from `id.json` and produces the same `MatchWeight { tile, root, slot }` and `ActorMatch` shapes the server's `actions.rs` produces. Public API: `recipes()`, `recipesOfType(category, direction)`, `decode(packed)`, `scoreRecipeForActor(...)`, `findBestForActor(...)`, `compareWeight(a, b)`.

## Conventions
- **packed_definition layout** (matches the server, see `data/card_types.json` `_rules.subscription_mask` for cross-check):
  - bits 15..12 — `card_type` (u4)
  - bits 11..8  — `card_category` (u4)
  - bits  7..0  — `definition_id` (u8, **1-indexed**; 0 is reserved as a sentinel)
- **Recipe packed-ID layout** (matches `packing.rs::pack_recipe`):
  - bits 15..13 — `recipe_type` (u3)
  - bits 12..10 — `recipe_category` (u3)
  - bits  9..0  — `recipe_id` (u10, from `recipes/id.json`)
- Type and category names in `data/cards/*.json` must match `data/card_types.json` keys **exactly** — no fuzzy matching, no plural fallback. If a name doesn't match, the registry is the source of truth and the cards file is wrong.
- `definitionId` for a card is its position (1..255) within its `(card_type, category)` group, sourced from `cards/id.json`. Reordering an array doesn't change packed ids; adding/removing entries requires re-running `data/gen-ids.py`.
- Each `(card_type, category)` group must appear in **exactly one** cards JSON file. The loader throws on duplicates with both paths in the error.
- **Priority evaluation must stay in lockstep with the server.** Per-leaf entity weights (`Card`=4, `Aspect`=3, `Type`=2, `Any`=1), the lex-ordered `MatchWeight`, the visible-chain walk, and the four-way upgrade decision in `ActionManager` all mirror `actions.rs`. When you change one, change the other in the same commit. See `data/recipes/AGENT.md` ("Where this is implemented") for the long-form explanation.
- `WeightedOr` entities in slots are folded into plain `or` here — slot matching only cares whether *some* alternative matched. The weights only matter for output picking, which the client doesn't run (the server picks at completion).
- Public APIs:
  - `DefinitionManager.decode(packed)` → `CardDefinition | undefined`. Static `pack(typeId, categoryId, definitionId)` / `unpack(packed)` for the codec without the catalog.
  - `RecipeManager.decode(packed)` → `RecipeDef | undefined`. Matches the server's `Action.recipe` field on the wire.

## Pitfalls
- Empty glob (no cards / recipes files) only warns — usually means the `src/data/` symlink is broken.
- Type/category ids must fit in u4 (0–15). The constructor throws on any registry entry outside that range.
- Per-group cap is 255 cards (u8). Hitting it throws — don't `break` past it silently.
- `_reserved_*` entries in `data/card_types.json` occupy real ids and ARE registered; their slots are unusable for cards but their ids are off-limits to other types.
- The catalogs are bundled, not fetched. Schema/name changes in `data/` require a client rebuild, not a server reload.
- `RecipeManager` resolves `"@<type>"` entities through `DefinitionManager.typeIdByName`. An unknown type in a recipe is a hard parse failure that surfaces during construction. Construct DefinitionManager *before* RecipeManager (`main.ts` does this) so the type table is populated.
- `parseDuration` falls back to `0` if no numeric duration is found — that's the silent failure mode for a malformed conditional duration on the client. The server's parser is stricter; check there too if a recipe completes instantly.
