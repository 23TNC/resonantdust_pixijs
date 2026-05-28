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

import type {
  Card as GenCard,
  Soul as GenSoul,
  Zone as GenZone,
} from "./shard/types";
import type { MacroLoc } from "../../data/packing";

// The client row carries the macro-location in BOTH forms: the packed
// `macroZone` (a `number` — the low-32-bit location *key*, used directly for
// equality / `ZoneId` keying / subscription SQL / reducer args) and the
// decoded `macro` (a `MacroLoc` — the *coords*, used directly for rendering /
// pathfinding). Holding both means reads never pack or unpack; `DataManager`
// sets both at the ingestion boundary and `macroFields()` keeps them in
// lockstep at write sites (the only place encoding happens). The generated
// `macroZone` is a `bigint` (u64 wire); the client narrows it to `number`
// (safe while the high 32 bits are zero). `micro_zone` / `micro_location` are
// decoded in Phase 2. See `server/data/packing.ts`.
export type Card = Omit<GenCard, "macroZone"> & { macroZone: number; macro: MacroLoc };
export type Soul = Omit<GenSoul, "macroZone"> & { macroZone: number; macro: MacroLoc };
export type Zone = Omit<GenZone, "macroZone"> & { macroZone: number; macro: MacroLoc };

export type {
  Player,
  PlayerProfile,
  SoulPrivate,
  TilePoint,
} from "./shard/types";

export type { ChatMessage } from "./chat/types";
