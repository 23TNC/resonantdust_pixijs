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
import type { MacroZone } from "../../data/packing";

// `macro_zone` is the complete packed location key
// `[owner_card_id:u32 | surface:u8 | i12 zoneQ | i12 zoneR]` — a full u64, now
// that the owner band is populated. The client carries it as one decoded
// `MacroZone` object: the `packed` bigint (the equality / `ZoneId` / SQL key)
// plus its unpacked `owner` / `surface` / `zoneQ` / `zoneR`, all derived
// together at the `DataManager` ingestion boundary and kept in lockstep by
// `makeMacroZone()` at write sites (the only place encoding happens). Reads
// (`row.macroZone.surface`, `.owner`, `.zoneQ/.zoneR`) never pack or unpack.
// `micro_zone` was removed; `microLocation` (u32) + the `flagsBk` stacking bits
// stay as raw numbers on the row, decoded via the `Micro` accessors in
// `server/data/packing.ts`.
export type Card = Omit<GenCard, "macroZone"> & { macroZone: MacroZone };
export type Soul = Omit<GenSoul, "macroZone"> & { macroZone: MacroZone };
export type Zone = Omit<GenZone, "macroZone"> & { macroZone: MacroZone };

export type {
  Player,
  PlayerProfile,
  Region,
  SoulPrivate,
  TilePoint,
} from "./shard/types";

export type { ChatMessage } from "./chat/types";
