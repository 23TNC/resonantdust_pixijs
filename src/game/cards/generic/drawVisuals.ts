import { sharedContent, sharedLocales } from "../../definitions/contentBoot";
import type { PrimKind, PrimList, Vec2 } from "./visualSpec";

/**
 * Client entry to the VM's `:visuals` render. Calls the wasm
 * `Content.drawVisuals` (runs the card's `:data`+`:visuals` hooks against `host`
 * and serializes the engine `prims` list the `^` constructors filled), then maps
 * the `PrimNode` JSON onto the client `VisualNode[]` the reconciler draws.
 *
 * Two client-side adaptations the definition deliberately stays out of:
 *  - `texture` arrives as a bare asset name → wrapped as `{ name }`.
 *  - `text` arrives as a locale KEY → resolved here via the locales runtime
 *    (definitions never decode locales).
 */

/** Instance state the VM's `:visuals` hooks read (`*faction`, `*aspect.*`, UI
 *  flags). Flat: numbers → Int/Float, strings → Sym (see the wasm `parse_host`). */
export type VisualHost = Record<string, number | string>;

interface PrimNodeJson {
  kind: string;
  pos: Vec2;
  size: Vec2;
  anchor?: Vec2;
  scale: number;
  rot: number;
  alpha: number;
  tint: number;
  texture?: string;
  /** Variant index pinned from an `asset:variant` texture (card art); unset →
   *  the reconciler picks a variant by seed (tile objects). */
  index?: number;
  text?: string;
}

/** Map the wasm `PrimNode` JSON onto the client `VisualNode[]` — wrap texture
 *  names as `{name}`, resolve `text` locale keys via the locales runtime. */
function mapPrims(nodes: PrimNodeJson[]): PrimList {
  const loc = sharedLocales();
  return nodes.map((n) => ({
    kind: n.kind as PrimKind,
    pos: n.pos,
    size: n.size,
    anchor: n.anchor,
    scale: n.scale,
    rot: n.rot,
    alpha: n.alpha,
    tint: n.tint,
    texture: n.texture != null ? { name: n.texture, index: n.index } : null,
    text: n.text != null ? (loc.string(n.text) ?? n.text) : undefined,
  }));
}

export function drawVisuals(packed: number, host: VisualHost, hook: "init" | "update"): PrimList {
  return mapPrims(JSON.parse(sharedContent().drawVisuals(packed, JSON.stringify(host), hook)) as PrimNodeJson[]);
}

/**
 * Render a world tile to a `PrimList` from its stored stock (the two zone stock
 * slots). The LOD variant + faction are chosen client-side by the reconciler's
 * `PrimDeps` (seed = the tile's `(q,r)` hash, faction = the viewport faction).
 */
export function tilePrims(packed: number, stock0: number, stock1: number): PrimList {
  return mapPrims(JSON.parse(sharedContent().tilePrims(packed, stock0, stock1)) as PrimNodeJson[]);
}
