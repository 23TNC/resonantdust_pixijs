# AGENTS.md

## Purpose
Game logic for in-play cards: spawn/destroy, stack chains, drag-drop, inventory layout, recipe matching, definition decoding. Everything that's "what's happening to the cards the player can see" lives here. Pure data flows in (`ctx.data.cardsLocal`) and pure layout / reducer calls flow out — this folder doesn't talk to the SpacetimeDB SDK directly (that's `../server/`).

## Subfolders
- `cards/`: `Card` (composite of game + layout halves), `CardManager` (registry, zones, stack chain ops, splice), `cardData` (microZone/microLocation packing helpers), `layout/rectangle` and `layout/hexagon` (per-shape `Game*Card` + `Layout*Card` pairs).
- `actions/`: `ActionManager` — the recipe pre-filter + submission queue.
- `definitions/`: `DefinitionManager` — wasm-backed wrapper around the `resonantdust-content` crate. Exposes `decode`, `findPackedByKey`, `cardFlagBit`, `matchStackRecipe`. Bootstraps via `await initDefinitions()` in `main.ts`.
- `input/`: `InputManager` (canvas-level pointer + keyboard plumbing), `DragManager` (pickup / drop, with `position_hold` / `drop_hold` flag enforcement).
- `inventory/`: `GameInventory` (per-zone overlap-push and clamp), `InventoryLayout` (the right-column `LayoutNode`).
- `layout/`: scene-agnostic layout primitives (`LayoutManager`, `LayoutNode`).
- `titlebar/`, `zones/`: title bar HUD; ZoneManager (subscription bookkeeping).

## Data tier rule (load-bearing)
**Read `ctx.data.cardsLocal`. Never `ctx.data.cards.current` from this folder.**

The `mirrorCard` rule in `../server/data/DataManager.ts` preserves inventory-loose position fields from the local row; the server's view of an inventory-loose card always has `microLocation = 0` (server doesn't track inventory pixel coords). So `data.cards.current` is "what the server thinks", not "what the user sees", and reading `microLocation` off a server-tier row gives `(0, 0)` for any card the player has moved.

This is the bug fingerprint: *cards mysteriously snap to the top-left corner after some life-cycle event*. If you're writing a chain walk, an existence check, an orphan check, a splice handler, or anything else that asks "where is card N?" — it goes through `cardsLocal`. The only reads from `data.cards` allowed in `game/` are the tier itself (none today). All ~13 sites that violated this rule were migrated in the splice-bug pass; new code should keep that.

## Card lifecycle

### One Card per `card_id`, persists across updates
`CardManager` keys `cards: Map<number, Card>` by `card_id`. The map is populated only on the local-tier `added` event and torn down on `removed`. **Updates do not destroy the Card** — the per-key listener inside `Card` (`subscribeLocalCardKey`) runs `onDataChange` which mutates the existing instance in place via `applyData`. If you find yourself reasoning "cards must be re-spawning because they re-appear at (0,0)", the most likely candidates are:

1. **The tier-rule pitfall** (game code reading `data.cards.current` instead of `data.cardsLocal` for position) — fixed across the rect-chain code in the splice migration but easy to reintroduce.
2. **`ValidAtTable.promote` firing `removed` then `added`** for an id whose validAt row was replaced. SpacetimeDB's cleanup sweep deletes the old row in a separate transaction from the write that scheduled it; if the SDK delivers `onDelete` before `onInsert` with a frame in between, `promote` would naively fire `removed` between them. The `knownIds` guard added in `ValidAtTable` suppresses that — see [`server/AGENTS.md`](../server/AGENTS.md#promotenows-knownids-guard-load-bearing). If you ever see `setTarget` snap to a fresh value for a Card that should already exist, this is the second place to look.

