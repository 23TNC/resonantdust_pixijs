# AGENT.md

## Project scope
TypeScript PixiJS client (PixiJS **v8.9.1**) built with Vite. Keep changes small and focused.

## Global rules
- Use **2-space indentation** in new/edited files.
- Do not rewrite architecture unless explicitly requested.
- Follow existing scene/layout/component patterns before adding new abstractions.
- Prefer official PixiJS docs for API behavior: https://pixijs.download/release/docs/index.html
- SpaceTimeDB bindings under `src/spacetime/bindings/` are generated; **do not hand-edit** them.

## Architecture anchors
- Entry point: `src/main.ts` sets up `Application`, registers app context, loads debug data, and starts scenes.
- `LoginScene` is currently a thin bootstrap scene: sets `setPlayerName("player1")`, `setPlayerId(1)`, then switches to `GameScene`.
- `GameScene` should remain the root gameplay scene; it stands up `GameView`.
- `GameView` should remain a component extending `LayoutRoot`.

## Style/conventions
- Prefer `@/...` imports for `src` modules (configured in `tsconfig.json`).
- Keep runtime behavior unchanged unless needed to fix broken references introduced by your edit.
- If adding Pixi rendering/layout logic, respect existing dirty-flag flow:
  - layout dirty => render dirty
  - render dirty does not always imply layout dirty

## Validation
- Run available checks after edits (`npm run build` at minimum) and report failures with likely cause.
