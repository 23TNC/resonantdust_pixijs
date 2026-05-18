/**
 * Build-time discovery of every card-sprite PNG under
 * `public/textures/cards/`. One broad glob captures everything —
 * world-object packs (`objects/<size>_<obj>_pack/`), requisite-card
 * sprites (`requisites/<...>`), soul portrait packs
 * (`soul/<race>/<...>`), tile-art, etc. Vite bundles them all;
 * helpers below filter / look up by URL or by basename.
 *
 * import.meta.glob must be a static literal — it is evaluated by Vite
 * at build time. The `/public` prefix is stripped to produce the URL
 * path the dev server (and production build) serve the files at.
 */
const ALL_CARD_SPRITE_URLS = import.meta.glob("/public/textures/cards/**/*.png");

function stripPublic(k: string): string {
  return k.replace(/^\/public/, "");
}

/** Filename → URL lookup built once at module load. Card-sprite
 *  PNG basenames (e.g. `128_requisite_8.png`) are unique across the
 *  whole `cards/` tree by convention (each pack folder is named
 *  after its file stem, and indexes don't repeat), so basename → URL
 *  is a single map without ambiguity. A collision would silently
 *  win-last-write; if that ever happens, switch to a (folder,
 *  name)-tuple key. */
const URL_BY_BASENAME: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const key of Object.keys(ALL_CARD_SPRITE_URLS)) {
    const url = stripPublic(key);
    const base = url.slice(url.lastIndexOf("/") + 1);
    map.set(base, url);
  }
  return map;
})();

/** Every card-sprite URL discoverable at build time. Pass to
 *  `Assets.load` at startup to warm the browser cache so subsequent
 *  `Assets.get(url)` calls resolve synchronously. */
export function allCardSpriteUrls(): readonly string[] {
  return [...URL_BY_BASENAME.values()].sort();
}

/** Look up the full URL for a card-sprite basename (with or without
 *  the `.png` suffix). Returns `null` if no matching file exists.
 *  Used by the `applySprite` path on rect / hex card visuals to
 *  resolve a definition's `sprite` field. */
export function cardSpriteUrlFor(filename: string): string | null {
  const name = filename.endsWith(".png") ? filename : `${filename}.png`;
  return URL_BY_BASENAME.get(name) ?? null;
}

/** URLs for a specific `{size}_{objectKey}_pack` folder under
 *  `objects/`, e.g. `objectUrlsFor(256, "tree")` → all PNGs in
 *  `objects/256_tree_pack/`. Restricted to the `objects/` subtree
 *  because ObjectTextureManager picks one at random per `(q, r,
 *  seed)`; widening to other subtrees would mix unrelated packs. */
export function objectUrlsFor(size: number, objectKey: string): readonly string[] {
  const prefix = `/textures/cards/objects/${size}_${objectKey}_pack/`;
  return Object.keys(ALL_CARD_SPRITE_URLS)
    .map(stripPublic)
    .filter(url => url.startsWith(prefix))
    .sort();
}
