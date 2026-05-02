# AGENT.md

## Purpose
PixiJS v8 + TypeScript client for resonantdust. Connects to the SpacetimeDB module in `../spacetime/` and renders the card/hex world.

## Important files
- `src/main.ts`: app bootstrap, fatal-error overlay, HMR teardown.
- `src/GameContext.ts`: service container passed to every scene. Single source of truth for cross-module wiring.
- `src/scenes/`, `src/server/`, `src/definitions/`: each has its own AGENT.md with the module contract.
- `src/data/`: **symlink** to `../../data/` (the data submodule). Don't write through it without realizing you're editing a separate git repo.
- `package.json`, `vite.config.ts`, `tsconfig.json`: build wiring.

## Conventions
- Each top-level dir under `src/` owns one responsibility and has an AGENT.md with its contract — read those before editing.
- Validate at boundaries (data load, network, DOM); trust internal calls. Throw loudly on data inconsistency rather than degrading silently.
- Async lifecycle is the default — `onEnter`/`onExit`/`dispose()` are awaitable.
- Spacetime bindings are generated via `../spacetime/server/generate-bindings.sh` into `src/server/bindings/`. Regenerate after any server schema change.
- Don't introduce module-level singletons. Hang shared services off `GameContext`.

## Pitfalls
- `src/data/` is symlinked from a sibling submodule. Edits land in the data repo, not pixijs. Card-shape conventions live in `data/cards/AGENT.md`.
- HMR safety depends on `SceneManager.dispose()` and `app.destroy()` running in `import.meta.hot.dispose`. Anything that registers global listeners (window resize, ticker callbacks, websocket) must be tearable down.
- This is the **third** rewrite. Goal: rewrite modules, not the repo. Maintain narrow contracts between modules so swapping one doesn't cascade.
