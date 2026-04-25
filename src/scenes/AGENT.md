# AGENT.md

## Purpose
Scene lifecycle and transitions for the Pixi stage.

## Important files
- `SceneManager.ts`: swaps current scene view on stage and forwards `update/resize` lifecycle.
- `LoginScene.ts`: temporary bootstrap/login stub scene.
- `GameScene.ts`: root gameplay scene creating the `GameView`.

## Current flow
1. App starts `LoginScene`.
2. `LoginScene` sets globals in spacetime data (`setPlayerName("player1")`, `setPlayerId(1)`).
3. `LoginScene` transitions immediately to `GameScene`.

## Conventions
- Keep scenes thin: orchestration + lifecycle only.
- Scene visuals should be delegated to UI components (`GameView` etc.), not built inline.
- Avoid obsolete `game_view` wiring patterns; main entry should route through `LoginScene`.

## Pitfalls
- Do not forget to destroy prior scene resources in transitions (handled via `SceneManager.setScene`).
- Maintain `Scene.view` as the stage-attached root container for each scene.
