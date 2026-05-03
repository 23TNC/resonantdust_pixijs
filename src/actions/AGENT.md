# AGENT.md

## Purpose
Two responsibilities, both driven by `CardManager`'s stack-change events:

1. **Cancel broken recipes.** Walk the affected chain; if any actor's chain length is now below its `Action.participants` requirement, ask `SpacetimeManager.cancelRecipe`.
2. **Detect newly-valid recipes.** Run `RecipeManager.match` against the affected chain in each direction. The actual recipe start happens server-side via `submit_inventory_stacks`; the client-side detection is for UI hints (highlighting valid stacks, showing "this stack will trigger X" before submit) and debugging.

## Important files
- `ActionManager.ts`: scene-scoped, takes `(ctx, zoneId)`. Subscribes to `ctx.cards.subscribeStackChange(zoneId, …)` and `ctx.data.subscribe("actions", …)`. Holds `byActionId: Map<actionId, CachedAction>` (source of truth) and `byCardId: Map<cardId, actionId>` (reverse lookup so the chain walk can ask "is this card an actor?" in O(1)). On every event: collects both top and bottom chains rooted at the affected card, runs cancel-checks against each, and runs `RecipeManager.match` against each direction with the appropriate `top_stack`/`bottom_stack` recipe type.

## Phase status
**Phase 3.** Detection added; cancel logic unchanged. Detection currently logs matches via `console.log` — no event emission API yet, no reducer call. The server still does the real recipe start; client-side detection is informational. Wire UI listeners or a reducer-call when ready.

**Cancel reducer** is still log-only (`SpacetimeManager.cancelRecipe`) — the real reducer hasn't been generated yet.

## Conventions
- **One action per actor.** `byCardId` is `Map<number, number>`, not `Map<number, Set<number>>`. The recipe model assumes a card is the actor for at most one in-flight recipe. If that breaks, the index becomes a Set and the cancel loop iterates.
- **Two-branch walking.** Stack roots can have a "Y" of children (top branch + bottom branch). On every event we collect both directions independently from `rootId` and run cancel + detection per direction. `top_stack` recipes only see the top chain; `bottom_stack` recipes only see the bottom chain.
- **Cancel decisions are based on post-change state.** Stack-change events fire after `Card.onDataChange` has updated back-pointers and re-parented, so when we walk the chain we see the new shape — the "did the chain shrink below `participants`?" check naturally reflects whatever just happened.
- **Loose-to-loose moves do NOT trigger us.** `Card.onDataChange` only fires `fireStackChange` when parent or stack direction changes; pure xy-only updates skip the block entirely. Matches the spec ("any case that wasn't a rejected drop or a loose -> loose drop").
- **Stack-change events come per-affected-root, possibly twice per move.** When a card moves between two chains we hear both old and new roots in succession; both cancel + detection run against each.
- **Recipe matching uses `ctx.recipes.match(defs, type)`.** Definitions are resolved per-chain via `ctx.data.get("cards", id) → ctx.definitions.decode(packedDefinition)`. Missing definitions become `null` slots that never match — recipe matching gracefully handles partially-undecodable chains.
- **Match priority is recipe declaration order.** First file (sorted by path), first recipe in array. `RecipeManager.match` returns the first hit, mirroring `actions.rs::try_match_stack`.

## Pitfalls
- **Y-root over-cancel.** When an actor sits at a root with both top and bottom branches, each branch is checked independently. If the actor is cancelled from one branch's check but the other branch still satisfies its `participants`, that's a false cancel. The cancel reducer is currently a stub so this is theoretical — once the real reducer lands, consider taking the union (or max) of the actor's two branches at root before deciding to cancel. Note left in the code at `checkCancels`.
- **Single-card chains don't trigger detection.** `top_stack`/`bottom_stack` recipes need at least slot 1 = the actor in a chain; a length-1 chain has no stack and no detection runs. The server's `on_create` recipes handle single-card cases (server-side trigger only — not our concern).
- **`ctx.cards` is scene-scoped and may be null.** The ctor checks; if you instantiate `ActionManager` outside `GameScene.onEnter`, you'll get a clean error.
- **`SpacetimeManager.cancelRecipe` is still a log-only stub.** The cancel reducer hasn't been generated yet — calls won't actually cancel anything on the server. Watch the console.
- **Detection logs to console** rather than emitting an event. Easy to extend with a `subscribeMatched(listener)` API when consumers (UI, reducer-trigger) appear.
- **Chain depth is capped at `CHAIN_MAX_DEPTH = 64`.** Defensive against malformed cyclic data; raise if a chain genuinely exceeds 64 cards in the future.
- **`upsert` on an existing actionId with a different cardId** rewires `byCardId` for the old actor before claiming the new entry — design choice for an "actor moved across recipes" scenario.
