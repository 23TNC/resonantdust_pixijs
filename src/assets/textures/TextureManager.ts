import { Rectangle, RenderTexture, Sprite, Texture, type Renderer } from "pixi.js";

/**
 * Logical atlas size. Every atlas is exactly this large, regardless of
 * the physical RenderTexture it lives in. Atlases are independent: each
 * one runs its own quadtree over its 4096×4096 region.
 */
const ATLAS_SIZE = 4096;

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function queryMaxTextureSize(renderer: Renderer): number {
  const r = renderer as unknown as {
    gl?: { getParameter(p: number): number; MAX_TEXTURE_SIZE: number };
    limits?: { maxTextureDimension2D?: number };
  };
  if (r.gl?.getParameter) return r.gl.getParameter(r.gl.MAX_TEXTURE_SIZE);
  if (r.limits?.maxTextureDimension2D) return r.limits.maxTextureDimension2D;
  return ATLAS_SIZE;
}

/**
 * Quadtree allocator for a single 4096×4096 atlas region.
 *
 * Slots are always power-of-2 squares. `originX/Y` is the atlas's offset
 * within its backing physical texture, so all coordinates returned by
 * `alloc` are absolute and can be used directly as render targets and
 * as Texture frame coordinates.
 *
 * Allocation rule: try the exact-size free list first; otherwise pop
 * the smallest available larger slot and recursively split, returning
 * the top-left child at each level. The three siblings always go to
 * the free list at the post-split size. This guarantees we fill
 * existing free slots before promoting a larger one.
 */
class Atlas {
  readonly originX: number;
  readonly originY: number;
  private readonly free = new Map<number, Array<{ x: number; y: number }>>();

  constructor(originX: number, originY: number) {
    this.originX = originX;
    this.originY = originY;
    this.free.set(ATLAS_SIZE, [{ x: originX, y: originY }]);
  }

  /** Allocate a power-of-2 slot of the given size, or null if the
   *  atlas can't satisfy the request. */
  alloc(slotSize: number): { x: number; y: number } | null {
    if (slotSize > ATLAS_SIZE) return null;

    const exact = this.free.get(slotSize);
    if (exact && exact.length > 0) return exact.pop()!;

    let parentSize = slotSize * 2;
    let parent: { x: number; y: number } | null = null;
    while (parentSize <= ATLAS_SIZE) {
      const list = this.free.get(parentSize);
      if (list && list.length > 0) {
        parent = list.pop()!;
        break;
      }
      parentSize *= 2;
    }
    if (!parent) return null;

    while (parentSize > slotSize) {
      const half = parentSize / 2;
      const x: number = parent.x;
      const y: number = parent.y;
      const siblings = this.free.get(half) ?? [];
      siblings.push({ x: x + half, y });
      siblings.push({ x, y: y + half });
      siblings.push({ x: x + half, y: y + half });
      this.free.set(half, siblings);
      parent = { x, y };
      parentSize = half;
    }
    return parent;
  }
}

interface PhysicalPage {
  texture: RenderTexture;
  atlases: Atlas[];
}

/**
 * Packs source textures into shared atlases backed by one or more
 * physical RenderTextures.
 *
 * - Atlases are always 4096×4096 and run their own quadtree allocator.
 * - Physical RenderTextures are sized to the GPU's max texture size,
 *   so multiple 4096 atlases share a single GL texture when the GPU
 *   supports it (max 8192 → 4 atlases per physical; max 16384 → 16;
 *   max 4096 → 1).
 * - Atlases remain independent — they share GL memory but never share
 *   quadtree state, and each allocation is local to a single atlas.
 *
 * Usage:
 *   const packed = textures.pack(sourceTexture);
 *   sprite.texture = packed;
 *
 * The returned Texture's `frame` matches the source's native pixel
 * dimensions placed at the slot's top-left, so the sprite draws at the
 * original size with no distortion. The slot itself is rounded up to
 * `nextPow2(max(width, height))`; any unused area inside that slot is
 * wasted but harmless.
 *
 * No deduplication and no eviction — every pack call consumes a fresh
 * slot for the lifetime of the manager.
 */
