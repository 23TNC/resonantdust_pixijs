import type { Card as CardRow } from "../../server/spacetime/bindings/types";
import type { Card, StackDirection } from "../cards/Card";
import {
  getStackDirection,
  getStackedState,
  STACK_DIRECTION_DOWN,
  STACK_DIRECTION_UP,
  STACKED_ON_ROOT,
  STACKED_SLOT,
} from "../cards/cardData";
import { GameHexCard } from "../cards/layout/hexagon/HexCard";
import { GameRectCard } from "../cards/layout/rectangle/RectCard";
import { LayoutCard } from "../cards/layout/CardLayout";
import type { GameContext } from "../../GameContext";
import type { LayoutNode } from "../layout/LayoutNode";
import {
  INVENTORY_LAYER,
  packMacroZone,
  packZoneId,
  WORLD_LAYER,
  ZONE_SIZE,
} from "../../server/data/packing";
import type { PointerEventData } from "./InputManager";

/** Maximum allowed chain depth from root to leaf, exclusive of the
 *  root itself. State-2 (`OnRoot`) rows pack `position` into a u5
 *  (0..31). A combined chain (target's existing chain in `direction`
 *  plus the dragged card and its subtree) whose new leaf would land at
 *  index > 31 corrupts on the next state-2 write — we reject the
 *  stack and fall through to the loose / inventory fallback instead. */
const MAX_CHAIN_DEPTH = 31;

/** Inventory `unequip_card` reducer takes targetX / targetY as i16. */
const I16_MIN = -0x8000;
const I16_MAX = 0x7fff;

/**
 * Resolved drop intent. Mirrors the four `CardPositionState` shapes that
 * `CardManager.setCardPosition` understands, plus a `rejected` variant
 * for snap-back. The resolver is the single site that turns hit-test
 * output into one of these; the executor is a 1:1 dispatch.
 *
 * - `stack`: drop onto a card's chain. `direction: "top" | "bottom"`
 *   for rect chains; `direction: "hex"` for a rect mounted on a hex
 *   (the only hex-mount intent today).
 * - `world`: place the card on a bare world hex tile at (q, r).
 * - `loose`: stay on the source card's current zone, free xy.
 * - `inventory`: route to the active soul's inventory at xy (changes
 *   surface to INVENTORY_LAYER).
 * - `rejected`: snap back, no write. Used for drop_hold / drop_locked
 *   targets and (post-gate) for surface_locked sources whose intent
 *   would cross surfaces.
 */
export type DropIntent =
  | { kind: "stack";     target: Card;   direction: StackDirection }
  | { kind: "world";     q: number;      r: number }
  | { kind: "loose";     x: number;      y: number }
  | { kind: "inventory"; x: number;      y: number }
  | { kind: "rejected";  reason: string };

/** Captured at drop time. `sourceRow` is read from `cardsLocal` once and
 *  passed through — the resolver, gate, and executor all share the same
 *  view of the source's pre-drop state. */
export interface DropContext {
  ctx: GameContext;
  card: Card;
  sourceRow: CardRow;
  up: PointerEventData;
  /** Cursor → card top-left at drag start, in canvas-local coords. Used
   *  for xy translation across surface frames. */
  offsetX: number;
  offsetY: number;
}

// ============================================================
// Entry points
// ============================================================

/**
 * Walk the rect-drop decision tree and return a normalized intent.
 *
 * Order (first match wins; chain-overflow and unusable-target paths
 * fall through to step 2/3/4 rather than upgrading to `rejected`,
 * preserving today's "stack failure ⇒ loose fallback" behavior):
 *
 *  1. Direct hit on a card under the cursor → `stack` (rect chain or
 *     hex mount). drop_hold / drop_locked targets short-circuit to
 *     `rejected`. Hex with a full mount is unusable; fall through.
 *  2. Cursor inside the world view → world-tile resolution.
 *     Occupant on the tile is treated as the drop target (same
 *     drop_hold reject + same chain-depth fallback). Empty tile →
 *     `world`.
 *  3. Source is on a world surface AND we have an active soul →
 *     `inventory` return. Surface-locked sources still produce the
 *     `inventory` intent here; `applySourceGate` rejects them.
 *  4. Default → `loose` in the source's current zone.
 */
