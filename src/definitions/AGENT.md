# AGENT.md

## Purpose
Typed interfaces and exports for resolved card definition data.

## Important files
- `CardDefinitions.ts`: core type contracts for card definition shape.
- `index.ts`: barrel exports used by consumers.

## Conventions
- Keep type changes backward-compatible unless all downstream call sites are updated together.
- Prefer extending interfaces with optional fields rather than breaking required fields.
- Keep this folder type-centric; data loading belongs in `src/data/cards/`.
