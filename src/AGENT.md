# AGENT.md

## Purpose
`src/` contains the Pixi client runtime: app bootstrapping, scenes, UI/layout, game data transforms, and SpaceTimeDB integration.

## Key entrypoints
- `main.ts`: creates Pixi app and scene loop.
- `app/AppContext.ts`: global access to initialized Pixi `Application`.
- `scenes/`: scene lifecycle and transitions.
- `ui/`: layout primitives + visual components.
- `spacetime/`: client state transforms and generated DB bindings.
- `data/`: local card definition data.

## Conventions
- Keep scene orchestration in `scenes/`; keep rendering/layout logic in `ui/`.
- Use strict TS types; avoid `any` unless unavoidable.
- Prefer `@/...` imports for cross-folder `src` references.

## Ownership boundaries
- `main.ts` owns app setup and initial scene choice.
- `SceneManager` owns scene switching and scene view attachment to stage.
- Layout dirtiness should cascade upward through layout objects; do not bypass invalidation methods.

## Pitfalls
- This repo has mixed file-name casing in comments/import intent (e.g., `DebugData.ts` vs `debug_data` reference patterns). Be careful on case-sensitive filesystems.
- Do not edit generated files in `spacetime/bindings`.
