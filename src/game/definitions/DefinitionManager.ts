/** Wasm-backed wrapper around the `resonantdust-content` crate's
 *  `definition_core`. The crate is compiled to wasm via `bin/content wasm`,
 *  which runs `cargo build --target wasm32-unknown-unknown --features js`
 *  + `wasm-bindgen` and emits
 *  `content/pkg/resonantdust_content.{js,wasm,d.ts}`. The pixijs symlink at
 *  `pixijs/src/content` makes that package importable from here.
 *
 *  Bootstrap: call `initDefinitions()` once during `main.ts` startup,
 *  before constructing anything that uses `DefinitionManager`. The wasm
 *  module needs its `init()` awaited before any export is callable. */

import init, {
  aspectInfo as wasmAspectInfo,
  cardLabel as wasmCardLabel,
  decodeDefinition as wasmDecode,
  findPackedByKey as wasmFindPackedByKey,
  findRecipeByKey as wasmFindRecipeByKey,
  isHexType as wasmIsHexType,
  cardFlagBit as wasmCardFlagBit,
  cardFlagFieldValue as wasmCardFlagFieldValue,
  cardTypeId as wasmCardTypeId,
  matchMagneticRecipe as wasmMatchMagneticRecipe,
  matchStackRecipe as wasmMatchStackRecipe,
  starterPacksForSoul as wasmStarterPacksForSoul,
  traitValue as wasmTraitValue,
} from "../../content/pkg/resonantdust_content";
import type { StackMatch } from "../actions/ActionManager";

/** Shape returned by `wasm_api::aspect_info`. Matches the Rust `Aspect` struct. */
export interface AspectInfo {
  id: number;
  name: string;
  description: string;
  icon: string;
  group: string;
}

export interface StarterPackItem {
  cardKey: string;
  packedDefinition: number;
  count: number;
}

/** A starter pack offered to a player creating a character of a
 *  given soul. Mirrors `StarterPack` from the content crate. */
export interface StarterPack {
  id: number;
  soul: string;
  packId: string;
  contents: readonly StarterPackItem[];
}

export interface CardDefinition {
  cardType: number;
  /** 1-based id within the type's bucket. u12 (1..=4095) since the
   *  `card_category` dimension was retired — see
   *  docs/CATEGORY_RETIRE_AND_TILE_EXPAND.md. */
  definitionId: number;
  /** Programmatic key from the JSON, e.g. `"axe"`. Stable identifier
   *  used as the lookup key in `content/locales/cards/<lang>.json`
   *  for display label / description resolution. Display labels are
   *  NOT carried on the definition itself — clients resolve them via
   *  the locales registry; the bare key is the dev-side fallback. */
  key: string;
  /** Style array. Indices 0-2 are CSS hex colors `[primary, secondary, outline]`.
   *  Optional indices 3-4 are sprite filenames (`""` = none): 3 = bg sprite, 4 = fg sprite. */
  style: readonly string[];
  /** `(aspectId, value)` pairs. */
  aspects: ReadonlyArray<readonly [number, number]>;
  /** Bit-mask of flags carried by this definition, built from the JSON
   *  card's `flags: string[]` array. Server-side `cards::create` ORs
   *  this into every spawned card's `flags` column, so a despair card
   *  spawns already drop-locked + surface-locked without any extra
   *  call-site bookkeeping. Same `cards/flags.json` bit positions the
   *  rest of the codebase uses. */
  flags: number;
  /** Magnetic-resolution recipe key, for cards that declare a
   *  `magnetic` block in their JSON def. `null`/`undefined` for
   *  non-magnetic cards. Consumed by `LifecycleResolutionManager` to
   *  look up the success recipe to submit via `proposeAction`. */
  lifecycleRecipeKey?: string | null;
  /** Magnetic phase duration in milliseconds. Phase ends at
   *  `installRow.validAtTime + lifecycleDurationMs`. `null`/`undefined`
   *  for non-magnetic cards. */
  lifecycleDurationMs?: number | null;
}

/** Compact view of a recipe returned by `findRecipeByKey`. Matches
 *  the `RecipeBrief` shape on the wasm side. */
export interface RecipeBrief {
  /** Packed recipe id — pass to `proposeAction` as `recipeId`. */
  recipeIndex: number;
  /** `"stack" | "magnetic" | "on_create"`. */
  recipeType: "stack" | "magnetic" | "on_create";
  /** `0 = up, 1 = down`. Meaningful for `stack` and `magnetic`;
   *  always `0` for `on_create`. */
  direction: number;
  slotCount: number;
  hasRoot: boolean;
  hasHex: boolean;
}

/** Shape returned by `matchMagneticRecipe` — same as `StackMatch` on
 *  the stack-matcher side, just for magnetic recipes. */
export interface MagneticMatch {
  recipeIndex: number;
  slotStart: number;
  slotCount: number;
  hasRoot: boolean;
  hasHex: boolean;
}

let initialized = false;
let initPromise: Promise<unknown> | null = null;

