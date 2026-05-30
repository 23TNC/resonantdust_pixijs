import { Assets, Graphics, Rectangle, RenderTexture, Texture, type Renderer } from "pixi.js";
import {
  availableFactionsAt,
  lodUrlsFor,
  pickLodForSize,
  lodsDescendingFrom,
  urlAtLod,
  LOD_SIZES,
  MIN_LOD,
} from "../lodUrls";
import type { TextureManager } from "./TextureManager";
import { debug } from "../../debug";

/** Pixels trimmed off each side of a packed texture's frame.
 *  Source PNGs ship with a transparent margin already baked in;
 *  this inset narrows the visible frame onto the inner artwork so
 *  bilinear sampling at sub-pixel positions can't pick up bleed
 *  from neighbouring atlas slots. */
const FRAME_INSET = 2;

/** Default ceiling on the LOD bucket the picker will select, even
 *  when `desiredSize` would resolve higher. Effectively a texture-
 *  quality knob — lower it for weaker platforms to cap atlas
 *  memory + upload cost. Surfaced as a constructor option so a
 *  future settings panel can write to it without rebuilding the
 *  manager. */
const DEFAULT_QUALITY_CAP = 1024;

/**
 * LOD-aware lazy loader, picker, and per-URL atlas cache for every
 * sprite the runtime renders.
 *
 * Folder convention: `pixijs/public/textures/lod/<lodSize>/<aspect>/
 * <faction>/<N>.png`. The `art remaster <aspect>` tool generates
 * `<N>.png` at every LOD bucket the master source can cover (an
 * aspect with a small master might only ship the 64 bucket;
 * `flowers` is the canonical example today). Mirrored 1:1, so an
 * `index: 3` reference picks the same variant at any LOD.
 *
 * **`aspect.size` is the *desired draw size* in screen px at
 * scale 1.0**, not the source resolution. The manager picks the
 * smallest LOD bucket ≥ that size (capped at `qualityCap`), drops
 * down when the ideal bucket has no files, and hands the caller a
 * Texture at the *picked LOD's* native dimensions. The caller
 * computes `scale = desiredSize / tex.width × scaleVariance` so
 * Pixi renders at the requested draw size regardless of which LOD
 * landed. Example: aspect `size: 256`, variance 0.8..1.2 → loads
 * one 256-LOD texture, renders at 205..307 px via sprite scale
 * (instead of loading both 256 AND 512 to pick the "right" LOD
 * per instance — that's 1/5 the texture budget for the same look).
 *
 * **Faction lookup is O(1) at ideal.** If the requested faction
 * has no files at the ideal LOD it's missing everywhere (per the
 * `art remaster` invariant: if a LOD carries a faction, every LOD
 * carries it). The manager locks to neutral immediately and walks
 * lower LODs looking for neutral files only. Common case (no
 * faction requested) skips the faction check entirely.
 *
 * **Always returns a Texture — never null.** Cascade:
 *
 *   1. Ideal LOD URL already in `byUrl` cache → return it.
 *   2. Not cached but exists on disk → kick off `Assets.load`
 *      (deduped via `loading` set), then return the highest-LOD
 *      cached substitute for the same `(aspect, faction, variant)`.
 *   3. No substitute cached → return the 64×64 atlas-packed white
 *      texture.
 *   4. No LOD anywhere has files for this aspect → white
 *      permanently (the resolver tried every LOD and found
 *      nothing).
 *
 * The substitute layer means an aspect referenced before its
 * ideal LOD finishes loading renders as the next-best already-
 * cached LOD (sharp downscale if a larger LOD was loaded by a
 * prior request, slight upscale otherwise) instead of flashing
 * blank. When the ideal lands, the `onLoad` callback fires and
 * consumers re-resolve to the upgrade.
 */
export class LodTextureManager {
  private readonly textures: TextureManager;
  private readonly renderer: Renderer;
  /** Cap on the LOD bucket the picker will select even when
   *  `desiredSize` would resolve higher. See `DEFAULT_QUALITY_CAP`. */
  private readonly qualityCap: number;
  /** Atlas-packed Texture keyed by source URL. One entry per
   *  actually-rendered variant — a 256 and a 512 of the same
   *  aspect are two cache entries. Stable map: a URL's Texture is
   *  set once and never reassigned, so callers can hold the
   *  reference across frames. */
  private readonly byUrl = new Map<string, Texture>();
  /** URLs whose `Assets.load` is in-flight. Prevents redundant
   *  loads when several `get` calls for the same variant happen
   *  between the first call and the load resolving. Cleared in
   *  the `load` finally-block before listeners fire. */
  private readonly loading = new Set<string>();
  private readonly listeners = new Set<() => void>();
  /** Atlas-packed 64×64 white texture — the universal fallback
   *  when an ideal URL isn't loaded yet AND no substitute LOD is
   *  cached, OR when an aspect has no LOD files anywhere.
   *  Generated lazily on first request via a one-shot Graphics
   *  render-to-texture; subsequent fallbacks return the same
   *  instance. */
  private whiteFallback: Texture | null = null;

