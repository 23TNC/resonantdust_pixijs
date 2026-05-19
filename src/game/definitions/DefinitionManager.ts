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
  aspectIdByName as wasmAspectIdByName,
  cardLabel as wasmCardLabel,
  decodeDefinition as wasmDecode,
  findPackedByKey as wasmFindPackedByKey,
  isHexType as wasmIsHexType,
  cardFlagBit as wasmCardFlagBit,
  cardFlagFieldValue as wasmCardFlagFieldValue,
  cardTypeId as wasmCardTypeId,
  recipeById as wasmRecipeById,
  recipeByKey as wasmRecipeByKey,
  recipesAll as wasmRecipesAll,
  starterPacksForSoul as wasmStarterPacksForSoul,
  starterBlueprintsForSoul as wasmStarterBlueprintsForSoul,
  blueprintById as wasmBlueprintById,
  blueprintByKey as wasmBlueprintByKey,
  allBlueprints as wasmAllBlueprints,
  traitValue as wasmTraitValue,
} from "../../content/pkg/resonantdust_content";
import {
  findRecipeMatch as findRecipeMatchInternal,
  type CardRow as MatcherCardRow,
  type MatchResult,
  type Recipe,
  type RecipeEntry,
} from "../actions/recipeMatcher";

/** Shape returned by `wasm_api::aspect_info`. Matches the Rust `Aspect` struct. */
export interface AspectInfo {
  id: number;
  name: string;
  description: string;
  icon: string;
  /** Display color packed as `0xRRGGBB`. Sub-aspects inherit their
   *  parent's color when their JSON entry omits the field, so all
   *  members of a family render with the same hue out of the box.
   *  Pass directly to PIXI: `gfx.fill({ color: info.color })`. */
  color: number;
  /** Top-level family — the root-ancestor's name. `berry.group === "food"`
   *  even though `berry`'s direct parent is `food`; the chain is collapsed
   *  to the top so renderers can group by family without walking. */
  group: string;
  /** Direct parent aspect id, or `null` for top-level entries. Forms the
   *  single-inheritance tree the recipe matcher walks for `Entity::Aspect`
   *  widening (a card carrying `corpus++` satisfies `{aspect: corpus}`).
   *  Renderers use this to distinguish sub-aspects of the same parent
   *  (e.g. `corpus+` vs `corpus--`) — the parent supplies the icon and
   *  family colour, the leaf-name suffix supplies the polarity badge. */
  parent: number | null;
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

/** A blueprint catalog entry. Mirrors `Blueprint` from the content
 *  crate. Two card references: `blueprint*` is the card the UI draws
 *  when the blueprint is discovered (wrench panel, character-create
 *  preview); `card*` is the output card produced when the blueprint
 *  is built in-world (may be folded into a different schema later). */
export interface Blueprint {
  /** Stable u16 id from `blueprints/id.json`. */
  id: number;
  /** Blueprint key from the source JSON, e.g. `"nd_furnace"`. */
  key: string;
  /** Blueprint-card key from the JSON body's `blueprint` field. */
  blueprintKey: string;
  /** `packedDefinition` for `blueprintKey` — feed to
   *  `decodeDefinition` / `cardLabel` for the discovered-blueprint
   *  card visual. */
  blueprintPackedDefinition: number;
  /** Output-card key from the JSON body's `card` field. */
  cardKey: string;
  /** `packedDefinition` for `cardKey` — the card produced by
   *  building this blueprint. */
  cardPackedDefinition: number;
}

/** One row-mutable aspect slot on a `CardDefinition`. Mirrors
 *  `StockSlot` from the content crate. Order in the def's `stock`
 *  array maps to the per-tile u2 slots `stock0` / `stock1`. */
export interface StockSlot {
  /** Aspect id this slot tracks. Resolve to a name via
   *  `DefinitionManager.aspectInfo`. */
  aspectId: number;
  /** Cap on the slot's value — `1..=3` (u2 storage). */
  max: number;
  /** Initial value worldgen / spawn paths seed the slot with. */
  default: number;
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
  /** Style array. Exactly 3 entries: CSS hex colors `[primary,
   *  secondary, outline]`. Sprite filenames used to live at indices
   *  3-4; they now live on the top-level [`sprite`] field. */
  style: readonly string[];
  /** Optional sprite filename rendered centred on the card body
   *  (rect cards) or as the foreground overlay (hex cards). Resolved
   *  at runtime against `public/textures/cards/objects/<filename>`.
   *  `null`/`undefined` means "no sprite." */
  sprite?: string | null;
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
  /** Row-mutable aspect slots declared by this def. Each slot's value
   *  lives on the tile row (`Zone.t0..t15` per-tile u2), not on the
   *  def. Empty for defs without row-mutable aspects (i.e. most non-
   *  tile defs). Renderers use these to vary object placement per
   *  remaining stock; the recipe matcher reads row values for
   *  `Entity::Aspect` predicates against the tile.
   *
   *  See [docs/TILE_ASPECTS.md] for the row-mutable / static aspect
   *  split. */
  stock: readonly StockSlot[];
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