export function resolveRectDrop(c: DropContext): DropIntent {
  // 1. Direct card target
  const directTarget = targetCardFromHit(c.ctx, c.up.hit, c.card.cardId);
  if (directTarget) {
    const direct = intentForCardTarget(c, directTarget);
    if (direct !== null) return direct;
  }

  // 2. World view drop
  const worldCoord = resolveWorldDropCoords(c);
  if (worldCoord) {
    const occupant = findCardAtTile(
      c.ctx,
      worldCoord.q,
      worldCoord.r,
      c.card.cardId,
    );
    if (occupant) {
      const occupantIntent = intentForCardTarget(c, occupant);
      if (occupantIntent !== null) return occupantIntent;
      // Occupant exists but can't be stacked on (chain overflow,
      // full hex mount). Fall through to fallback — do NOT place on
      // the tile, since the tile isn't empty.
      return resolveFallback(c);
    }
    return { kind: "world", q: worldCoord.q, r: worldCoord.r };
  }

  // 3/4. No target, no world view → fallback
  return resolveFallback(c);
}

/**
 * Hex shape drop. Today hex cards have no stack semantics and no
 * world-placement semantics — they live in inventory only. Mirrors the
 * rect fallback path: world-source → inventory return, otherwise loose.
 * Defensive: hex cards on world today are position-locked and wouldn't
 * reach this code path; the symmetry costs nothing.
 */
export function resolveHexDrop(c: DropContext): DropIntent {
  return resolveFallback(c);
}

/**
 * Source-side gate, applied after the resolver. Today's only gate is
 * `surface_locked`: the source row's flag bit blocks any intent that
 * would change `surface`. Rejecting here gives "snap back" UX rather
 * than the legacy `dropLoose` fall-through that could place the card
 * off-screen on the wrong surface.
 *
 * Destination surface per intent kind:
 *   - `stack`     → target's surface
 *   - `world`     → `WORLD_LAYER`
 *   - `inventory` → `INVENTORY_LAYER`
 *   - `loose`     → source's surface (no change, gate skipped)
 */
export function applySourceGate(
  intent: DropIntent,
  sourceRow: CardRow,
  ctx: GameContext,
): DropIntent {
  if (intent.kind === "rejected" || intent.kind === "loose") return intent;
  if (!ctx.definitions.hasCardFlag(sourceRow.flags, "surface_locked")) {
    return intent;
  }
  const destSurface = destinationSurface(intent, ctx);
  if (destSurface === null) return intent;
  if (destSurface === sourceRow.surface) return intent;
  return {
    kind: "rejected",
    reason: `surface_locked source (surface=${sourceRow.surface}) cannot move to surface=${destSurface}`,
  };
}

/**
 * Execute a resolved + gated intent. Three phases:
 *
 *  1. **Pre-fire unequip** if the source was in the local soul's
 *     UP-chain and the intent isn't "stack back on the same soul as
 *     equipment." Server writes the row Free-in-inventory at the
 *     given xy; the local row write below overrides visually until
 *     the server reply lands.
 *  2. **Local write** via `CardManager.setCardPosition` / `stack`.
 *     `stack` is used only for rect-on-rect (it walks the chain and
 *     re-stacks A's descendants); hex mounts and all other intents
 *     go through `setCardPosition` directly.
 *  3. **Post-fire equip** if the intent is "stack on the local soul
 *     as direction top" and the source wasn't already chained.
 *     Without this the server's view of the chain diverges from
 *     the client's local overlay.
 */
export function executeDrop(c: DropContext, intent: DropIntent): void {
  if (intent.kind === "rejected") return;

  fireUnequipIfNeeded(c, intent);

  switch (intent.kind) {
    case "stack":
      if (intent.direction === "hex") {
        c.ctx.cards?.setCardPosition(c.card.cardId, {
          kind: "stacked",
          parentId: intent.target.cardId,
          direction: "hex",
        });
      } else {
        c.ctx.cards?.stack(c.card.cardId, intent.target.cardId, intent.direction);
      }
      break;
    case "world":
      c.ctx.cards?.setCardPosition(c.card.cardId, {
        kind: "world",
        q: intent.q,
        r: intent.r,
      });
      break;
    case "loose":
      c.card.setPosition({ kind: "loose", x: intent.x, y: intent.y });
      break;
    case "inventory":
      c.ctx.cards?.setCardPosition(c.card.cardId, {
        kind: "inventory",
        x: intent.x,
        y: intent.y,
      });
      break;
  }

  fireEquipIfNeeded(c, intent);
}

// ============================================================
// Internal helpers
// ============================================================

