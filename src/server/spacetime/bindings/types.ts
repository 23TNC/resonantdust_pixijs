// Compatibility barrel — the SpacetimeDB codegen now writes per-module
// bindings under `bindings/shard/` and `bindings/chat/`. The legacy
// top-level paths in this file are kept as re-exports so existing
// userland imports (`import type { Card } from ".../bindings/types"`)
// continue to work without per-file edits.
//
// Add to this file when a new module-side type needs to be reachable
// via the legacy path. Modules with name conflicts (e.g. both shard
// and chat declare `SequenceCounter`) must be re-exported explicitly
// rather than via `export *`.

export type {
  Card,
  Player,
  PlayerProfile,
  Soul,
  TilePoint,
  Zone,
} from "./shard/types";

export type { ChatMessage } from "./chat/types";
