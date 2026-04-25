# AGENT.md

## Purpose
Generated SpaceTimeDB client bindings (tables, reducers, procedures, connection glue).

## Rule #1
These files are generated. **Do not hand-edit** files in this directory.

## How to change behavior
- Update SpaceTimeDB module/schema source and regenerate bindings via the project’s generation workflow.
- If regeneration is out-of-scope, add wrapper/adaptor code outside this directory.

## Usage notes
- Import generated types and reducers from here, but keep app-specific logic in `src/spacetime/` or higher-level modules.
- Preserve generated lint-disable banners and casing.