/** Resolve the cursor's hit-target into a stacking intent, or null when
 *  the target isn't usable as a stack destination. Returns `rejected`
 *  when the target is blocked by `drop_hold` / `drop_locked`. */
function intentForCardTarget(c: DropContext, target: Card): DropIntent | null {
  if (targetBlocksDrop(c.ctx, target)) {
    return {
      kind: "rejected",
      reason: `target card=${target.cardId} has drop_hold or drop_locked`,
    };
  }
  if (target.gameCard instanceof GameRectCard) {
    const direction = directionFromCursor(c.up, target);
    if (wouldExceedChainDepth(c.ctx, c.card, target, direction)) {
      return null;
    }
    return { kind: "stack", target, direction };
  }
  if (target.gameCard instanceof GameHexCard) {
    if (target.stackedHex === 0) {
      return { kind: "stack", target, direction: "hex" };
    }
    // Hex mount taken — fall through to caller's fallback.
    return null;
  }
  return null;
}

/** Fallback intent shared by every "no usable target" path: world-source
 *  → inventory return when an active soul exists, otherwise loose in the
 *  source's current zone. Surface-locked sources still flow through the
 *  inventory branch here; `applySourceGate` converts to `rejected`
 *  downstream. */
function resolveFallback(c: DropContext): DropIntent {
  if (c.sourceRow.surface >= WORLD_LAYER) {
    const soulId = c.ctx.souls.getSoulId() ?? 0;
    if (soulId !== 0) {
      const inv = c.ctx.layout?.surfaceFor(packZoneId(soulId, INVENTORY_LAYER));
      if (inv) {
        const ig = inv.container.getGlobalPosition();
        return {
          kind: "inventory",
          x: c.up.x - ig.x - c.offsetX,
          y: c.up.y - ig.y - c.offsetY,
        };
      }
    }
  }
  const surface = c.ctx.layout?.surfaceFor(c.card.zoneId());
  if (!surface) {
    return { kind: "rejected", reason: "no surface for loose drop" };
  }
  const sg = surface.container.getGlobalPosition();
  return {
    kind: "loose",
    x: c.up.x - sg.x - c.offsetX,
    y: c.up.y - sg.y - c.offsetY,
  };
}

/** Convert intent → destination `surface` for the source-side gate.
 *  Returns null for intent kinds whose surface either doesn't change
 *  (`loose`) or is already filtered out (`rejected`). */
function destinationSurface(intent: DropIntent, ctx: GameContext): number | null {
  switch (intent.kind) {
    case "stack": {
      const targetRow = ctx.data.cardsLocal.get(intent.target.cardId);
      return targetRow?.surface ?? null;
    }
    case "world":
      return WORLD_LAYER;
    case "inventory":
      return INVENTORY_LAYER;
    case "loose":
    case "rejected":
      return null;
  }
}

/** Cursor-target resolution: unwrap a LayoutCard hit into a Card, or
 *  null for non-card hits, self-hits, and dead cards. Dead cards
 *  fall through (rather than producing a `rejected` intent) so the
 *  resolver's step-2 world-tile check still has a chance to fire —
 *  a player dropping onto a tile where a card just died should get
 *  a clean world-tile drop, not a snap-back. CardManager despawns
 *  `dead === 2` cards from the scene tree, but the in-flight
 *  animation window between `dead === 1` and `dead === 2` is still
 *  hit-testable, hence the explicit flag check here. */
function targetCardFromHit(
  ctx: GameContext,
  hit: LayoutNode | null,
  draggedId: number,
): Card | null {
  if (!(hit instanceof LayoutCard)) return null;
  if (hit.cardId === draggedId) return null;
  const row = ctx.data.cardsLocal.get(hit.cardId);
  if (row && ctx.definitions.hasCardFlag(row.flags, "dead")) return null;
  return ctx.cards?.get(hit.cardId) ?? null;
}

/** True if the target's `flags` block incoming drops:
 *  - `dead`: row was consumed by a recipe (`action_completion::apply`
 *    flipped the bit). The card is on its way to GC; stacking onto
 *    it would write into a doomed chain and surprise the player when
 *    the row vanishes. Reject so the drop falls through to the
 *    resolver's fallback (loose / inventory return).
 *  - `drop_hold` (temporary, e.g. mid-completion).
 *  - `drop_locked` (permanent, e.g. anchored world tiles). */
