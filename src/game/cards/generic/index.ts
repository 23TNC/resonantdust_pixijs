/**
 * Generic, DSL-driven card rendering — a shape-agnostic card built from a flat
 * list of visual primitives, reconciled into retained Pixi objects that ease
 * toward author-set targets. Runs alongside the legacy `RectCard`/`HexCard`
 * during migration; replaces them once every card renders through it.
 *
 * Layering (bottom-up):
 *   - `visualSpec`     the data contract (PrimList / VisualNode)
 *   - `cardBox`        normalized 0..100 → px + LOD footprint (dpr-aware)
 *   - `resolveAsset`   the single LodTextureManager consumer (the soul fix)
 *   - `primitives`     retained backings (FillPrim / SpritePrim / TextPrim)
 *   - `PrimitiveLayer` by-index reconciler + tween host
 *   - `drawVisuals`    the wasm `:visuals` → PrimList bridge (the live spec source)
 *   - `LayoutGenericCard` the card object
 */
export * from "./visualSpec";
export * from "./cardBox";
export * from "./resolveAsset";
export * from "./primitives";
export * from "./drawVisuals";
export { atlasWhite, atlasHex } from "./atlasFills";
export { PrimitiveLayer } from "./PrimitiveLayer";
export { LayoutGenericCard } from "./LayoutGenericCard";
