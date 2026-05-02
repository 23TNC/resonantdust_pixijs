# AGENT.md

## Purpose
Game-logic side of the Game/Render split. `GameManager` runs a fixed-rate game tick (separate from the Pixi render loop) and iterates per-zone `GameInventory` (and eventually `GameWorld`) instances. Game logic mutates `client_cards` via `data.cards.setClient`; render side reacts to those changes via the existing subscribeKey path.

## Important files
- `GameManager.ts`: scene-scoped tick driver (default 30Hz, accumulator-based, spiral-of-death guard). Holds a `Set<GameInventory>`. Driven by `GameScene.update` via `tick(deltaMS)`.
- `GameInventory.ts`: subscribes to `ctx.cards.subscribe(zoneId)` for one inventory zone, holds `Set<GameRectCard>`, runs overlap-push on loose cards every game tick.

## Conventions
- **Tick separation.** Render runs every frame (Pixi ticker, ~60Hz); game runs at `TICK_HZ` (currently 30). `GameManager.tick` accumulates frame deltas and steps fixed game ticks. Game logic uses `dt` (seconds) for time-based motion if it has any — overlap-push doesn't, since it's pure resolution.
- **Game writes to `client_cards`, not server.** `GameRectCard.setLoosePosition` calls `data.cards.setClient` — local-only; no reducer call. Server only sees the position once a state-changing action (recipe start, drop into shared zone, etc.) triggers a send. Inventory fiddling is free.
- **Read-write via `cardData` codec.** Position lives encoded in `Card.data: u64`; never read/write the raw bigint outside `cards/cardData.ts`. The codec dispatches on `flags.stackedState` so loose vs stacked cards are handled distinctly.
- **GameInventory only acts on loose cards.** Stacked cards (`stackedState ∈ {1,2,3}`) track their parent; inventory bumps the root, not the stack. `tryPush` filters by `isLoose()` first.
- **Cards in the inventory zone are assumed rect-shaped.** `GameInventory` filters with `instanceof GameRectCard` so a stray hex card in the zone (shouldn't happen, but defensive) is ignored, not crashed on.

## Pitfalls
- `cardData.ts` bit layout is **placeholder** until the server-side spec is confirmed. All consumers must go through the codec — flipping a single bit position propagates correctly.
- `setLoosePosition` triggers a `setClient` which fires `Card.onDataChange` which calls `applyData` on the same `GameRectCard` — re-decoding the value we just wrote. Cheap, no loop, but be aware: **read paths must be idempotent** with respect to their own writes.
- `GameManager.tick` caps catch-up at `MAX_CATCHUP_TICKS`. If render hangs for several seconds, game time freezes for the gap rather than running 200 ticks in one frame. Acceptable trade-off; if real-time consistency matters later, reconsider.
- Overlap-push is currently O(N²) per tick. Fine for small inventories (<100 cards). When that bites, switch to a spatial index (uniform grid keyed by RECT_CARD_WIDTH).
- A card whose position is `(0, 0)` and overlaps a sibling at the same point gets a hardcoded `(1, 0)` tie-break direction — they'll separate but along a fixed axis. Initial spawn positions should be jittered server-side or upon first observation to avoid stacks at origin.
