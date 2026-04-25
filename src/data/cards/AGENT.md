# AGENT.md

## Purpose
Raw card dataset JSON files and loader wiring for card definitions.

## Important files
- `definitions.ts`: loads/normalizes JSON card definitions for client use.
- `*.json`: source card/type data grouped by domain.

## Conventions
- Keep JSON schema consistent across files (`id`, styling, display metadata as expected by loaders).
- Prefer editing JSON content over hardcoding special cases in renderer code.
- Validate colors/fields so `normalizeCardColors` consumers remain stable.

## Pitfalls
- Duplicate IDs across files can cause nondeterministic lookup behavior depending on load order.
- Large schema changes here require matching updates in definition mapping code.
