import { Assets, type Texture } from "pixi.js";
import { objectUrlsFor } from "../objectUrls";
import type { TextureManager } from "./TextureManager";

/**
 * Lazy loader and pseudo-random picker for per-object texture packs.
 *
 * Folder convention: every object pack lives at
 *   public/textures/cards/objects/<size>_<object>_pack/
 * and contains an unknown number of PNG files. On the first `get` for
 * a given `(object, size)`, the manager:
 *
 *   1. Discovers every PNG in that folder via the Vite build-time URL
 *      registry (objectUrls.ts),
 *   2. Loads them through PixiJS Assets,
 *   3. Packs each into the shared atlas via `TextureManager.pack`,
 *   4. Stores the resulting sub-Texture array under that key.
 *
 * While loading, `get` returns `null` so callers can skip the frame.
 * Once the pack is ready, `get` returns a deterministic Texture indexed
 * by `(seed >>> 0) % pack.length`. Stable seeds (e.g. a hash of tile
 * coordinates) give stable picks across frames; throwaway seeds give
 * incidental randomness.
 */
export class ObjectTextureManager {
  private readonly textures: TextureManager;
  private readonly packs = new Map<string, readonly Texture[]>();
  private readonly loading = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(textures: TextureManager) {
    this.textures = textures;
  }

  /** Subscribe to pack-load completion events. The callback fires once
   *  per pack as soon as its textures are packed into the atlas, so a
   *  consumer that skipped sprites on a previous sync can re-sync.
   *  Returns an unsubscribe function. */
  onLoad(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Return a Texture from the `<size>_<object>_pack` folder, indexed by
   * the caller's seed. Returns `null` until the pack has finished
   * loading and packing into the atlas.
   *
   * Same `(object, size, seed)` always returns the same Texture once
   * loaded. Empty folders cache as an empty pack and always return
   * `null`.
   */
  get(object: string, size: number, seed: number): Texture | null {
    const key = `${size}_${object}`;
    const pack = this.packs.get(key);
    if (pack) {
      if (pack.length === 0) return null;
      return pack[(seed >>> 0) % pack.length];
    }
    if (!this.loading.has(key)) {
      this.loading.add(key);
      void this.load(key, object, size);
    }
    return null;
  }

  destroy(): void {
    this.packs.clear();
    this.loading.clear();
  }

  private async load(key: string, object: string, size: number): Promise<void> {
    try {
      const urls = objectUrlsFor(size, object);
      if (urls.length === 0) {
        this.packs.set(key, []);
        return;
      }
      await Assets.load([...urls]);
      const packed: Texture[] = [];
      for (const url of urls) {
        const src = Assets.get<Texture>(url);
        if (src) packed.push(this.textures.pack(src));
      }
      this.packs.set(key, packed);
    } finally {
      this.loading.delete(key);
      for (const cb of this.listeners) cb();
    }
  }
}
