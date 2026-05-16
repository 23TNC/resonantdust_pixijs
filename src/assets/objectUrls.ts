/**
 * Build-time discovery of all object texture PNGs under
 * `public/textures/cards/objects/`. A single broad glob captures every
 * folder at once so Vite bundles them all; `objectUrlsFor` then
 * filters to the specific `{size}_{objectKey}_pack/` folder at runtime.
 *
 * import.meta.glob must be a static literal — it is evaluated by Vite
 * at build time. The `/public` prefix is stripped to produce the URL
 * path the dev server (and production build) serve the files at.
 */
const ALL_OBJECT_URLS = import.meta.glob("/public/textures/cards/objects/**/*.png");

function stripPublic(k: string): string {
  return k.replace(/^\/public/, "");
}

/** Every object texture URL discoverable at build time. Pass to
 *  `Assets.load` at startup to warm the browser cache for all packs
 *  in parallel with other init work. */
export function allObjectUrls(): readonly string[] {
  return Object.keys(ALL_OBJECT_URLS).map(stripPublic).sort();
}

/** URLs for a specific `{size}_{objectKey}_pack` folder, e.g.
 *  `objectUrlsFor(256, "tree")` → all PNGs in `256_tree_pack/`. */
export function objectUrlsFor(size: number, objectKey: string): readonly string[] {
  const prefix = `/textures/cards/objects/${size}_${objectKey}_pack/`;
  return Object.keys(ALL_OBJECT_URLS)
    .map(stripPublic)
    .filter(url => url.startsWith(prefix))
    .sort();
}