  constructor(
    textures: TextureManager,
    renderer: Renderer,
    options?: { qualityCap?: number },
  ) {
    this.textures = textures;
    this.renderer = renderer;
    this.qualityCap = options?.qualityCap ?? DEFAULT_QUALITY_CAP;
  }

  /** Subscribe to texture-load completion events. Fires once per
   *  URL as its texture lands in the atlas, so a consumer that
   *  resolved a substitute or white fallback on the previous sync
   *  can re-resolve and pick up the upgrade. Returns an
   *  unsubscribe function. */
  onLoad(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Pre-load the given URLs into `byUrl` so the substitute-cache
   *  cascade has something to find before the first `get` reference.
   *  `main.ts` calls this at startup with every smallest-LOD URL so
   *  any aspect's first reference resolves to the 64×64 instead of
   *  the white fallback while its ideal LOD races to load. Skips
   *  URLs already cached or already in flight. Resolves when every
   *  pre-warm load has settled. */
  async prewarm(urls: readonly string[]): Promise<void> {
    await Promise.all(urls.map(url => {
      if (this.byUrl.has(url) || this.loading.has(url)) {
        return Promise.resolve();
      }
      this.loading.add(url);
      return this.load(url);
    }));
  }

  /**
   * Return the atlas-packed Texture for one variant of an aspect
   * at the requested draw size. See the class doc for the full
   * picker + fallback cascade. Never returns null — the white
   * 64×64 fallback covers every miss.
   *
   * @param aspect       Aspect name (matches the registry / folder).
   * @param desiredSize  Target draw size in screen px at scale 1.0.
   *                     The picker resolves the smallest LOD ≥ this
   *                     (capped at `qualityCap`).
   * @param seed         Pseudo-random variant picker when `index`
   *                     is unset. `seed % urls.length` — same seed
   *                     always picks the same variant.
   * @param index        Pin to `<index>.png` exactly. Falls back
   *                     to the seed pick when the named variant
   *                     isn't on disk at the chosen LOD.
   * @param faction      Subfolder under the aspect. `undefined`
   *                     resolves to `neutral/`. A faction that
   *                     has no files at the ideal LOD locks to
   *                     neutral for the lower-LOD descent.
   */
  get(
    aspect: string,
    desiredSize: number,
    seed: number,
    index?: number,
    faction?: string,
  ): Texture {
    const cap = Math.min(desiredSize, this.qualityCap);
    const idealLod = pickLodForSize(cap);

    // Faction-availability check is O(1) at ideal — if missing
    // there, the `art remaster` invariant says it's missing
    // everywhere, so lock to neutral for the lower-LOD descent.
    //
    // Fallback: when the resolved folder ends up `neutral` but the
    // aspect has no neutral files (faction-only packs like `soul`),
    // pick the alphabetical-first available faction so we render
    // SOMETHING instead of the white floor. This covers two cases:
    //   1. `faction` was `undefined` (caller's owner-faction lookup
    //      hadn't hydrated yet — the corpse / soul card spawns
    //      before the player row arrives).
    //   2. `faction` was passed but the aspect lacks that faction's
    //      files (e.g. caller asked for "chorus" on an aspect that
    //      ships only "chord" + "resonance").
    // The "wrong" faction is acceptable for the loading-frame use
    // case; the card re-resolves to the right faction once its
    // real faction lands and something invalidates the layout.
    let folder = "neutral";
    if (faction !== undefined) {
      if (lodUrlsFor(idealLod, aspect, faction).length > 0) {
        folder = faction;
      }
    }
    if (folder === "neutral" && lodUrlsFor(idealLod, aspect, "neutral").length === 0) {
      const available = availableFactionsAt(idealLod, aspect);
      if (available.length > 0) folder = available[0];
    }

    // Walk LODs from ideal down, picking the first bucket that
    // has files for this `(aspect, folder)`. The chosen URL is
    // the "ideal" we'll cache and queue. If no bucket has files
    // (aspect doesn't exist at all in the LOD tree), we land on
    // the permanent white fallback below.
    let idealUrl: string | null = null;
    for (const lod of lodsDescendingFrom(idealLod)) {
      const urls = lodUrlsFor(lod, aspect, folder);
      if (urls.length === 0) continue;
      idealUrl = pickVariantUrl(urls, seed, index);
      break;
    }
    if (idealUrl === null) return this.ensureWhiteFallback();

    // Ideal URL is on disk. Cache hit fast path.
    const cached = this.byUrl.get(idealUrl);
    if (cached) return cached;

    // Not cached — kick off a one-shot load (deduped) and use the
    // best already-cached substitute (or white) for this frame.
    if (!this.loading.has(idealUrl)) {
      this.loading.add(idealUrl);
      void this.load(idealUrl);
    }
    const substitute = this.findCachedSubstitute(idealUrl);
    return substitute ?? this.ensureWhiteFallback();
  }

  /** Best already-cached LOD for the same `(aspect, faction,
   *  variant)` as `idealUrl`. Walks `LOD_SIZES` descending so the
   *  highest-resolution cached entry wins (Pixi downscales cleanly;
   *  upscaling a 64 to 256 is the worse end of the trade). Returns
   *  `null` when no LOD bucket for this variant is in the cache.
   *  String-replace + Map lookup per bucket — O(LOD_SIZES.length). */
  private findCachedSubstitute(idealUrl: string): Texture | null {
    for (let i = LOD_SIZES.length - 1; i >= 0; i--) {
      const candidate = urlAtLod(idealUrl, LOD_SIZES[i]);
      const cached = this.byUrl.get(candidate);
      if (cached) return cached;
    }
    return null;
  }

  /** Lazy-allocate the 64×64 white fallback Texture into the atlas.
   *  Single Graphics → RenderTexture → TextureManager.pack pipeline,
   *  same shape as `CardTextureManager.bakeHex`. Idempotent — the
   *  first `get`-miss pays the cost, all subsequent fallbacks
   *  return the same Texture. */
  private ensureWhiteFallback(): Texture {
    if (this.whiteFallback) return this.whiteFallback;
    const g = new Graphics();
    g.rect(0, 0, MIN_LOD, MIN_LOD).fill({ color: 0xffffff });
    const rt = RenderTexture.create({ width: MIN_LOD, height: MIN_LOD });
    this.renderer.render({ container: g, target: rt, clear: true });
    g.destroy();
    const atlas = this.textures.pack(rt);
    rt.destroy(true);
    this.whiteFallback = atlas;
    return atlas;
  }

  destroy(): void {
    this.byUrl.clear();
    this.loading.clear();
    this.whiteFallback = null;
  }

  private async load(url: string): Promise<void> {
    try {
      await Assets.load(url);
      const src = Assets.get<Texture>(url);
      if (!src) return;
      const atlas = this.textures.pack(src);
      this.byUrl.set(url, insetFrame(atlas, FRAME_INSET));
    } catch (err) {
      // Callers `void this.load(...)` (fire-and-forget). The `void` discards
      // the return value but does NOT handle a rejection — without this catch
      // a transient `fetch` failure (network blip, dev-server stall, etc.)
      // surfaces as an "Uncaught (in promise)". The texture system is already
      // resilient to a missed load: `get` resolved a substitute or white
      // fallback for this frame, and on the next reference `loading.delete`
      // below means we'll retry the load. So just log it and let the retry
      // path do the work.
      debug.warn(["lod"], `[lod] failed to load ${url}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loading.delete(url);
      for (const cb of this.listeners) cb();
    }
  }
}

/** Pick one URL from a (sorted) variant list. `index` set → match
 *  `<index>.png` exactly, fall through to the seed pick when the
 *  named variant isn't in the list. `index` unset → deterministic
 *  pseudo-random `seed % length`. */
function pickVariantUrl(urls: readonly string[], seed: number, index?: number): string {
  if (index !== undefined) {
    const match = urls.find(url => urlMatchesIndex(url, index));
    if (match) return match;
  }
  return urls[(seed >>> 0) % urls.length];
}

/** Match an integer index against a variant URL's basename. The
 *  folder already encodes lod / aspect / faction (e.g.
 *  `lod/256/alter/chorus/5.png`) so the basename is purely a variant
 *  selector: `<N>.png`. Matching by filename (not list position)
 *  keeps an `index: 5` reference stable as unrelated files are
 *  added or removed from the same folder. */
function urlMatchesIndex(url: string, index: number): boolean {
  const slash = url.lastIndexOf("/");
  const basename = slash >= 0 ? url.slice(slash + 1) : url;
  if (!basename.toLowerCase().endsWith(".png")) return false;
  const stem = basename.slice(0, -4);
  if (!/^\d+$/.test(stem)) return false;
  return parseInt(stem, 10) === index;
}

function insetFrame(tex: Texture, inset: number): Texture {
  const { x, y, width, height } = tex.frame;
  return new Texture({
    source: tex.source,
    frame: new Rectangle(x + inset, y + inset, width - inset * 2, height - inset * 2),
  });
}
