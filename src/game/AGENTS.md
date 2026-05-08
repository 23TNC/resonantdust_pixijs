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
`CardManager` keys `cards: Map<number, Card>` by `card_id`. The map is populated only on the local-tier `added` event and torn down on `removed`. **Updates do not destroy the Card** — the per-key listener inside `Card` (`subscribeLocalCardKey`) runs `onDataChange` which mutates the existing instance in place via `applyData`. If you find yourself reasoning "cards must be re-spawning because they re-appear at (0,0)", check first whether something else is forcing the position to (0,0) (e.g. the tier-rule pitfall above) — destruction-and-respawn is rare in this codebase.

### Death + reap (the `dead` lifecycle)
The server signals card death via an UPDATE that sets `flags & FLAG_ACTION_DEAD` (bit 7). It does NOT immediately DELETE the row — the row lingers for a reap delay so the client can run an animation against the `valid_at` timestamp.
1. Server pushes the dead-flagged row → `mirrorCard` writes `cardsLocal` with `dead: 1`.
2. `RectCard.applyData` sees `(row as LocalCard).dead === 1`, starts the death animation, sets `dying = true`.
3. Animation runs in `RectCard.layout` over a few frames.
4. On animation complete, `RectCard` writes `dead: 2` to local (so a re-mirror doesn't replay) and calls `CardManager.spliceCard(this.cardId)`.
5. `spliceCard` reads `cardsLocal` for the dying card's position, transplants the survivors (top stack becomes new root, etc.), and writes new local rows for them via `setCardPosition`.
6. Eventually the server reaps (DELETE) the row → `CardManager.destroy(id)` runs.

Between steps 1 and 6 the dead card is **still in `cardsLocal`** at its old position. Live-world iteration (e.g. inventory's `tryPush`) must skip these — if it doesn't, the survivor that was just spliced into the dead card's spot collides with the still-present dead row and the perfect-overlap tie-break in `tryPush` shoves it sideways. `InventoryGame.tryPush` early-outs when either side has `dead` truthy.

### Stack chains
A "chain" is a linked list of cards via `Card.stackedTop` / `stackedBottom` back-pointers (kept in sync with row data by `Card.onDataChange`). The bottom of a top-stack chain (or top of a bottom-stack chain) is the **loose root** — the only card whose `microZone` has `stackedState === STACKED_LOOSE`. `CardManager.rootOf(cardId)` walks up the chain (always reading from `cardsLocal`) to find it.

Constraints maintained by `CardManager.stack`:
- A card's chain is **uniform-direction**: all cards on the same side of the loose root link the same way (top OR bottom). If you stack a card whose chain mixes sides, the stack is rejected.
- If the dragged card has children only in the *opposite* direction of the requested attach, `flipChain` flips that side first and the stack proceeds.
- The leaf walk `validatedSlot` repairs stale back-pointers as it walks, so divergent client/server views self-heal during the next interaction.

## ActionManager (recipe matching)
Watches stack-change events from `CardManager` and asks `definitions.matchStackRecipe(...)` whether a chain matches a recipe. Maintains a `Map<key, QueuedAction>` keyed on `(subRootId, direction)`. Each match starts a 5-second debounce timer; on expiry, fires `ctx.reducers.proposeAction(...)`.

### The matching algorithm (it's specific)
For each loose root that fires a stack-change event:
1. **The loose root walks both directions.** Its top stack (cards above, walked bounded by `slot_hold`) is matched against `Stack(Up)` recipes; its bottom stack against `Stack(Down)`. **Up recipes only see the top stack; down recipes only see the bottom stack.** One matcher call per direction; the matcher's own actor-sliding handles both rooted and rootless recipes inside that call.
2. **Held-block sub-roots walk only one direction.** A non-loose-root card that sits past a `slot_hold` block (the first non-held card on the far side) is a sub-root, but ONLY in the direction extending *away* from the held block. A card with held below it is an "up" sub-root; one with held above it is a "down" sub-root. Sub-roots pass `rootDef = subRoot.def`, `hexDef = 0` (sub-roots aren't on hexes).

Why the asymmetry: a chain `[A loose, B]` of two corpus cards has both an up-recipe (`corpus_up`) and a down-recipe (`corpus_down`) that mirror each other. Treating both endpoints as roots produces two queue entries for the same physical action. The loose root + direction-bound sub-roots rule eliminates the duplicate without losing matches past held blocks. See the comment on `evaluateRoot` in `actions/ActionManager.ts`.

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