  /** Merged "is slot held?" — server's `slot_hold` OR the client-only
   *  `predict_slot_hold` that `ActionManager` sets between proposeAction
   *  dispatch and the round-trip response. Consumers asking "should
   *  I treat this card as committed?" (death-animation deferral,
   *  in-flight skip, lifecycle held-set seed, etc.) use this so the
   *  prediction window is invisible at the read site. */
  isSlotHeld(flags: number): boolean {
    return (
      this.hasCardFlag(flags, "slot_hold") ||
      this.hasCardFlag(flags, "predict_slot_hold")
    );
  }

  /** Merged "is position held?" — `position_hold_count > 0` OR the
   *  client-only `predict_position_hold`. Counterpart to
   *  `isSlotHeld`; same lifecycle on the prediction bit. */
  isPositionHeld(flags: number): boolean {
    const count = this.cardFlagFieldValue(flags, "position_hold_count") ?? 0;
    return count > 0 || this.hasCardFlag(flags, "predict_position_hold");
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

  // ---------- Tape-form recipe API -----

  /** Cached recipe catalog — lazy-loaded on first access via
   *  `recipesAll()`. The wasm registry is build-once-at-init, so
   *  invalidation isn't a concern: one fetch per process. */
  private cachedRecipes: RecipeEntry[] | null = null;

  /** Look up a recipe by its stable u16 id (the value `proposeAction`
   *  takes as `recipeId`). Returns the full Recipe IR
   *  (`{ id, input, output, iterators, anchors }`) or `null` for an
   *  unregistered id. */
  recipeById(id: number): Recipe | null {
    const raw = wasmRecipeById(id);
    return raw === null ? null : (raw as Recipe);
  }

  /** Look up a recipe by its source-key (e.g. `"cut_tree"`).
   *  Returns the full Recipe IR or `null` if no recipe is registered
   *  under that key. */
  recipeByKey(key: string): Recipe | null {
    const raw = wasmRecipeByKey(key);
    return raw === null ? null : (raw as Recipe);
  }

  /** Every registered recipe in priority-tiered order (highest
   *  priority first — see `AnchorSet::priority_key`). Cached on
   *  first call. */
  recipesAll(): RecipeEntry[] {
    if (this.cachedRecipes === null) {
      this.cachedRecipes = wasmRecipesAll() as RecipeEntry[];
    }
    return this.cachedRecipes;
  }

  /** Try to match the player's chain configuration against the
   *  recipe catalog. Returns the highest-priority recipe whose
   *  `input` predicates are satisfied, plus the per-iterator
   *  bindings for `proposeAction`. `null` when no recipe matches.
   *
   *  The caller supplies a card lookup closure (typically wired to
   *  `data.cardsLocal.get(...)`) so the matcher can resolve
   *  `.owner` / `.parent` traversals in path expressions. */
  findRecipeMatch(input: {
    root: number;
    branches: number[][];
    cardLookup(id: number): MatcherCardRow | null;
    /** Synthetic tile under the root, when applicable. Wire `null`
     *  for inventory chains; pass `{ packedDef, stock0, stock1 }`
     *  when the root sits on a world-surface tile with no card
     *  backing it. The matcher uses this to evaluate `slot.0.0.*`
     *  predicates against tile data instead of a card. */
    syntheticTile?: {
      packedDef: number;
      stock0: number;
      stock1: number;
    } | null;
    /** Walk a card's chain in the given direction. Used by the
     *  matcher to resolve nested iterators (equipment-stack
     *  references like `slot.1.0.owner.slot.1.0`). Typically wired
     *  to `cards.buildChain(parentId, direction).map(c => c.cardId)`. */
    branchWalker?(parentId: number, direction: number): readonly number[];
  }): MatchResult | null {
    return findRecipeMatchInternal(
      {
        root: input.root,
        branches: input.branches,
        cardLookup: input.cardLookup,
        cardDefinitionLookup: (packedDef: number) => {
          const def = this.decode(packedDef);
          return def === null
            ? null
            : { key: def.key, aspects: def.aspects, stock: def.stock };
        },
        aspectIdByName: (name: string) => {
          const id = wasmAspectIdByName(name);
          return id === undefined ? null : id;
        },
        aspectParent: (id: number) => {
          const info = wasmAspectInfo(id);
          return info === null
            ? null
            : (info as { parent: number | null }).parent;
        },
        syntheticTile: input.syntheticTile ?? null,
        branchWalker:
          input.branchWalker ?? (() => [] as readonly number[]),
      },
      this.recipesAll(),
    );
  }

  /** Look up an aspect's numeric id by its declared name. Returns
   *  `null` for unknown names. Mirrors
   *  `wasm_api::aspect_id_by_name`. */
  aspectIdByName(name: string): number | null {
    const id = wasmAspectIdByName(name);
    return id === undefined ? null : id;
  }

  /** All starter packs registered for the given soul card key
   *  (e.g. `"human"`), in stable-id order. Empty array for unknown
   *  soul keys — there's no enum of valid souls on the client, so
   *  callers pass whatever key the soul-create panel offers. */
  starterPacksForSoul(soul: string): StarterPack[] {
    const raw = wasmStarterPacksForSoul(soul) as unknown;
    return raw as StarterPack[];
  }

  /** Stable blueprint ids granted to a player creating a character of
   *  the given soul (sourced from the soul's `"blueprints"` array in
   *  `starter_packs/data/*.json`). Resolve each id to a `Blueprint`
   *  via `blueprintById`. Empty array when the soul declares none. */
  starterBlueprintsForSoul(soul: string): number[] {
    const raw = wasmStarterBlueprintsForSoul(soul) as unknown;
    return Array.from(raw as ArrayLike<number>);
  }

  /** Look up a blueprint by its stable u16 id. `null` for unknown
   *  ids and for `BLUEPRINT_NONE` (id 0). */
  blueprintById(id: number): Blueprint | null {
    const raw = wasmBlueprintById(id) as unknown;
    return raw === null || raw === undefined ? null : (raw as Blueprint);
  }

  /** Look up a blueprint by its source-key (e.g. `"nd_furnace"`).
   *  `null` if no blueprint with that key is registered. */
  blueprintByKey(key: string): Blueprint | null {
    const raw = wasmBlueprintByKey(key) as unknown;
    return raw === null || raw === undefined ? null : (raw as Blueprint);
  }

  /** Every registered blueprint in stable-id order. Used by the
   *  wrench panel to enumerate the catalog for display. */
  allBlueprints(): Blueprint[] {
    const raw = wasmAllBlueprints() as unknown;
    return raw as Blueprint[];
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
