/**
 * The visual spec — the data contract between the content runtime (the DSL
 * `:visuals @draw` hook, via wasm) and the client renderer. A card's
 * presentation is a flat list of primitive records; the renderer reconciles
 * that list into retained Pixi objects and eases each toward its target.
 *
 * This is the ONLY shape the DSL has to emit. The wasm `drawVisuals` /
 * `tilePrims` bridge produces it from a card's `:visuals` hook (the `^`
 * prim constructors filling the engine `prims` list).
 *
 * **Units.** `pos` / `size` are **pixels** — the DSL sources them from
 * `<globals>` (card/cell dimensions) and asset px, so the renderer places them
 * absolutely (no box normalization; dpr folds into the LOD footprint only — see
 * `CardBox`). `anchor` is a 0..100 pivot; `scale` is the multiplier.
 *
 * **Index = identity.** A node's position in the array is its paint order AND
 * its reconciliation key. The set is expected to be stable per card type;
 * conditional UI toggles via `alpha`, it does not add/remove (keeps the
 * reconciler a cheap by-index diff).
 */

export type PrimKind = "rect" | "hex" | "text" | "sprite" | "progress" | "mask";

export interface Vec2 {
  x: number;
  y: number;
}

/** Reference to a LOD-pyramid asset (sprite art, or a textured fill). `name`
 *  is the aspect/object catalog key; `index` pins `<index>.png`, else the
 *  renderer picks pseudo-randomly per seed. */
export interface AssetRef {
  name: string;
  index?: number;
}

/** The numeric fields the engine eases `current → target`. A primitive's
 *  discrete fields (`kind`, `texture`, `text`) are applied immediately on
 *  update; these interpolate. `tint` eases per-channel. */
export interface AnimatableFields {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  rot: number;
  alpha: number;
  tint: number;
}

export interface VisualNode {
  kind: PrimKind;
  /** Anchor-point location in card-space (0..100). */
  pos: Vec2;
  /** Extent in card-space (0..100). For `sprite` this drives the LOD
   *  footprint; for `text` `size.y` drives font size. */
  size: Vec2;
  /** Pivot, 0..100 of the node's own box (default {0,0} = top-left;
   *  {50,50} = centred). */
  anchor?: Vec2;
  /** Authoring multiplier on top of the fitted size (default 1). */
  scale?: number;
  /** Rotation in radians (default 0). */
  rot?: number;
  /** 0..1 (default 1). Absence of a conditional element is `alpha: 0`. */
  alpha?: number;
  /** Multiplicative tint, 0xRRGGBB (default white = untinted). For a `rect`/
   *  `hex` fill this IS the fill colour (white texture × tint). */
  tint?: number;
  /** Art for `sprite`, or a textured fill for `rect`/`hex`. Null/absent =
   *  solid tinted fill (fills) or hidden (sprite). */
  texture?: AssetRef | null;
  /** Resolved display string for `text` (already localised). */
  text?: string;
  /** `progress` primitive: which progress row to TRACK — an index into the
   *  card's progress list (`*d.progress.<i>.id`). The DSL doesn't compute the
   *  fill (it's not run per-frame); the engine resolves `target` to the row's
   *  timing and fills the bar live. */
  target?: number;
  /** `progress` primitive: the bar style (`*d.progress.<i>.style`; 1 = ltr,
   *  2 = rtl, …). The DSL chooses it — needn't come from the row. */
  style?: number;
  /** Intra-card paint order (`&h.z set`). Higher draws on top. Unset → the
   *  reconciler uses the array index (push order), so `title` (last) stays on
   *  top without anyone setting it. Orthogonal to the card's stack z. */
  z?: number;
  /** `progress` fill source: unset/0 = a progress row (via `target`), 1 = the
   *  action queue/debounce fraction (`deps.queue`). */
  source?: number;
  /** Optional seed for `current` on first creation, so the primitive eases in
   *  from this state instead of snapping to target (e.g. `{ alpha: 0 }`). */
  enter?: Partial<AnimatableFields>;
}

/** A card's full presentation. Index = reconciliation key; paint order is each
 *  node's `z` (falling back to the index when unset). */
export type PrimList = VisualNode[];
