import { Container, Sprite } from "pixi.js";
import type { ObjectTextureManager } from "./textures/ObjectTextureManager";

/**
 * Request to place a single sprite in a managed Container. The
 * manager resolves `(object, size, seed)` to a texture via
 * ObjectTextureManager at sync time, sets the sprite's position and
 * scale, and uses `sortKey` as the sprite's zIndex so PixiJS sorts
 * the Container's children at render time.
 */
export interface ObjectSpriteRequest {
  /** Object pack name, e.g. `"tree"`. */
  object: string;
  /** Pack folder size — folder is `<size>_<object>_pack/`. */
  size: number;
  /** Seed used to pick a specific PNG from the pack. Stable seeds
   *  (e.g. hashed tile coordinates) give stable picks across syncs. */
  seed: number;
  /** Sprite position in the outer Container's coordinate space. */
  x: number;
  y: number;
  /** Uniform scale applied to both axes. */
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
  pending: ObjectSpriteRequest[];
  /** Sprites currently attached to the Container. */
  active: Sprite[];
  /** Recycled sprites available for reuse on the next sync. */
  pool: Sprite[];
}

/**
 * Manages a Container of object sprites (trees, rocks, etc.).
 *
 * Pattern:
 *   const root = manager.createContainer();
 *   scene.addChild(root);
 *   // each layout pass:
 *   for (const tile of tiles) manager.add(root, { ... });
 *   manager.sync(root);
 *
 * The returned Container has `sortableChildren = true`, so each
 * sprite's `zIndex` (set from the request's `sortKey`) determines
 * draw order at render time — no manual painter's sort.
 *
 * Sprites are pooled per managed Container so steady-state syncs reuse
 * allocations. Requests whose texture hasn't finished loading are
 * silently skipped on the current sync — next sync picks them up once
 * ObjectTextureManager finishes the pack load.
 */
export class ObjectManager {
  private readonly objectTextures: ObjectTextureManager;
  private readonly state = new WeakMap<Container, ManagedState>();

  constructor(objectTextures: ObjectTextureManager) {
    this.objectTextures = objectTextures;
  }

  /** Create a new managed Container. The caller adds it to the scene;
   *  the manager owns its children and their lifecycle. */
  createContainer(): Container {
    const c = new Container();
    c.sortableChildren = true;
    this.state.set(c, { pending: [], active: [], pool: [] });
    return c;
  }

  /** Tear down a managed Container — destroys every active and pooled
   *  sprite, then destroys the outer Container. */
  destroyContainer(c: Container): void {
    const s = this.state.get(c);
    if (!s) return;
    for (const sp of s.active) sp.destroy();
    for (const sp of s.pool) sp.destroy();
    s.active.length = 0;
    s.pool.length = 0;
    s.pending.length = 0;
    this.state.delete(c);
    c.destroy({ children: true });
  }

  /** Drop pending requests and release every active sprite back into
   *  the pool. The Container is left empty. */
  clear(c: Container): void {
    const s = this.state.get(c);
    if (!s) return;
    this.releaseActive(c, s);
    s.pending.length = 0;
  }

  /** Queue a sprite for the next `sync`. */
  add(c: Container, req: ObjectSpriteRequest): void {
    const s = this.state.get(c);
    if (!s) return;
    s.pending.push(req);
  }

  /** Commit pending requests: release all active sprites, then acquire
   *  one from the pool (or create new) for each request whose texture
   *  is ready, set its texture/position/scale/zIndex, and re-attach.
   *  Pending requests whose textures haven't loaded yet are skipped. */
  sync(c: Container): void {
    const s = this.state.get(c);
    if (!s) return;

    this.releaseActive(c, s);

    for (const req of s.pending) {
      const tex = this.objectTextures.get(req.object, req.size, req.seed);
      if (!tex) continue;
      const sp = this.acquire(s);
      sp.texture = tex;
      // Apply anchor here (not just at pool acquisition) so a pooled
      // sprite re-used by a request with a different anchor doesn't
      // inherit its previous tenant's pivot point.
      sp.anchor.set(req.anchorX, req.anchorY);
      sp.position.set(req.x, req.y);
      sp.scale.set(req.scale);
      sp.zIndex = req.sortKey;
      c.addChild(sp);
      s.active.push(sp);
    }

    s.pending.length = 0;
  }

  private releaseActive(c: Container, s: ManagedState): void {
    for (const sp of s.active) {
      c.removeChild(sp);
      s.pool.push(sp);
    }
    s.active.length = 0;
  }

  private acquire(s: ManagedState): Sprite {
    let sp = s.pool.pop();
    if (!sp) sp = new Sprite();
    sp.visible = true;
    return sp;
  }
}
