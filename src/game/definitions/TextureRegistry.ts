/** Client-side wrapper around the texture registry built from
 *  `content/textures/`. Initialized once after the wasm module boots;
 *  every lookup thereafter is a plain Map get with no wasm crossing. */

import { allTextures as wasmAllTextures } from "../../content/pkg/resonantdust_content";

export interface TextureScale {
  min: number;
  max: number;
}

export interface TextureDefinition {
  id: number;
  cardType: number;
  aspectId: number;
  /** Aspect name this texture is keyed under, e.g. `"wood"`. */
  aspectName: string;
  /** Bare object key of the depicted object, e.g. `"tree"`. */
  object: string;
  /** Native pixel size of the source asset. */
  size: number;
  scale: TextureScale;
}

export class TextureRegistry {
  private readonly defs: readonly TextureDefinition[];
  private readonly byPath: Map<string, TextureDefinition>;

  constructor(defs: readonly TextureDefinition[]) {
    this.defs = defs;
    this.byPath = new Map();
    for (const d of defs) {
      this.byPath.set(`${d.cardType}:${d.aspectName}`, d);
    }
  }

  all(): readonly TextureDefinition[] {
    return this.defs;
  }

  /** Look up a texture definition by `(cardType, aspectKey)`.
   *  Returns `undefined` if no texture is registered for that pair.
   *  (The `cardCategory` axis was retired — see
   *  docs/CATEGORY_RETIRE_AND_TILE_EXPAND.md.) */
  find(cardType: number, aspectKey: string): TextureDefinition | undefined {
    return this.byPath.get(`${cardType}:${aspectKey}`);
  }

  /** Unique `(object, size)` pairs across all registered textures.
   *  These are the atlas categories to bake at startup — one call to
   *  `bakeObjectCategory` per entry. */
  objectGroups(): Array<{ objectKey: string; size: number }> {
    const seen = new Map<string, { objectKey: string; size: number }>();
    for (const d of this.defs) {
      const k = `${d.object}:${d.size}`;
      if (!seen.has(k)) seen.set(k, { objectKey: d.object, size: d.size });
    }
    return [...seen.values()];
  }
}

let registry: TextureRegistry | null = null;

/** Build the client-side texture registry from the wasm module.
 *  Call synchronously after `initDefinitions()` resolves. */
export function initTextures(): void {
  const raw = wasmAllTextures() as TextureDefinition[];
  registry = new TextureRegistry(raw);
}

/** Return the initialized registry. Throws if `initTextures()` was not
 *  called first. */
export function getTextureRegistry(): TextureRegistry {
  if (!registry) throw new Error("TextureRegistry not initialized — call initTextures() first");
  return registry;
}
