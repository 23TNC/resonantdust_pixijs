import { Container, Sprite } from "pixi.js";
import type { LodTextureManager } from "./textures/LodTextureManager";

/**
 * Request to place a single sprite in a managed Container. The
 * manager resolves `(name, desiredSize, seed)` to a Texture via
 * `LodTextureManager` at sync time, sets the sprite's position and
 * scale, and uses `sortKey` as the sprite's zIndex so PixiJS sorts
 * the Container's children at render time. Sprite scale is
 * computed from `desiredSize / tex.width × scale` so the rendered
 * pixel size matches `desiredSize × scale` regardless of which LOD
 * bucket actually backs the Texture.
 */
export interface ObjectSpriteRequest {
  /** Object name (e.g. `"pine"`). Matches an entry in
   *  `content/cards/objects.json`; resolves to a `master/<name>/`
   *  pack-folder. */
  name: string;
  /** Target draw size in screen px at `scale: 1.0`. Drives the
   *  LOD picker: `LodTextureManager` resolves the smallest LOD
   *  bucket ≥ this. Sprite scale is then
   *  `(desiredSize / tex.width) × scale`. */
  desiredSize: number;
  /** Seed used to pick a specific variant from the object's pack.
   *  Stable seeds (e.g. hashed tile coordinates) give stable picks
   *  across syncs. Ignored when `index` is set. */
  seed: number;
  /** Optional variant pinner — `<index>.png` exactly. Used by
   *  card-declared centre objects that want a specific variant;
   *  tile-decoration ring instances leave this unset and pick via
   *  `seed`. */
  index?: number;
  /** Optional faction folder under the object's pack. `undefined`
   *  resolves to `neutral/`. Used so tile centre objects on
   *  faction-owned territory render in the owner's faction palette. */
  faction?: string;
  /** Sprite position in the outer Container's coordinate space. */
  x: number;
  y: number;
  /** Per-instance scale variance multiplier (usually drawn from
   *  the aspect's `scale.min..max`). Final sprite scale =
   *  `(desiredSize / tex.width) × scale`. */
  scale: number;
  /** Becomes the sprite's `zIndex`; lower draws first. The outer
   *  Container has `sortableChildren = true`, so PixiJS handles the
   *  ordering automatically on render. */
  sortKey: number;
  /** Fractional pivot point — `(0.5, 0.75)` mimics the legacy
   *  hard-coded default (centre-horizontally, three-quarters down
   *  the sprite, so a tree-shaped asset's trunk lands on the world
   *  hex while the canopy rises above it). Applied on every sync so
   *  pooled-sprite reuse always reflects the *current* request's
   *  anchor instead of whatever the previous tenant set. */
  anchorX: number;
  anchorY: number;
}

interface ManagedState {
  /** Sprites currently shown, grouped by caller key (one key per
   *  world tile). Lets the retained renderer rebuild or drop a single
   *  tile's objects without touching its neighbours. */
  groups: Map<string, Sprite[]>;
  /** Recycled sprites available for reuse. */
  pool: Sprite[];
}

/**
 * Manages a Container of object sprites (trees, rocks, etc.) in a
 * retained, per-key fashion.
 *
 * Pattern:
 *   const root = manager.createContainer();
 *   scene.addChild(root);
 *   // when a tile enters / its data changes:
 *   manager.syncTile(root, "q,r", [ ...reqs ]);
 *   // when a tile leaves the active rect:
 *   manager.dropTile(root, "q,r");
 *
 * The returned Container has `sortableChildren = true`, so each
 * sprite's `zIndex` (set from the request's `sortKey`) determines
 * draw order at render time — a single global painter's sort across
 * every tile's objects, no per-tile sub-containers.
 *
 * Sprites are pooled per managed Container, so a tile that leaves and
 * re-enters (or re-renders on a stock change) reuses allocations
 * instead of churning the heap.
 */
export class ObjectManager {
  private readonly lodTextures: LodTextureManager;
  private readonly state = new WeakMap<Container, ManagedState>();

  constructor(lodTextures: LodTextureManager) {
    this.lodTextures = lodTextures;
  }

  /** Create a new managed Container. The caller adds it to the scene;
   *  the manager owns its children and their lifecycle. */
  createContainer(): Container {
    const c = new Container();
    c.sortableChildren = true;
    this.state.set(c, { groups: new Map(), pool: [] });
    return c;
  }

  /** Tear down a managed Container — destroys every live and pooled
   *  sprite, then destroys the outer Container. */
  destroyContainer(c: Container): void {
    const s = this.state.get(c);
    if (!s) return;
    for (const sprites of s.groups.values()) {
      for (const sp of sprites) sp.destroy();
    }
    for (const sp of s.pool) sp.destroy();
    s.groups.clear();
    s.pool.length = 0;
    this.state.delete(c);
    c.destroy({ children: true });
  }

  /** Build (or rebuild) the sprites for one key. Releases the key's
   *  current sprites back to the pool, then acquires one per request,
   *  sets its texture/anchor/position/scale/zIndex, and attaches it.
   *  `LodTextureManager.get` never returns null — it falls through to
   *  a cached LOD substitute or the white 64×64 fallback while the
   *  ideal LOD loads, then fires `onLoad` so the caller can re-sync to
   *  pick up the upgrade. Scale math compensates for the substitute's
   *  native size so the rendered px stays `desiredSize × scale`
   *  regardless of which LOD bucket backs the Texture. */
  syncTile(c: Container, key: string, reqs: readonly ObjectSpriteRequest[]): void {
    const s = this.state.get(c);
    if (!s) return;

    const out = s.groups.get(key) ?? [];
    // Release the key's existing sprites to the pool, then refill the
    // same array in place so we reuse them request-by-request below.
    for (const sp of out) {
      c.removeChild(sp);
      s.pool.push(sp);
    }
    out.length = 0;

    for (const req of reqs) {
      const tex = this.lodTextures.get(
        req.name, req.desiredSize, req.seed, req.index, req.faction,
      );
      const sp = this.acquire(s);
      sp.texture = tex;
      // Apply anchor here (not at acquire) so a pooled sprite reused
      // by a request with a different anchor doesn't inherit its
      // previous tenant's pivot point.
      sp.anchor.set(req.anchorX, req.anchorY);
      sp.position.set(req.x, req.y);
      sp.scale.set((req.desiredSize / tex.width) * req.scale);
      sp.zIndex = req.sortKey;
      c.addChild(sp);
      out.push(sp);
    }

    if (out.length > 0) s.groups.set(key, out);
    else s.groups.delete(key);
  }

  /** Release one key's sprites back to the pool and forget the key. */
  dropTile(c: Container, key: string): void {
    const s = this.state.get(c);
    if (!s) return;
    const sprites = s.groups.get(key);
    if (!sprites) return;
    for (const sp of sprites) {
      c.removeChild(sp);
      s.pool.push(sp);
    }
    s.groups.delete(key);
  }

  private acquire(s: ManagedState): Sprite {
    let sp = s.pool.pop();
    if (!sp) sp = new Sprite();
    sp.visible = true;
    return sp;
  }
}
