# AGENT.md

## Purpose
Game-logic side of the Game/Render split. `GameManager` runs a fixed-rate game tick (separate from the Pixi render loop) and iterates per-zone `GameInventory` (and eventually `GameWorld`) instances. Game logic mutates client-side card state via `data.cards.setClient`; render side reacts to those changes via the existing subscribeKey path.

## Important files
- `GameManager.ts`: scene-scoped tick driver (default 30Hz, accumulator-based, spiral-of-death guard). Holds a `Set<GameInventory>`. Driven by `GameScene.update` via `tick(deltaMS)`.
- `GameInventory.ts`: subscribes to `ctx.cards.subscribe(zoneId)` for one inventory zone, holds `Set<Card>` (rect + hex), runs overlap-push on stack roots every game tick, clamps roots to the surface, finds empty grid slots for cards spawned at the origin, and exposes `snapToGrid()` (key-driven inventory tidy-up).

## Conventions
- **Tick separation.** Render runs every frame (Pixi ticker, ~60Hz); game runs at `TICK_HZ` (currently 30). `GameManager.tick` accumulates frame deltas and steps fixed game ticks. Game logic uses `dt` (seconds) for time-based motion if it has any — overlap-push doesn't, since it's pure resolution.
- **Game writes via `Card.setPosition` for chain-aware ops, raw `setLoosePosition` for direct moves.** `setPosition({ kind: "loose", x, y })` updates the row through `data.cards.setClient` — local-only; no reducer call. Server only sees the position once a state-changing action (recipe start, drop into shared zone, etc.) triggers a send. Inventory fiddling is free.
- **Read-write via `cardData` codec.** Position lives encoded across the row's top-level `microZone: u8`, `microLocation: u32`, and `flags: u8` columns; never read/write the raw fields outside `cards/cardData.ts`. The codec dispatches on `microZone.stackedState` (low 2 bits) so loose, top-stacked, bottom-stacked, and hex-anchored cards are handled distinctly. State constants must stay in lockstep with the server's `magnetic.rs` `STACK_STATE_*`.
- **Overlap-push runs on chain roots.** A stacked card moves with its root (the layout-tree parents to the root's stack-host); GameInventory walks each tracked card up via `microLocation` to its loose root, dedupes, then pairwise-pushes only the roots. Chain bounds are reconstructed via the cached `stackedTop` / `stackedBottom` back-pointers on `Card` so the push uses the full chain footprint, not just the root's rect.
- **Hex cards are always loose roots.** They never have `stackedState ∈ {1, 2}`, so the chain walk hits them and returns immediately. They participate in overlap-push as a hex-shaped bounding box.
- **`(0, 0)` is the spawn-time signal for "find me a slot."** When a card is observed at the origin, `clampToSurface` calls `findEmptyGridSlot` to place it in the first non-overlapping grid cell instead of dropping it under whatever is already there. Falls back to centering the card if the surface is full.

## Pitfalls
- The bit layout in `cardData.ts` is shared with the server (`magnetic.rs::STACK_STATE_*`). All consumers must go through the codec — flipping a single bit position requires the server change too.
- `setLoosePosition` triggers a `setClient` which fires `Card.onDataChange` which calls `applyData` on the same `GameRectCard` — re-decoding the value we just wrote. Cheap, no loop, but be aware: **read paths must be idempotent** with respect to their own writes.
- `GameManager.tick` caps catch-up at `MAX_CATCHUP_TICKS`. If render hangs for several seconds, game time freezes for the gap rather than running 200 ticks in one frame. Acceptable trade-off; if real-time consistency matters later, reconsider.
- Overlap-push is currently O(N²) per tick over chain roots (not all cards, since stacked children inherit their root's position). Fine for small inventories. When that bites, switch to a spatial index (uniform grid keyed by `GRID_W` / `GRID_H`).
- The chain-walk depth cap (`FIND_ROOT_MAX_DEPTH = 64`) is defensive against malformed cyclic data — in practice a chain has at most `MAX_STACK_BRANCH * 2 + 1 == 33` cards, so the cap shouldn't trip.
- Cards in the inventory zone whose chain root lives in *another* zone are skipped during the per-tick pass — that chain is the other zone's responsibility, even if some of its members visit ours.