/** Boot the wasm-built content crate. Idempotent — `init()` runs once;
 *  subsequent calls return the same in-flight promise. Must be awaited
 *  before any DefinitionManager method is called. */
export async function initDefinitions(): Promise<void> {
  if (initialized) return;
  if (!initPromise) {
    initPromise = init().then(() => {
      initialized = true;
    });
  }
  await initPromise;
}

export class DefinitionManager {
  /** Look up an aspect by numeric id. Returns `null` for id 0 (ASPECT_NONE)
   *  and unknown ids. Includes `name`, `description`, `icon`, and `group`. */
  aspectInfo(id: number): AspectInfo | null {
    const raw = wasmAspectInfo(id);
    return raw === null ? null : (raw as AspectInfo);
  }

  /** Decode a packed `(cardType:u4 | definitionId:u12)` value into
   *  its CardDefinition. Returns `null` if no card matches. */
  decode(packed: number): CardDefinition | null {
    const raw = wasmDecode(packed);
    return raw === null ? null : (raw as CardDefinition);
  }

  /** Resolve the display label for a packed definition in the given
   *  language (defaults to `"en"`). Falls back to the card's bare key
   *  when the locale registry has no entry for it. */
  label(packedDef: number, lang = "en"): string {
    try {
      const text = wasmCardLabel(packedDef, lang);
      if (typeof text === "string") return text;
    } catch {
      // locale registry build failure — fall through to key fallback
    }
    return this.decode(packedDef)?.key ?? "?";
  }

  /** Look up a card's packed value by its bare key (e.g. `"fatigue"`).
   *  Returns `undefined` if no card has that key. */
  findPackedByKey(key: string): number | undefined {
    return wasmFindPackedByKey(key);
  }

  /** Card shape ("rect" | "hex") for a `cardType` id. Returns `undefined`
   *  for unknown type ids. */
  shape(typeId: number): "rect" | "hex" | undefined {
    try {
      return wasmIsHexType(typeId) ? "hex" : "rect";
    } catch {
      return undefined;
    }
  }

  /** Bit position (0..=7) of a card-flag by name (e.g. `"drop_hold"`,
   *  `"position_locked"`, `"dead"`). Returns `undefined` for unknown
   *  flag names. Source of truth is `content/cards/flags.json`'s `cards`
   *  section. */
  cardFlagBit(name: string): number | undefined {
    return wasmCardFlagBit(name);
  }

  /** Bit mask (`1 << bit`) for a card-flag by name. Returns `0` for
   *  unknown flag names — making `(row.flags & mask) !== 0` evaluate
   *  to false, which is the safe default for the absent case. */
  cardFlagMask(name: string): number {
    const bit = wasmCardFlagBit(name);
    return bit === undefined ? 0 : 1 << bit;
  }

  /** Convenience: is the named flag set in `flags`? Returns false for
   *  unknown flag names and for cards whose bit is clear. */
  hasCardFlag(flags: number, name: string): boolean {
    const mask = this.cardFlagMask(name);
    return mask !== 0 && (flags & mask) !== 0;
  }

  /** Read the value of a multi-bit card-flag field (e.g.
   *  `"progress_style"`, `"position_hold_count"`) out of `flags`.
   *  Returns `undefined` for unknown field names (callers should
   *  treat that as "field absent"; for predicates like "is held"
   *  test `> 0`). */
  cardFlagFieldValue(flags: number, name: string): number | undefined {
    return wasmCardFlagFieldValue(flags, name);
  }

  /** Look up a `card_type` id by name (e.g. `"mini_zone"`, `"soul"`).
   *  Returns `undefined` for unknown names. Source of truth is
   *  `content/cards/types.json`. Used to branch on card type
   *  without hard-coding numeric ids. */
  cardTypeId(name: string): number | undefined {
    return wasmCardTypeId(name);
  }

  /** Read the numeric value of a named trait off a packed card
   *  definition. Returns `null` when the trait isn't declared in
   *  `traits.json`, the def doesn't carry that trait, or the packed
   *  id doesn't resolve. Pairs 1:1 with the server's
   *  `def.trait_value(trait_id(name))` lookup so client and server
   *  agree on cost / speed numbers by construction. */
  traitValue(packedDefinition: number, name: string): number | null {
    const v = wasmTraitValue(packedDefinition, name);
    return v === undefined ? null : v;
  }

  /** True iff this `packedDefinition`'s `card_type` matches the
   *  given type name. Decodes the def and compares card_type. Returns
   *  false for unknown packed ids or unknown type names. */
  isCardType(packedDefinition: number, typeName: string): boolean {
    const typeId = this.cardTypeId(typeName);
    if (typeId === undefined) return false;
    const def = this.decode(packedDefinition);
    return def !== null && def.cardType === typeId;
  }

