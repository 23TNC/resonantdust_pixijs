# AGENT.md

## Purpose

Client-side **upgrade pre-filter**. Mirrors the server's
`actions.rs::process_branch` machinery so the client can decide whether
a stack submission would actually change server-side state, and skip
submitting when it wouldn't.

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
  `ctx.cards.subscribeStackChange(zoneId, …)` and
  `ctx.data.subscribe("actions", …)`. Holds `byActionId:
  Map<actionId, CachedAction>` (source of truth) and `byCardId:
  Map<cardId, actionId>` (reverse lookup for the actor check). On every
  stack-change event: collect both top and bottom chains rooted at the
  affected card, build a per-direction `claimedBy` map (which cards are
  in which action's slot window), walk every actor candidate position,
  apply the four-way decision, and submit the stack iff any candidate
  in either branch would trigger a change.
- `CachedAction` carries `recipe` (stable ID) in addition to
  participants — the recipe ID is what the upgrade decision compares
  against the matcher's best pick. The chain root isn't tracked: the
  server doesn't hold it in `CardHold` (leaving it free is what lets
  multiple recipes share one — `[attack, sword] + human` and
  `[heal, anima] + human` running concurrently) and doesn't store it
  on the `Action` row, so there's nothing for the client to mirror.

## Conventions

- **One action per actor.** `byCardId` is `Map<number, number>`. The
  recipe model assumes a card is the actor for at most one in-flight
  recipe.
- **Visible chain walk.** From an actor candidate, extend outward
  including cards that are *free* or *in the actor's own action*. Stop
  at the first card claimed by some other action (excluding it). The
  client reconstructs claims from `byCardId` plus
  `participantsUp/Down` since `CardHold` rows aren't subscribed.
- **Cross-branch-type guard.** A Y-stack root may be the actor of a
  TopStack action while we're processing the bottom branch (or vice
  versa). When the actor's current action is for the *other* branch
  type, leave it alone — that branch's evaluator owns its fate. Without
  this guard, one branch's iteration could unilaterally cancel the
  other branch's action just because a different-type recipe also fits
  the same actor. Mirrored on the server in
  `actions.rs::process_actor_candidate`.
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
  `recipesOfType(type)`, `scoreRecipeForActor(...)`, and
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
