# AGENT.md

## Purpose
Static/local game data used by client transforms and rendering (card definitions and raw JSON datasets).

## Conventions
- Keep data files declarative; transformation logic belongs in TypeScript modules, not JSON.
- Preserve stable IDs and schema fields expected by `src/spacetime/data.ts` and `src/data/cards/definitions.ts`.
- Prefer additive changes over broad data reshapes.

## Pitfalls
- Renaming/removing definition IDs can break decode paths and debug bootstrap assumptions.
