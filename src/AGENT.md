# AGENT.md

## Purpose
`src/` contains the Pixi client runtime: app bootstrapping, scenes, UI/layout, game data transforms, and SpacetimeDB integration.

## Key entrypoints
- `main.ts`: creates Pixi app, calls `bootstrapCardDefinitions()` + `bootstrapRecipeDefinitions()`, connects to SpacetimeDB, starts scene loop.
- `app/AppContext.ts`: global access to initialized Pixi `Application`.
- `scenes/`: scene lifecycle and transitions.
- `ui/`: layout engine (`ui/layout/`), visual components (`ui/components/`), input (`ui/input/`).
- `spacetime/`: client state schema, pack/unpack helpers, generated DB bindings.
- `definitions/`: card definition and recipe loaders/validators.
- `data/`: local card and recipe JSON.

## Conventions
- Keep scene orchestration in `scenes/`; keep rendering/layout logic in `ui/`.
- Keep recipe/card validation in `definitions/`; call into it from UI components.
- Use strict TS types; avoid `any` unless unavoidable.
- Prefer `@/...` imports for cross-folder `src` references.

## Ownership boundaries
- `main.ts` owns app setup, bootstrap calls, and initial scene choice.
- `SceneManager` owns scene switching and scene view attachment to stage.
- Layout dirtiness cascades upward through layout objects via `invalidateLayout()`; do not bypass invalidation or manually sync siblings.
- Shared card state (`client_cards` flags like `dragging`, `animating`) is mutated then `invalidateLayout()` is called — dirty propagation is the sync mechanism.
- All recipe validation logic lives in `definitions/RecipeDefinitions.ts`.

## Pitfalls
- Do not edit generated files in `spacetime/bindings/`.
- Do not call `sync()` on sibling layout components manually.
- `card.animating` (not `returning`) is the flag used during return tweens and drop animations.
- Bootstrap functions (`bootstrapCardDefinitions`, `bootstrapRecipeDefinitions`) must both be called before any definition lookups; omitting either causes silent lookup failures.
