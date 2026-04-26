# AGENT.md

## Purpose
`src/` contains the Pixi client runtime: app bootstrapping, scenes, UI/layout, game data transforms, and SpacetimeDB integration.

## Key entrypoints
- `main.ts`: creates Pixi app and scene loop.
- `app/AppContext.ts`: global access to initialized Pixi `Application`.
- `scenes/`: scene lifecycle and transitions.
- `ui/`: layout engine (`ui/layout/`), visual components (`ui/components/`), input (`ui/input/`).
- `spacetime/`: client state schema, pack/unpack helpers, generated DB bindings.
- `data/`: local card definition data.

## Conventions
- Keep scene orchestration in `scenes/`; keep rendering/layout logic in `ui/`.
- Use strict TS types; avoid `any` unless unavoidable.
- Prefer `@/...` imports for cross-folder `src` references.

## Ownership boundaries
- `main.ts` owns app setup and initial scene choice.
- `SceneManager` owns scene switching and scene view attachment to stage.
- Layout dirtiness cascades upward through layout objects via `invalidateLayout()`; do not bypass invalidation methods or manually sync sibling components.
- Shared card state (`client_cards` flags like `dragging`, `returning`) is mutated then `invalidateLayout()` is called — the layout tree propagation is the sync mechanism.

## Pitfalls
- Do not edit generated files in `spacetime/bindings/`.
- Do not call `sync()` on sibling layout components manually — mutate the shared data and call `invalidateLayout()` instead.
