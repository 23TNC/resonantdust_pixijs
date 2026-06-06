// Compatibility barrel — SpacetimeDB codegen writes per-module bindings under
// `bindings/{shard,players,chat,regionindex}/`. The legacy top-level paths here
// are kept as re-exports so existing userland imports
// (`import type { Card } from ".../bindings/types"`) keep working without
// per-file edits. Card+soul+zone+region+tile data now all live in the unified
// `shard` module; this barrel hides that from the game code.
//
// Add to this file when a new module-side type needs the legacy path. Types
// with cross-module name conflicts must be re-exported explicitly, not via
// `export *`.

import type { Card as GenCard, Soul as GenSoul } from "./shard/types";
import type { Zone as GenZone } from "./shard/types";
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

export type { Player, PlayerProfile } from "./players/types";
export type { Region } from "./shard/types";
export type { SoulPrivate } from "./shard/types";
export type { ChatMessage } from "./chat/types";