  /** Find the best-matching `Stack(direction)` recipe for a chain.
   *  `hexDef` is the packed definition of the hex card the chain root
   *  is attached to (`0` if not stacked on hex). `rootDef` is the
   *  loose root's packed definition. `slotDefs` are the packed
   *  definitions of cards stacked in `direction` ("up" or "down") from
   *  the root, in chain order.
   *
   *  `hasCandidates.{root,actor}{Above,Below}` are the packed defs of
   *  cards currently on each role's soul stack in each direction —
   *  feeds the `has` / `reagents.has` / `has_below` predicate filter.
   *  An empty array for a pool means "nothing on that soul stack in
   *  that direction": recipes whose has-predicates require a card
   *  there will be filtered out. Pass `{}` (all pools empty) to
   *  disable the predicate filter for callers that don't care (e.g.
   *  recipe matching against synthetic-hex-only chains).
   *
   *  Returns a `StackMatch` describing the match (including the slot
   *  window for actor sliding) or `null` if no recipe matched. */
  matchStackRecipe(
    hexDef: number,
    rootDef: number,
    slotDefs: readonly number[],
    direction: "up" | "down",
    hasCandidates?: {
      rootAbove?: readonly number[];
      actorAbove?: readonly number[];
      rootBelow?: readonly number[];
      actorBelow?: readonly number[];
    },
  ): StackMatch | null {
    const dirCode = direction === "up" ? 0 : 1;
    const rootAbove = new Uint16Array(hasCandidates?.rootAbove ?? []);
    const actorAbove = new Uint16Array(hasCandidates?.actorAbove ?? []);
    const rootBelow = new Uint16Array(hasCandidates?.rootBelow ?? []);
    const actorBelow = new Uint16Array(hasCandidates?.actorBelow ?? []);
    const raw = wasmMatchStackRecipe(
      hexDef,
      rootDef,
      new Uint16Array(slotDefs),
      dirCode,
      rootAbove,
      actorAbove,
      rootBelow,
      actorBelow,
    ) as unknown;
    return raw === null ? null : (raw as StackMatch);
  }

  /** Look up a recipe by its tree-key (e.g. `"despair_success"`).
   *  Returns a compact `RecipeBrief` (packed id, type, direction,
   *  slot count) or `null` if no recipe exists with that key.
   *
   *  Used by `LifecycleResolutionManager` to resolve a magnetic card
   *  def's `lifecycleRecipeKey` into the data needed to drive a
   *  `proposeAction` call. */
  findRecipeByKey(key: string): RecipeBrief | null {
    const raw = wasmFindRecipeByKey(key);
    return raw === null ? null : (raw as RecipeBrief);
  }

  /** Try a single-shot match against the magnetic recipe declared by
   *  `rootDef`'s magnetic key. `slotDefs` must list packed
   *  definitions in the recipe's declared slot order. Returns a
   *  `MagneticMatch` on hit or `null` if predicates fail / the root
   *  isn't magnetic / direction mismatch.
   *
   *  Use this to validate a candidate `(root, slots)` combination
   *  before submitting a `proposeAction` — failures here would also
   *  be rejected server-side, but client-side pre-check avoids the
   *  reducer call and surfaces a friendlier error path. */
  matchMagneticRecipe(
    rootDef: number,
    slotDefs: readonly number[],
    direction: "up" | "down",
    hasCandidates?: {
      rootAbove?: readonly number[];
      actorAbove?: readonly number[];
      rootBelow?: readonly number[];
      actorBelow?: readonly number[];
    },
  ): MagneticMatch | null {
    const dirCode = direction === "up" ? 0 : 1;
    const rootAbove = new Uint16Array(hasCandidates?.rootAbove ?? []);
    const actorAbove = new Uint16Array(hasCandidates?.actorAbove ?? []);
    const rootBelow = new Uint16Array(hasCandidates?.rootBelow ?? []);
    const actorBelow = new Uint16Array(hasCandidates?.actorBelow ?? []);
    const raw = wasmMatchMagneticRecipe(
      rootDef,
      new Uint16Array(slotDefs),
      dirCode,
      rootAbove,
      actorAbove,
      rootBelow,
      actorBelow,
    ) as unknown;
    return raw === null ? null : (raw as MagneticMatch);
  }

  /** All starter packs registered for the given soul card key
   *  (e.g. `"human"`), in stable-id order. Empty array for unknown
   *  soul keys — there's no enum of valid souls on the client, so
   *  callers pass whatever key the soul-create panel offers. */
  starterPacksForSoul(soul: string): StarterPack[] {
    const raw = wasmStarterPacksForSoul(soul) as unknown;
    return raw as StarterPack[];
  }

  /** Static unpack of a `packedDefinition` u16. Bit layout matches
   *  `pack_definition` in `content/src/packed.rs`:
   *    high u4  = cardType
   *    low u12  = definitionId
   *  (The middle `cardCategory` u4 was retired — see
   *  docs/CATEGORY_RETIRE_AND_TILE_EXPAND.md.) */
  static unpack(packedDef: number): {
    typeId: number;
    definitionId: number;
  } {
    return {
      typeId: (packedDef >> 12) & 0xf,
      definitionId: packedDef & 0xfff,
    };
  }

  /** Inverse of `unpack`. Same bit layout as Rust's `pack_definition`. */
  static pack(typeId: number, definitionId: number): number {
    return ((typeId & 0xf) << 12) | (definitionId & 0xfff);
  }
}
