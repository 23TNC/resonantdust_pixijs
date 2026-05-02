# AGENT.md

## Purpose
Static card-definition catalog. Loads `data/cards/*.json` at build time and decodes the on-the-wire `packed_definition` u16.

## Important files
- `DefinitionManager.ts`: catalog + codec. Loaded once at bootstrap; bundled into the build via `import.meta.glob` against `../data/cards/*.json`.

## Conventions
- **packed_definition layout** (matches the server, see `data/card_types.json` `_rules.subscription_mask` for cross-check):
  - bits 15..12 — `card_type` (u4)
  - bits 11..8  — `card_category` (u4)
  - bits  7..0  — `definition_id` (u8, **1-indexed**; 0 is reserved as a sentinel)
- Type and category names in `data/cards/*.json` must match `data/card_types.json` keys **exactly** — no fuzzy matching, no plural fallback. If a name doesn't match, the registry is the source of truth and the cards file is wrong.
- `definitionId` for a card is its index (1..255) in JSON insertion order within its `(card_type, category)` group. Reordering an array changes packed ids — treat it as a data migration.
- Each `(card_type, category)` group must appear in **exactly one** cards JSON file. The loader throws on duplicates with both paths in the error.
- Public API: `decode(packed)` → `CardDefinition | undefined`. Static `pack`/`unpack` for the codec without the catalog.

## Pitfalls
- Empty glob (no cards files) only warns — usually means the `src/data/` symlink is broken.
- Type/category ids must fit in u4 (0–15). The constructor throws on any registry entry outside that range.
- Per-group cap is 255 cards (u8). Hitting it throws — don't `break` past it silently.
- `_reserved_*` entries in `data/card_types.json` occupy real ids and ARE registered; their slots are unusable for cards but their ids are off-limits to other types.
- The catalog is bundled, not fetched. Schema/name changes in `data/` require a client rebuild, not a server reload.
