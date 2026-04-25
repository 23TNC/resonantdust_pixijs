# AGENT.md

## Purpose
Global Pixi application context helpers.

## Important files
- `AppContext.ts`: `setApp/getApp` singleton-style access to the initialized Pixi `Application`.
- `index.ts`: re-export entrypoint.

## Conventions
- `setApp` should be called once during startup (`main.ts`) before layout roots bind resize events.
- Call `getApp()` only when app initialization is guaranteed.

## Pitfalls
- Accessing `getApp()` too early throws by design; keep startup order intact.