export class TextureManager {
  private readonly renderer: Renderer;
  private readonly maxTextureSize: number;
  private readonly pages: PhysicalPage[] = [];
  /** Count of packed slots, keyed by `slotSize` (power-of-2). Bumped
   *  by every `pack()` call. Read by `stats()` for the HUD chip. */
  private readonly slotCounts = new Map<number, number>();

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.maxTextureSize = queryMaxTextureSize(renderer);
    if (this.maxTextureSize < ATLAS_SIZE) {
      throw new Error(
        `TextureManager: GPU max texture size ${this.maxTextureSize} < atlas size ${ATLAS_SIZE}`,
      );
    }
  }

  /** Snapshot of atlas occupancy for HUD / debug surfaces. `atlases`
   *  is the total number of 4096-region atlases across every
   *  physical page; `slotCounts` is the running tally of packed
   *  slots grouped by their power-of-2 size. */
  stats(): { atlases: number; slotCounts: ReadonlyMap<number, number> } {
    let atlases = 0;
    for (const page of this.pages) atlases += page.atlases.length;
    return { atlases, slotCounts: this.slotCounts };
  }

  /**
   * Pack `source` into the atlas pool and return a sub-Texture pointed
   * at the slot. The returned Texture's frame matches the source's
   * native (width × height), positioned at the slot's top-left within
   * the backing physical texture.
   */
  pack(source: Texture): Texture {
    const w = source.width;
    const h = source.height;
    const slotSize = nextPow2(Math.max(w, h));
    if (slotSize > ATLAS_SIZE) {
      throw new Error(
        `TextureManager: source ${w}×${h} (slot ${slotSize}) exceeds atlas size ${ATLAS_SIZE}`,
      );
    }

    this.slotCounts.set(slotSize, (this.slotCounts.get(slotSize) ?? 0) + 1);

    for (const page of this.pages) {
      for (const atlas of page.atlases) {
        const slot = atlas.alloc(slotSize);
        if (slot) return this.bake(source, w, h, slot, page.texture);
      }
    }

    const created = this.createAtlas();
    const slot = created.atlas.alloc(slotSize)!;
    return this.bake(source, w, h, slot, created.page.texture);
  }

  destroy(): void {
    for (const page of this.pages) page.texture.destroy(true);
    this.pages.length = 0;
  }

  private bake(
    source: Texture,
    w: number,
    h: number,
    slot: { x: number; y: number },
    target: RenderTexture,
  ): Texture {
    const sprite = new Sprite(source);
    sprite.position.set(slot.x, slot.y);
    this.renderer.render({ container: sprite, target, clear: false });
    sprite.destroy();
    return new Texture({
      source: target.source,
      frame: new Rectangle(slot.x, slot.y, w, h),
    });
  }

  private createAtlas(): { atlas: Atlas; page: PhysicalPage } {
    for (const page of this.pages) {
      const offset = this.findFreeAtlasSlot(page);
      if (offset) {
        const atlas = new Atlas(offset.x, offset.y);
        page.atlases.push(atlas);
        return { atlas, page };
      }
    }

    const size = this.maxTextureSize;
    const texture = RenderTexture.create({ width: size, height: size });
    const page: PhysicalPage = { texture, atlases: [] };
    this.pages.push(page);
    const atlas = new Atlas(0, 0);
    page.atlases.push(atlas);
    return { atlas, page };
  }

  private findFreeAtlasSlot(page: PhysicalPage): { x: number; y: number } | null {
    const { width, height } = page.texture;
    for (let y = 0; y + ATLAS_SIZE <= height; y += ATLAS_SIZE) {
      for (let x = 0; x + ATLAS_SIZE <= width; x += ATLAS_SIZE) {
        const taken = page.atlases.some((a) => a.originX === x && a.originY === y);
        if (!taken) return { x, y };
      }
    }
    return null;
  }
}
