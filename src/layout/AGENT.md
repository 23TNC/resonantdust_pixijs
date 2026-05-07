# AGENT.md

## Purpose
Layout primitive used throughout the UI: a tree of `LayoutNode` instances, each owning a Pixi `Container`, with rect-based hit testing and a two-flag dirty system that re-runs layout work only where needed.

## Important files
- `LayoutNode.ts`: base class. Owns a `Container`, local rect (`x, y, width, height`), parent/children, `selfDirty` / `subtreeDirty` flags, `setBounds` / `invalidate` / `layoutIfDirty` / `hitTestLayout`. Subclasses override `layout()` to position children and `intersects()` to refine hit shape.
- `LayoutManager.ts`: scene-scoped registry of layout surfaces keyed by `ZoneId`, plus an `overlay` field for in-flight UI. Surfaces (`LayoutInventory`, `LayoutWorld`'s world-card surface) register themselves on construction; `LayoutCard` queries `surfaceFor(zoneId)` to self-attach. Also exposes `onRegister(listener)` so a card whose surface didn't exist yet can wait for it to land. Lives on `ctx.layout` while a scene that owns one is active.

## Conventions
- Each node owns ONE Pixi `Container`. The layout tree is the source of truth for rects and hit tests; the Pixi tree is for rendering. Drive `container.x` / `container.y` through `setBounds` only — never reach into transforms directly.
- Add children via `addChild` / `removeChild` (NOT `container.addChild`) so the layout tree and Pixi tree stay in sync.
- Subclasses override `protected layout()` to position children: call `child.setBounds(x, y, w, h)` for each. They override `protected intersects(localX, localY)` only when the hittable region isn't the rect (e.g. hex tiles, drag-passthrough overlays).
- **Two dirty flags, not one:**
  - `selfDirty` — this node needs to re-run its own `layout()`. Set on `setBounds` (size change), `addChild` / `removeChild`, and any subclass-internal change that affects child positions.
  - `subtreeDirty` — some descendant is `selfDirty`. Walked up by `invalidate()`. Cleared after that subtree finishes laying out.
- The traversal: `layoutIfDirty()` runs `layout()` if `selfDirty`, then recurses into any child whose `selfDirty` or `subtreeDirty` is set, then clears `subtreeDirty`. Call from the scene's `onResize` (after `setBounds`) and `update` (every frame).
- A `layout()` implementation may return `true` to keep itself dirty for the next frame — used for animations driven by `layoutIfDirty` (e.g. the inventory grid fade tween). Returning `void` / `false` clears the dirty flag normally.
- Hit test descends children in **reverse** order (last-added = drawn on top in Pixi). Returns the deepest node whose rect (or `intersects` override) contains the point. Surfaces that should fall through to siblings beneath them (the in-flight UI overlay, hex stack mounts) override `intersects()` to return `false` while still recursing into children.
- **Context access:** `setContext(ctx)` is called once on the layout root by the scene (`GameScene.onEnter`). Any descendant reads via `this.ctx` — a getter that walks up the parent chain to find the first node with a context set. Throws if no ancestor has one. Use `this.ctx.data.cards.subscribe(...)` from any leaf without prop-drilling or globals.
- **The overlay is a special LayoutManager slot.** `LayoutManager.overlay` points at the `OverlayNode` constructed by `GameLayout`. Cards re-parent there during drag so they draw above everything else and so the drop hit-test resolves to the surface beneath them. Don't register the overlay as a zone surface — there's exactly one and it isn't keyed by `ZoneId`.

## Pitfalls
- One flag is not enough. With only `selfDirty`, a clean parent prunes a dirty descendant. With only `subtreeDirty`, every ancestor re-runs `layout()` even when nothing changed.
- `setBounds` with unchanged values is a no-op — it skips invalidation. Don't put stateful side-effects in `layout()` that need to run regardless of size.
- Hex-shaped or non-rect interactive elements MUST override `intersects` — the broad-phase rect would otherwise eat clicks meant for siblings beneath the rect's empty corners.
- `destroy()` is depth-first and destroys the Pixi container with `{ children: true }`. Don't reuse a node after destroy; don't manually destroy `container` separately.
- `LayoutNode` doesn't drive Pixi's own event/hitArea system. If we wire pointer events later, route them through our `hitTestLayout`, not Pixi's.
- **Re-registering a `ZoneId` overwrites the previous surface** with a debug warning — typical when the same scene gets re-entered without proper cleanup. Surfaces should call `unregister(zoneId)` in their `destroy()`.