function targetBlocksDrop(ctx: GameContext, target: Card): boolean {
  const row = ctx.data.cardsLocal.get(target.cardId);
  if (!row) return false;
  return ctx.definitions.hasCardFlag(row.flags, "dead")
      || ctx.definitions.hasCardFlag(row.flags, "drop_hold")
      || ctx.definitions.hasCardFlag(row.flags, "drop_locked");
}

/** Upper half of `target` → top stack; lower half → bottom stack.
 *  Maps to the visual: drop near where the new card's peeking titlebar
 *  should appear. Works the same for peeking-title hits since those
 *  titles sit at the top/bottom edge of their own card. */
function directionFromCursor(
  up: PointerEventData,
  target: Card,
): StackDirection {
  const g = target.layoutCard.container.getGlobalPosition();
  const localY = up.y - g.y;
  return localY < target.layoutCard.height / 2 ? "top" : "bottom";
}

/** True if `cards.stack(dragged, target, direction)` would push some
 *  chain member past `MAX_CHAIN_DEPTH`. Counts:
 *  - `existing`: target's chain root outward in `direction`, excluding
 *    the root.
 *  - `dragged`: the dragged card + its descendants in both directions
 *    (CardManager.stack flips opposite-direction descendants into
 *    `direction`, so we count the whole subtree). */
function wouldExceedChainDepth(
  ctx: GameContext,
  dragged: Card,
  target: Card,
  direction: StackDirection,
): boolean {
  const cards = ctx.cards;
  if (!cards) return false;
  const targetRoot = cards.rootOf(target.cardId);
  const dirNum = direction === "top" ? STACK_DIRECTION_UP : STACK_DIRECTION_DOWN;
  const existing = cards.buildChain(targetRoot, dirNum).length;
  const draggedSize =
    1
    + cards.buildChain(dragged.cardId, STACK_DIRECTION_UP).length
    + cards.buildChain(dragged.cardId, STACK_DIRECTION_DOWN).length;
  return existing + draggedSize > MAX_CHAIN_DEPTH;
}

/** Compute the world hex (q, r) under the cursor, or null when the drop
 *  isn't inside the world view. Two signals: an explicit hit on
 *  `LayoutWorld` (empty world area), or a hit on a Card whose row sits
 *  on a world surface (a card occluded the tile). Either signal trusts
 *  the cursor to `worldView.localToWorld(...)`. */
function resolveWorldDropCoords(c: DropContext): { q: number; r: number } | null {
  const worldView = c.ctx.layout?.worldView;
  if (!worldView) return null;

  let inWorld = c.up.hit === worldView;
  if (!inWorld && c.up.hit instanceof LayoutCard) {
    const hitRow = c.ctx.data.cardsLocal.get(c.up.hit.cardId);
    if (hitRow && hitRow.surface >= WORLD_LAYER) inWorld = true;
  }
  if (!inWorld) return null;

  const g = worldView.container.getGlobalPosition();
  return worldView.localToWorld(c.up.x - g.x, c.up.y - g.y);
}

/** Search `cardsLocal` for the card occupying world tile (q, r) on the
 *  world surface. Prefers a rect occupant (the rect is the chain root
 *  for further state-1 chain members) over a hex occupant. `excludeId`
 *  excludes the dragged card itself. */
function findCardAtTile(
  ctx: GameContext,
  q: number,
  r: number,
  excludeId: number,
): Card | null {
  const cards = ctx.cards;
  if (!cards) return null;
  const zoneQ = Math.floor(q / ZONE_SIZE) * ZONE_SIZE;
  const zoneR = Math.floor(r / ZONE_SIZE) * ZONE_SIZE;
  const localQ = q - zoneQ;
  const localR = r - zoneR;
  const targetMacroZone = packMacroZone(zoneQ, zoneR);

  let hexCard: Card | null = null;
  let rectCard: Card | null = null;
  for (const [id, row] of ctx.data.cardsLocal) {
    if (id === excludeId) continue;
    if (row.surface < WORLD_LAYER) continue;
    if (row.macroZone !== targetMacroZone) continue;
    // Skip dead cards — `action_completion` flips `dead` at recipe
    // completion (e.g. `cut_tree` on the actor faculty) but the row
    // sits in `cardsLocal` until GC retention runs. Letting the
    // resolver pick it up would let the player stack onto a doomed
    // chain. Same reasoning as `targetBlocksDrop`.
    if (ctx.definitions.hasCardFlag(row.flags, "dead")) continue;
    // Both state-0 hex Cards on world and state-3 rect cards on a
    // hex tile encode local q/r in the legacy q/r bit-fields of
    // `microZone` (bits 5-7 = localQ, bits 2-4 = localR).
    const otherLocalQ = (row.microZone >> 5) & 0x7;
    const otherLocalR = (row.microZone >> 2) & 0x7;
    if (otherLocalQ !== localQ || otherLocalR !== localR) continue;
    const card = cards.get(id);
    if (!card) continue;
    if (card.gameCard instanceof GameRectCard) {
      rectCard = card;
    } else if (card.gameCard instanceof GameHexCard) {
      hexCard = card;
    }
  }
  return rectCard ?? hexCard;
}

