# AGENT.md

## Purpose

Client-side **upgrade pre-filter** for the action / magnetic-action
machinery. Mirrors the server's `actions.rs::process_branch` so the
client can decide whether a stack submission would actually change
server-side state, and skip submitting when it wouldn't. Also mirrors
the public-table state for in-progress actions and magnetic actions
into per-card listeners that card visuals subscribe to for progress
rings and death animations.

A stack-change event walks every potential actor in the affected
branches, scores all recipes against each actor's visible window, and
applies the four-way upgrade decision:

| Current action | Best recipe at actor | Outcome |
| --- | --- | --- |
| none | none | nothing |
| none | r | server would start → submit |
| a | none | server would cancel → submit |
| a | same recipe | keep running → noop |
| a | different recipe | server would upgrade → submit |

If no candidate in any branch would change state, the submission is
skipped — no round-trip, no server-side recompute, no chance of an
action timer reset. The server is the authoritative evaluator and
re-runs the same calculation; the client doesn't trust its prediction.

## Important files

- `ActionManager.ts`: scene-scoped, takes `(ctx, zoneId)`. Subscribes to
  `ctx.cards.subscribeStackChange(zoneId, …)`,
  `ctx.data.subscribe("actions", …)`, and
  `ctx.data.subscribe("magnetic_actions", …)`. Holds two parallel
  `byActionId` / `byCardId` maps — one for `Action` rows
  (`CachedAction`), one for `MagneticAction` rows (`CachedMagneticAction`).
  Also exports the `FLAG_ACTION_CANCELED` / `FLAG_ACTION_COMPLETE` /
  `FLAG_ACTION_DEAD` bit constants used by card visuals to switch
  animation phases.
- **Per-card listeners.** `subscribeAction(cardId, listener)` /
  `subscribeMagneticAction(cardId, listener)` deliver the action /
  magnetic-action currently bound to that card; LayoutHexCard /
  LayoutRectCard use these to drive progress rings, death fades, and
  cancellation cues.

## Conventions

- **One action per actor.** `byCardId` is `Map<number, number>`. The
  recipe model assumes a card is the actor for at most one in-flight
  recipe.
- **Magnetic actions are tracked separately from regular actions.** A
  card may simultaneously be the anchor of a `MagneticAction` (during
  the slot-fill phase) and the actor of an `Action` (after the
  magnetic phase queues an inner). The two tables are independent
  registries; subscribers to one don't see the other.
- **Visible chain walk.** From an actor candidate, extend outward
  including cards that are *free* or *in the actor's own action*. Stop
  at the first card claimed by some other action (excluding it). The
  client reconstructs claims from `byCardId` plus
  `participantsUp/Down` since `CardHold` rows aren't subscribed.
- **Cross-branch-type guard.** A Y-stack root may be the actor of a
  TopStack action while we're processing the bottom branch (or vice
  versa). When the actor's current action is for the *other* branch
  type, leave it alone — that branch's evaluator owns its fate.
  Mirrored on the server in `actions.rs::process_actor_candidate`.
- **Same-type, same recipe ⇒ noop.** When the best recipe at an actor
  matches its current `Action.recipe` index, the pre-filter says no-op.
  Strict slot-filler equality (the server-side check that catches
  "same recipe but different filler card_ids") is intentionally **not**
  mirrored here — `CardHold` rows aren't in the client's subscription
  so we can't see frozen claims. A user who moves a slot filler away
  also fires `onStackChange` on the destination chain; that submission
  reaches the server which reconciles. Worst case: a brief lag before
  the action's stale claim is resolved.
- **Two-branch walking, both directions independent.** `top_stack`
  recipes only see the top chain; `bottom_stack` only see the bottom.
- **Stack-change events come per-affected-root, possibly twice per
  move.** When a card moves between two chains we hear both old and
  new roots; both branches of each get evaluated.
- **Recipe matching uses weighted scoring.** `RecipeManager` exposes
  `recipesOfType(type, direction)`, `scoreRecipeForActor(...)`, and
  `compareWeight(a, b)`. ActionManager iterates `recipesOfType` and
  picks the highest-weight non-blocked match per actor — same as the
  server's `actions.rs::process_actor_candidate`. Per-leaf weights
  (`Card`=4, `Aspect`=3, `Type`=2, `Any`=1) and the lex-ordered
  `MatchWeight { tile, root, slot }` triple must stay in sync with the
  server; both sides read the same `data/recipes/*.json`.
- **Submit goes through a single reducer.** `SpacetimeManager.submitStacks`
  calls `submit_inventory_stacks` — that's how every state change
  reaches the server (start, cancel, upgrade all flow from it). There
  is no separate cancel reducer.
- **Death is observed, not driven, by ActionManager.** When the server
  flags an action dead (`FLAG_ACTION_DEAD`), the row update arrives via
  `data.subscribe("actions")` and ActionManager updates its caches; per-card
  listeners fire so visuals can play a fade. The actual `delete` arrives
  ~10s later when the server-side reaper runs.

## Pitfalls

- **`ctx.cards` is scene-scoped and may be null.** The ctor checks; if
  you instantiate `ActionManager` outside `GameScene.onEnter`, you'll
  get a clean error.
- **Visible-chain walk assumes the actor's `participantsUp/Down` is
  accurate for the current chain.** If the chain has shrunk so an
  action's claim window now extends past the chain end, the
  `claimedBy` map clamps with `j < chain.length` and silently
  drops the missing cards. The actor evaluator then sees `best = null`
  for the truncated visible window and submits → server cancels.
- **Slot-filler identity changes that preserve recipe match aren't
  detected.** See the same-type/same-recipe convention above.
- **Chain depth is capped at `CHAIN_MAX_DEPTH = 64`.** Defensive
  against malformed cyclic data.
- **`upsert` on an existing actionId with a different cardId** rewires
  `byCardId` for the old actor before claiming the new entry — design
  choice for an "actor moved across recipes" scenario, though the
  server's actor never changes for the lifetime of an action.

## See also

- [`spacetime/docs/recipe-upgrade.md`](../../../spacetime/docs/recipe-upgrade.md)
  — full mechanics and the server-side authoritative implementation.
- [`data/recipes/AGENT.md`](../../data/recipes/AGENT.md) — recipe-author
  view of priority and the upgrade rule, plus the lockstep-with-server
  requirement.
