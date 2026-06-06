import { sharedContent, sharedLocales } from "../../definitions/contentBoot";
import type { AnimatableFields, PrimKind, PrimList, Vec2 } from "./visualSpec";

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

/** A JSON-ish host value: scalars, or NESTED objects/arrays (the wasm
 *  `parse_host` maps these to `Cell::Map`/`Arr`). Nesting is how `^card_data`
 *  hands the DSL a structured record. */
export type HostValue = number | string | boolean | HostValue[] | { [k: string]: HostValue };

/** Instance state the VM's `:visuals` hooks read via `^name call` (`^faction`,
 *  `^card_data`, …). Numbers → Int/Float, strings → Sym, objects/arrays →
 *  Map/Arr (see the wasm `parse_host`). */
export type VisualHost = Record<string, HostValue>;

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
  /** `progress` primitive: row to track + bar style. */
  target?: number;
  style?: number;
  /** Intra-card paint order (`&h.z`); unset → push order. */
  z?: number;
  /** `progress` fill source: unset/0 = a progress row (`target`), 1 = the action
   *  queue/debounce fraction. */
  source?: number;
  /** Seed for `current` on first creation (`&h.enter.<field>`), so the prim eases
   *  in from this state instead of snapping to target (e.g. a `^mask` rolling up
   *  from full height). Partial of the animatable set. */
  enter?: Partial<AnimatableFields>;
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
    target: n.target,
    style: n.style,
    z: n.z,
    source: n.source,
    enter: n.enter,
  }));
}

export function drawVisuals(packed: number, host: VisualHost, hook: "init" | "update" | "destroy"): PrimList {
  return mapPrims(JSON.parse(sharedContent().drawVisuals(packed, JSON.stringify(host), hook)) as PrimNodeJson[]);
}

/**
 * Render a world tile to a `PrimList` from its stored stock (the two zone stock
 * slots). The LOD variant + faction are chosen client-side by the reconciler's
 * `PrimDeps` (faction = the viewport faction). `seed` (the tile's `(q,r)` hash)
 * is handed to the `:visuals` VM as `^seed`, so the ring scatter — slot angles
 * and per-object scale — is deterministic per tile.
 */
export function tilePrims(packed: number, stock0: number, stock1: number, seed: number): PrimList {
  return mapPrims(JSON.parse(sharedContent().tilePrims(packed, stock0, stock1, seed)) as PrimNodeJson[]);
}

/** One tile's inputs for {@link tilePrimsBatch}. */
export interface TileReq {
  packed: number;
  stock0: number;
  stock1: number;
  seed: number;
}

/**
 * Batched {@link tilePrims}: resolve a whole set of tiles in ONE wasm crossing
 * + one `JSON.parse`, instead of one round-trip per tile. Inputs are packed
 * into a flat `Int32Array` (`[packed, stock0, stock1, seed]` per tile — all
 * fit in i32, `packed` is a u16) so the call itself allocates no per-tile
 * strings; only the result (the prim lists) crosses back as JSON. Results are
 * returned in request order.
 */
export function tilePrimsBatch(reqs: readonly TileReq[]): PrimList[] {
  if (reqs.length === 0) return [];
  const flat = new Int32Array(reqs.length * 4);
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i];
    flat[i * 4] = r.packed;
    flat[i * 4 + 1] = r.stock0;
    flat[i * 4 + 2] = r.stock1;
    flat[i * 4 + 3] = r.seed;
  }
  const out = JSON.parse(sharedContent().tilePrimsBatch(flat)) as PrimNodeJson[][];
  return out.map(mapPrims);
}