// ============================================================
// Side effects
// ============================================================

/** Was the source row in the local soul's UP-chain (i.e. equipped) at
 *  drop time? Mirrors the server's equip-state predicate so the unequip
 *  reducer fires exactly when the server would accept it. */
function sourceWasEquipped(c: DropContext, soulId: number): boolean {
  const state = getStackedState(c.sourceRow.microZone);
  if (state !== STACKED_ON_ROOT && state !== STACKED_SLOT) return false;
  if (getStackDirection(c.sourceRow.microZone) !== STACK_DIRECTION_UP) return false;
  if (!c.ctx.cards) return false;
  return c.ctx.cards.rootOf(c.card.cardId) === soulId;
}

/** Fire `unequip_card` when the source was equipped on the local soul AND
 *  the resolved intent isn't "stack back on the same soul as equipment"
 *  (the equip-side mirror of this gate makes that a no-op). Server
 *  writes the row Free-in-inventory at the supplied xy. */
function fireUnequipIfNeeded(c: DropContext, intent: DropIntent): void {
  const soulId = c.ctx.souls.getSoulId();
  if (soulId === null || soulId === 0) return;
  if (!sourceWasEquipped(c, soulId)) return;

  const isReEquipOnSameSoul =
    intent.kind === "stack"
    && intent.target.cardId === soulId
    && intent.target.gameCard instanceof GameRectCard
    && intent.direction === "top";
  if (isReEquipOnSameSoul) return;

  const { x, y } = inventoryDropTargetXY(c, soulId);
  void c.ctx.reducers.unequipCard({
    cardId: c.card.cardId,
    targetX: x,
    targetY: y,
  });
}

/** Fire `equip_card` when the resolved intent is "stack onto the local
 *  soul as direction=top" AND the source wasn't already chained (state
 *  1 or 2). Server's equip reducer rejects already-chained sources, so
 *  this gate mirrors it client-side to avoid a wasted round-trip.
 *
 *  Scope is intentional: only direct-target-equals-soul cases fire here.
 *  Stacking onto something already on the soul (depth ≥ 2) still
 *  desyncs; widening would mean walking the local chain to root and
 *  gating on `root === soulId`. */
function fireEquipIfNeeded(c: DropContext, intent: DropIntent): void {
  if (intent.kind !== "stack") return;
  if (intent.direction !== "top") return;
  const soulId = c.ctx.souls.getSoulId();
  if (soulId === null) return;
  if (intent.target.cardId !== soulId) return;

  const state = getStackedState(c.sourceRow.microZone);
  const sourceAlreadyChained =
    state === STACKED_ON_ROOT || state === STACKED_SLOT;
  if (sourceAlreadyChained) return;

  void c.ctx.reducers.equipCard({ cardId: c.card.cardId });
}

/** Cursor → inventory-surface coords, clamped to i16 for the unequip
 *  reducer wire format. Returns (0, 0) when the active soul's inventory
 *  surface isn't registered (rare; the unequip still fires with a
 *  sentinel target). */
function inventoryDropTargetXY(c: DropContext, soulId: number): { x: number; y: number } {
  const invSurface = c.ctx.layout?.surfaceFor(packZoneId(soulId, INVENTORY_LAYER));
  if (!invSurface) return { x: 0, y: 0 };
  const ig = invSurface.container.getGlobalPosition();
  const rawX = Math.round(c.up.x - ig.x - c.offsetX);
  const rawY = Math.round(c.up.y - ig.y - c.offsetY);
  return {
    x: Math.max(I16_MIN, Math.min(I16_MAX, rawX)),
    y: Math.max(I16_MIN, Math.min(I16_MAX, rawY)),
  };
}
