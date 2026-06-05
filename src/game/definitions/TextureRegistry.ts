/** Client-side wrapper around the texture registry built from
 *  `content/cards/objects.json`. Initialized once after the wasm
 *  module boots; every lookup thereafter is a plain Map get with no
 *  wasm crossing.
 *
 *  The registry is keyed by object name. Each entry maps to one
 *  `master/<name>/` pack folder on disk — pack name and object name
 *  are the same string. Cards reference an object via
 *  `object: { name }` / `texture: { name }`; tile stock referencing
 *  an aspect of the same name (e.g. `pine`) auto-pairs to the
 *  same-named object. */

import { sharedContent } from "./contentBoot";

export interface TextureScale {
  min: number;
  max: number;
}

/** Fractional sprite pivot point. `(0, 0)` = top-left, `(1, 1)` =
 *  bottom-right, `(0.5, 0.5)` = centre. Values may sit outside
 *  `[0, 1]` (pivot above / below the sprite's frame).
 *
 *  Mirrors `RenderAnchor` in `content/src/definition_core.rs`; the
 *  JSON shape is `{ "anchor": { "x": <n>, "y": <n> } }` on the
 *  entry in `content/cards/objects.json`. Defaults to `(0.5, 0.5)`
 *  when omitted. */
export interface TextureAnchor {
  x: number;
  y: number;
}

export interface TextureDefinition {
  id: number;
  /** Object name — same string used as the pack-folder name
   *  (`master/<name>/`). */
  name: string;
  /** Native pixel size of the source asset. */
  size: number;
  scale: TextureScale;
  /** Sprite pivot point — the renderer applies this on every sync,
   *  so a texture's anchor takes effect even when a pooled sprite
   *  is reused with a different anchor than its previous tenant. */
  anchor: TextureAnchor;
}

export class TextureRegistry {
  private readonly defs: readonly TextureDefinition[];
  private readonly byName: Map<string, TextureDefinition>;

  constructor(defs: readonly TextureDefinition[]) {
    this.defs = defs;
    this.byName = new Map();
    for (const d of defs) {
      this.byName.set(d.name, d);
    }
  }

  all(): readonly TextureDefinition[] {
    return this.defs;
  }

  /** Look up a texture definition by object name. Returns `undefined`
   *  if no object with that name is registered. Card-side art
   *  lookups (`object: { name }`, `texture: { name }`) and aspect-
   *  name-auto-paired tile-decoration lookups both resolve here. */
  find(name: string): TextureDefinition | undefined {
    return this.byName.get(name);
  }

  /** Unique `(name, size)` pairs across all registered objects.
   *  One pair per pack-folder to bake at startup. */
  objectGroups(): Array<{ objectKey: string; size: number }> {
    const seen = new Map<string, { objectKey: string; size: number }>();
    for (const d of this.defs) {
      const k = `${d.name}:${d.size}`;
      if (!seen.has(k)) seen.set(k, { objectKey: d.name, size: d.size });
    }
    return [...seen.values()];
  }
}

let registry: TextureRegistry | null = null;

/** Build the client-side texture registry from the wasm module.
 *  Call synchronously after `initDefinitions()` resolves. */
export function initTextures(): void {
  const raw = JSON.parse(sharedContent().allTextures()) as TextureDefinition[];
  registry = new TextureRegistry(raw);
}

/** Return the initialized registry. Throws if `initTextures()` was not
 *  called first. */
export function getTextureRegistry(): TextureRegistry {
  if (!registry) throw new Error("TextureRegistry not initialized — call initTextures() first");
  return registry;
}
