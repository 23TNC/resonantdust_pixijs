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
  decodeDefinition as wasmDecode,
  findPackedByKey as wasmFindPackedByKey,
  isHexType as wasmIsHexType,
  cardFlagBit as wasmCardFlagBit,
  matchStackRecipe as wasmMatchStackRecipe,
} from "../../content/pkg/resonantdust_content";
import type { StackMatch } from "../actions/ActionManager";

export interface CardDefinition {
  cardType: number;
  cardCategory: number;
  definitionId: number;
  /** Programmatic key from the JSON, e.g. `"attack"`. Stable across renames. */
  key: string;
  /** Display name. */
  name: string;
  /** Three CSS hex colors `[primary, secondary, outline]`, validated server-side. */
  style: readonly [string, string, string];
  /** `(aspectId, value)` pairs. */
  aspects: ReadonlyArray<readonly [number, number]>;
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
  /** Decode a packed `(cardType:u4 | cardCategory:u4 | definitionId:u8)`
   *  value into its CardDefinition. Returns `null` if no card matches. */
  decode(packed: number): CardDefinition | null {
    const raw = wasmDecode(packed);
    return raw === null ? null : (raw as CardDefinition);
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

  /** Find the best-matching `Stack(direction)` recipe for a chain.
   *  `hexDef` is the packed definition of the hex card the chain root
   *  is attached to (`0` if not stacked on hex). `rootDef` is the
   *  loose root's packed definition. `slotDefs` are the packed
   *  definitions of cards stacked in `direction` ("up" or "down") from
   *  the root, in chain order. Returns a `StackMatch` describing the
   *  match (including the slot window for actor sliding) or `null` if
   *  no recipe matched. */
  matchStackRecipe(
    hexDef: number,
    rootDef: number,
    slotDefs: readonly number[],
    direction: "up" | "down",
  ): StackMatch | null {
    const dirCode = direction === "up" ? 0 : 1;
    const raw = wasmMatchStackRecipe(
      hexDef,
      rootDef,
      new Uint16Array(slotDefs),
      dirCode,
    ) as unknown;
    return raw === null ? null : (raw as StackMatch);
  }

  /** Static unpack of a `packedDefinition` u16. Bit layout matches
   *  `pack_definition` in `content/src/packed.rs`:
   *    high u4  = cardType
   *    mid u4   = cardCategory
   *    low u8   = definitionId */
  static unpack(packedDef: number): {
    typeId: number;
    categoryId: number;
    definitionId: number;
  } {
    return {
      typeId: (packedDef >> 12) & 0xf,
      categoryId: (packedDef >> 8) & 0xf,
      definitionId: packedDef & 0xff,
    };
  }

  /** Inverse of `unpack`. Same bit layout as Rust's `pack_definition`. */
  static pack(typeId: number, categoryId: number, definitionId: number): number {
    return ((typeId & 0xf) << 12) | ((categoryId & 0xf) << 8) | (definitionId & 0xff);
  }
}
