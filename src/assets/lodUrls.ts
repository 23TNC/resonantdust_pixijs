/**
 * Build-time discovery of every LOD-pyramid PNG under
 * `pixijs/public/textures/lod/`. Layout is
 *
 *   lod/<lodSize>/<aspect>/<faction>/<N>.png
 *
 * where `<lodSize>` ∈ `LOD_SIZES`, `<faction>` includes `"neutral"`
 * (always populated at the highest LOD any given aspect exists at),
 * and `<N>` are 1-indexed variants mirrored 1:1 across LODs by the
 * `art remaster` tool. `master/` (the high-res source tree consumed
 * only by `art remaster`) is OUTSIDE this glob — it never reaches
 * the client.
 *
 * `import.meta.glob` must be a static literal — Vite evaluates it
 * at build time and emits a `path → () => Promise` map. Files under
 * `public/` are served as static assets (never bundled into JS
 * chunks); the glob just produces the *list of URLs we can fetch
 * from `Assets.load`*. PNG bytes only cross the wire on first
 * fetch.
 */
const ALL_LOD_URLS = import.meta.glob("/public/textures/lod/**/*.png");

function stripPublic(k: string): string {
  return k.replace(/^\/public/, "");
}

const ALL_URLS: readonly string[] = Object.keys(ALL_LOD_URLS).map(stripPublic);

/** Ascending list of LOD bucket sizes the pyramid uses. `art remaster`
 *  emits each variant at every bucket size whose master source can
 *  cover. An aspect may legitimately exist at only the smallest
 *  bucket (e.g. flowers, master too small to bake a 256 from). The
 *  runtime picker silently drops down when the requested bucket
 *  isn't on disk. */
export const LOD_SIZES = [64, 128, 256, 512, 1024] as const;
export type LodSize = (typeof LOD_SIZES)[number];

/** Largest LOD bucket. Used as the seed when the requested
 *  `desiredSize` exceeds every available bucket. */
export const MAX_LOD: LodSize = LOD_SIZES[LOD_SIZES.length - 1];
/** Smallest LOD bucket. Used as the white-fallback resolution and
 *  as the floor when `desiredSize` is below every available bucket. */
export const MIN_LOD: LodSize = LOD_SIZES[0];

/** URLs for one specific `(lodSize, aspect, faction)` triple. Pure
 *  prefix filter over the prebuilt glob — sorted for deterministic
 *  variant iteration. Empty array means "no files at this triple"
 *  (caller drops LOD or falls back to neutral). */
export function lodUrlsFor(
  lodSize: number,
  aspect: string,
  faction: string,
): readonly string[] {
  const prefix = `/textures/lod/${lodSize}/${aspect}/${faction}/`;
  return ALL_URLS.filter(url => url.startsWith(prefix)).sort();
}

/** All faction subfolders that exist for an aspect at a given LOD.
 *  Sorted (deterministic). Empty when the aspect has no files at
 *  that LOD bucket at all.
 *
 *  Used by the picker as a "what's available?" lookup when the
 *  caller-supplied faction is missing or doesn't resolve — so a
 *  `soul`-art card whose owner-faction lookup hasn't hydrated yet
 *  still renders SOMETHING (alphabetical first available) instead
 *  of the white fallback. The "wrong" faction is fine for the
 *  loading-frame use case; the card re-resolves once its real
 *  faction lands. */
export function availableFactionsAt(
  lodSize: number,
  aspect: string,
): readonly string[] {
  const prefix = `/textures/lod/${lodSize}/${aspect}/`;
  const factions = new Set<string>();
  for (const url of ALL_URLS) {
    if (!url.startsWith(prefix)) continue;
    const rest = url.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash > 0) factions.add(rest.slice(0, slash));
  }
  return [...factions].sort();
}

/** Pick the smallest LOD bucket `≥ desiredSize`, clamped to the
 *  largest bucket when `desiredSize` exceeds the pyramid's max.
 *  Pure math against `LOD_SIZES` — does NOT consult availability on
 *  disk. The caller drops LODs when the ideal isn't populated for
 *  the requested aspect. */
export function pickLodForSize(desiredSize: number): LodSize {
  for (const lod of LOD_SIZES) {
    if (lod >= desiredSize) return lod;
  }
  return MAX_LOD;
}

/** Yield LOD buckets descending from `start` (inclusive). Used by
 *  the resolver to walk down the pyramid looking for any LOD that
 *  has files for a given `(aspect, faction)`. */
export function lodsDescendingFrom(start: number): LodSize[] {
  return LOD_SIZES.filter(lod => lod <= start).slice().reverse() as LodSize[];
}

/** Substitute a different LOD bucket into an existing LOD URL,
 *  preserving aspect / faction / variant. Used by the runtime to
 *  compute "what would the equivalent URL be at a different LOD?"
 *  for the cached-substitute search. Returns the input unchanged
 *  if it doesn't match the expected LOD-URL shape. */
export function urlAtLod(url: string, lod: number): string {
  return url.replace(/\/textures\/lod\/\d+\//, `/textures/lod/${lod}/`);
}

/** All URLs at the smallest LOD bucket. Used by `main.ts` as the
 *  startup pre-warm slice — every aspect gets at least a coarse
 *  texture in the browser cache so the first-reference fallback
 *  chain (cached substitute → white) lands quickly. */
export function smallestLodUrls(): readonly string[] {
  const prefix = `/textures/lod/${MIN_LOD}/`;
  return ALL_URLS.filter(url => url.startsWith(prefix)).sort();
}

/** Every LOD URL discoverable at build time. Diagnostic-only; the
 *  runtime resolver never asks for this. */
export function allLodUrls(): readonly string[] {
  return [...ALL_URLS].sort();
}
