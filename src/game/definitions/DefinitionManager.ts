/** Stub pending the wasm-built `data/pkg/` shim — see `data/src/definition_core.rs`
 *  for the canonical Rust source. The `CardDefinition` shape mirrors the JSON-
 *  decoded definition rows that `definition_core::decode_definition` returns;
 *  the stub `DefinitionManager` returns `null` from every lookup so callers
 *  fall through to their default styling / fallbacks. Replace the class body
 *  with thin wasm-export wrappers once the build pipeline lands. */

export interface CardDefinition {
  packed: number;
  typeId: number;
  categoryId: number;
  definitionId: number;
  key: string;
  typeName: string;
  categoryName: string;
  name: string;
  style: readonly string[];
  aspects: readonly unknown[];
}

export class DefinitionManager {
  decode(_packed: number): CardDefinition | null {
    return null;
  }

  static unpack(_packed: number): {
    typeId: number;
    categoryId: number;
    definitionId: number;
  } {
    return { typeId: 0, categoryId: 0, definitionId: 0 };
  }

  shape(_typeId: number): "rect" | "hex" | undefined {
    return undefined;
  }
}