### Death + reap (the `dead` lifecycle)
The server signals card death via an UPDATE that sets `flags & FLAG_ACTION_DEAD` (bit 7). It does NOT immediately DELETE the row — the row lingers for a reap delay so the client can run an animation against the `valid_at` timestamp.
1. Server pushes the dead-flagged row → `mirrorCard` writes `cardsLocal` with `dead: 1`.
2. `RectCard.applyData` sees `(row as LocalCard).dead === 1`, starts the death animation, sets `dying = true`.
3. Animation runs in `RectCard.layout` over a few frames.
4. On animation complete, `RectCard` writes `dead: 2` to local (so a re-mirror doesn't replay) and calls `CardManager.spliceCard(this.cardId)`.
5. `spliceCard` reads `cardsLocal` for the dying card's position, transplants the survivors (top stack becomes new root, etc.), and writes new local rows for them via `setCardPosition`. State-2 chain members get re-rooted and renumbered as needed; **state-1 (Slot) immediate children get transplanted** via `transplantSlotChildren` — the top child (or bottom if no top) inherits the dying card's `macroZone` / `surface` / `microZone` / `microLocation` byte-for-byte and takes its slot wherever it was; if both directions had children, the bottom re-anchors to the new top. Transitive state-1 descendants (grandchildren and below) are NOT touched — their `microLocation` references stay valid because we promoted the immediate child rather than removing it. The chain shape is preserved minus the dying card.
6. Eventually the server reaps (DELETE) the row → `CardManager.destroy(id)` runs.

**Orphan-slot defensive recovery.** Independent of splice: `mirrorCard` checks every incoming state-1 row against `cardsLocal.has(microLocation)`. If the parent isn't present locally (subscription gap, server bug, deletion race), the slot is rewritten to inventory loose at the mirror boundary — `macroZone = ownerId`, `surface = 1`, `microLocation = 0`, state cleared to `STACKED_LOOSE`. Different shape from the splice transplant: at the mirror boundary we have no surviving "dying card" row to inherit from, so we fall back to inventory loose.

Between steps 1 and 6 the dead card is **still in `cardsLocal`** at its old position. Live-world iteration (e.g. inventory's `tryPush`) must skip these — if it doesn't, the survivor that was just spliced into the dead card's spot collides with the still-present dead row and the perfect-overlap tie-break in `tryPush` shoves it sideways. `InventoryGame.tryPush` early-outs when either side has `dead` truthy.

### Stack chains — two attachment modes

A "chain" is built from cards in two complementary states:

- **`STACKED_SLOT` (state 1)** — `microLocation` is the **immediate
  parent's** card_id. `microZone` carries only `direction` (position
  is implicit via parent-pointer walk). **The default state for
  client drag-stack writes** as well as for server-written recipe
  slots above the actor (when the recipe doesn't pin to root).
  Parent-pointer semantics mean dragging a chain member off the
  stack takes everything above it along: their `microLocation`
  references their immediate predecessor (which now sits at a new
  loose position), so they stay logically and visually attached to
  it.
- **`STACKED_ON_ROOT` (state 2)** — `microLocation` is the chain
  root's card_id. `microZone` carries `(position: u5, direction: u1)`.
  O(1) `rootOf` (one read). **Server-only writes today** — written
  by `propose_action` for the actor of a rooted recipe, where the
  server is asserting the actor's chain distance from root via the
  `position` field. Legacy data from earlier client drag-stack writes
  may also still be state-2; chain-walking helpers like `buildChain`
  handle either state uniformly.

Mixed chains are normal: a state-2 rooted-recipe actor pins to R at
position N, while every other chain member (drag-stacked below the
actor and recipe slots above) is state-1 referring to its immediate
predecessor.

`Card.stackedTop` / `stackedBottom` are immediate-child back-pointers
maintained from data by `Card.onDataChange`. They reflect "my immediate
child" in either mode and are correct enough for visual reparenting
(Pixi container hierarchy) but **NOT** safe as the source of truth for
chain walks in mixed chains: a state-2 card whose chain-index-N-1
sibling is state-1 falls back to `parent = R` in `stackParentOf`,
clobbering R's `stackedTop` cache slot. Anything that needs the chain
in visual order — recipe matching, splice inspection of a full chain —
goes through `CardManager.buildChain(R, direction)` instead.

`buildChain(R, direction)` returns the chain in visual order by:
1. Enumerating R's direct children (state-2 with `microLocation == R`
   OR state-1 with `microLocation == R`, all with matching direction).
2. Computing each direct child's chain index — state-2 uses the
   `position` field; state-1 directly on R sits at chain index 1.
3. Sorting direct children by chain index.
4. For each direct child, recursively appending its state-1 children
   (cards with `microLocation == thisCard`, state == SLOT, matching
   direction). The recursion handles state-1 islands hung off any
   chain step — including state-1 chains that sit between two state-2
   cards in the same chain.

Result: a flat ordered list of every chain member from R outward,
correct regardless of how state-1 and state-2 cards interleave. Sparse
state-2 positions (e.g. position 13 with no card at 10/11/12) just
appear as gaps in the order; the matcher treats them like any other
chain — recipes that need contiguity won't match across gaps.

`CardManager.rootOf(cardId)` branches on state:
- state 0 (Free): card is its own root.
- state 1 (Slot): walk via `microLocation` parent-pointers until a
  non-Slot state is hit (`OnRoot`, `Free`, or `OnHex`). For chains
  ending in `OnRoot`, then take that one's `microLocation` as the
  final root.
- state 2 (OnRoot): one-hop — `microLocation` IS the root.
- state 3 (OnHex): legacy walk via `microLocation` (parent hex chain).

Constraints maintained by `CardManager.stack`:
- A card's chain is **uniform-direction**: all cards on the same side
  of the loose root link the same way (top OR bottom). If you stack a
  card whose chain mixes sides, the stack is rejected.
- If the dragged card has children only in the *opposite* direction
  of the requested attach, `flipChain` flips that side first and the
  stack proceeds.

## ActionManager (recipe matching)
Watches stack-change events from `CardManager` and asks `definitions.matchStackRecipe(...)` repeatedly against the chains rooted at each loose root. R is always the recipe's root tier; there is no "sub-root" concept. Multiple matches per evaluation are normal — every recipe that can fit somewhere in the chain gets queued, with each match's consumed cards reserved for the rest of that evaluation pass.

### The matching algorithm

**Inputs per loose root R:**
- `hex` = R's hex parent's def if R is `STACKED_ON_HEX`, else 0.
- `topChain` = `cards.buildChain(R, up)` — every chain member above R in visual order, mixing state-2 and state-1 (see [Stack chains](#stack-chains--two-attachment-modes)).
- `botChain` = `cards.buildChain(R, down)` — same for below.
- `held` = an evaluation-local set, seeded with cards whose `flags` carry `slot_hold` and grown by every match this pass.

**A "sub-chain" is a maximal run of contiguous unheld cards** within `topChain` or `botChain`. The "first sub-chain" of a direction is the one whose first card sits at chain index 1 — i.e. R-adjacent with no held block between R and it. If chain index 1 is held, the direction has no first sub-chain; every run of unheld cards in that direction is "subsequent."

**Loop until a full pass produces no match (restart-on-match):**

- **Phase 1 — rooted firsts (top before bottom).** `match(hex, R.def, firstSubChain.defs, dir)`. The matcher slides the recipe's actor window across `[R, ...firstSubChain]` and returns the highest-scoring recipe match.
- **Phase 2 — rootless firsts.** Skipped if R is held. `match(hex, 0, [R, ...firstSubChain].defs, dir)` — R is prepended into the slots, no root tier passed, so the matcher can match recipes that don't constrain root.
- **Phase 3+ — rooted subsequents (interleaved by sub-chain index across directions).** `match(hex, R.def, subsequentSubChain.defs, dir)` for each remaining sub-chain past the first held block, walked in chain-index order, top before bottom at each index.

On any match: add the consumed cards (the recipe's slot window) to `held` and restart the loop. R is added to `held` only when a rootless match consumes it as slot 0. Hex is never added.

When no phase produces a match, the loop terminates. Every match accumulated this pass becomes a queue entry; entries with the same key (see below) are de-duplicated by stable identity, fresh ones replace stale ones, and dropped ones are cancelled.

**Consumed-card mapping.** The matcher's `chain` is `[root_card_or_None, ...slot_cards]`. A returned `slot_start` ≥ 1 always (rooted recipes have `min_start=1`; rootless attempts have `chain[0] = None` so `slot_start=0` always fails). Consumed indices in our `slots` array = `[slot_start - 1 .. slot_start - 1 + slot_count]`.

**Why drop the "sub-root" concept.** Treating cards past a held block as their own roots produced asymmetric duplicate matches (e.g. `corpus_up` + `corpus_down` on a 2-card chain) and a confusing rule about which direction a sub-root walks. The new model has one root per stack — R — and recipes that want to ignore root match via the rootless rule (Phase 2 only).

### Submitted-action lock
On timer fire, the queue entry is marked `submitted: true` and `proposeAction` is dispatched. While submitted, `evaluateRoot` and the cluster-pruning paths leave it alone — the server has been told and the player can't cancel. The promise's `then`/`catch` cleans up. Once the server's slot_hold flags arrive, the next chain walk excludes those cards naturally.

## Drag-drop
1. `DragManager.handleDragStart` checks `position_hold` and `position_locked` on the source row's `flags`. Either one blocks pickup.
2. On drop, checks `drop_hold` and `drop_locked` on the target's flags. Either one rejects the drop and the card snaps back.
3. On accepted drop, `Card.setPosition` → `CardManager.setCardPosition` → `setLocalCard` writes the new row → per-key listener triggers `onDataChange` → tween to new target on next frame.
4. Reducer call only happens later (if at all): the `ActionManager` watches the stack change and may queue a `proposeAction`.

## Conventions
- **All chain reads use `cardsLocal`.** Repeating the tier rule because it's the single most common bug source in this folder.
- **`Card` instances persist across data updates.** Don't write code that assumes destroy+respawn on flag changes; the `Card` is alive and applying the new row.
- **Don't read `RectCard.dying` from outside the visual.** It's a per-instance animation flag, not part of the data model. The data-model signal is `LocalCard.dead`.
- **Stack changes fan out by loose root.** `CardManager.fireStackChange(rootId)` is called with the loose root id, not the card that actually moved. Subscribers walk the chain themselves to discover the cards in it.
- **`flags` bits come from the registry.** Use `definitions.cardFlagMask(name)` / `definitions.hasCardFlag(flags, name)` rather than hard-coding bit positions. The names are in `content/cards/flags.json`.

## Pitfalls
- **`encodeLooseXY` clamps to `[0, 0xffff]` and rounds.** Negative coords become 0; sub-pixel inputs round to the nearest integer. Inventory surfaces use positive coords so the clamp is invisible in practice, but the round means a position-set followed by a read can drift by 0.5 px.
- **`spliceCard` reads the dying card's `microLocation` to choose where survivors land.** This is `cardsLocal.get(id).microLocation` — i.e., the player's actual position. If the read goes through `data.cards.current` instead, you get (0, 0) and the "tween to top-left after death" bug.
- **`InventoryGame.tryPush` overlapping-tie-break is `(1, 0)`.** Two perfectly overlapping roots get pushed apart purely horizontally. This was the source of the "shifts down AND left" symptom — a freshly-spliced survivor lands on top of its still-present dead parent and gets shoved left. The fix is the `dead` skip at the top of `tryPush`; if you add new collision-style passes elsewhere, give them the same skip.
- **`microZone` packing is `(localQ << 5) | (localR << 2) | stackedState`** — the `mirrorCard` preserve rule keys on `localQ === 0`. A non-loose card (e.g. `STACKED_ON_RECT_X = 1`) can still have `localQ = 0` and the rule fires — what gates the rule is `surface` matching INVENTORY_LAYER on both sides PLUS `localQ === 0` on the server row. Don't add a new state bit pattern with non-zero `localQ` if you want that state's position fields preserved.
- **Hex-shape vs rect-shape branching is on `cardType`**, decoded via `DefinitionManager.shape(typeId)`. Card / GameCard / LayoutCard split on this at construction; don't add post-hoc shape changes.
- **`ActionManager`'s `delayMs` is a debounce, not a fire-and-forget timer.** Updating a queue entry restarts its timer. Drops cancel it. If you adjust the delay constant, remember the player's "I changed my mind" window scales with it.
