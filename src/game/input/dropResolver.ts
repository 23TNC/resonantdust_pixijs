import type { Card as CardRow } from "../../server/spacetime/bindings/types";
import { debug } from "../../debug";
import type { Card, StackDirection } from "../cards/Card";
import {
  STACK_DIRECTION_DOWN,
  STACK_DIRECTION_UP,
} from "../cards/cardData";
import { GameHexCard } from "../cards/layout/hexagon/HexCard";
import { GameRectCard } from "../cards/layout/rectangle/RectCard";
import { LayoutCard } from "../cards/layout/CardLayout";
import { LayoutWorld } from "../viewport/LayoutWorld";
import type { GameContext } from "../../GameContext";
import type { LayoutNode } from "../layout/LayoutNode";
import {
  INVENTORY_LAYER,
  makeMacroZone,
  microLooseCell,
  WORLD_LAYER,
  ZONE_SIZE,
} from "../../server/data/packing";
import type { PointerEventData } from "./InputManager";
import { owningSoul } from "../permissions";

/** `is_owned_by_player` — bit 4 of `cards_state` post unified-hold-counts
 *  rework. Used to verify that an equip-side target is actually a soul,
 *  not a non-soul card that happens to be at the drop position. */
const FLAG_OWNED_BY_PLAYER = 1 << 4;

/** Maximum allowed chain depth from root to leaf, exclusive of the
 *  root itself. State-2 (`OnRoot`) rows pack `position` into a u5
 *  (0..31). A combined chain (target's existing chain in `direction`
 *  plus the dragged card and its subtree) whose new leaf would land at
 *  index > 31 corrupts on the next state-2 write — we reject the
 *  stack and fall through to the loose / inventory fallback instead. */
const MAX_CHAIN_DEPTH = 31;

/** Inventory `placeCard` clamps `(x, y)` into a u32 pack of two
 *  i16's. Constants kept locally because the wire schema is u32 but
 *  the semantic range is signed-16. */
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
 * - `inventory`: route to a soul's inventory at xy (changes surface
 *   to INVENTORY_LAYER). The soul is derived from the source card's
 *   owning chain when possible — see `resolveFallback`.
 * - `rejected`: snap back, no write. Used for drop_hold / drop_locked
 *   targets and (post-gate) for surface_locked sources whose intent
 *   would cross surfaces.
 */
export type DropIntent =
  | { kind: "stack";     target: Card;   direction: StackDirection }
  /** Place at cell `(q, r)` in the viewport under the cursor. `(owner,
   *  surface)` come from that viewport (`LayoutWorld`): world is `(0,
   *  WORLD_LAYER)`, an inventory `(soulCardId, INVENTORY_LAYER)`, a mini-zone
   *  `(anchorId, MINI_ZONE_LAYER)`. Grid shape is irrelevant — any viewport
   *  resolves the same way. */
  | { kind: "world";     q: number;      r: number; surface: number; owner: number; offsetX?: number; offsetY?: number }
  | { kind: "loose";     x: number;      y: number }
  /** `soulCardId` is the inventory bucket's macro_zone — the soul's
   *  `card_id` for soul inventory, or the `player_id` for player
   *  inventory. `surface` discriminates (`INVENTORY_LAYER` vs
   *  `PLAYER_INVENTORY_LAYER`). Distinct from `c.card`'s current
   *  owner — placement doesn't transfer ownership. */
  | { kind: "inventory"; soulCardId: number; x: number; y: number; surface: number }
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
  /** Optional `DragHoldStore` consulted by `targetBlocksDrop` for the
   *  client-side "I'm currently mid-drag on this card" check. Passed
   *  in by `DragManager` when constructing the context; absent for
   *  unit-test fixtures that don't drive through DragManager. */
  dragHoldStore?: { has(cardId: number): boolean };
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
 *  3. Source is on a world surface AND we can derive an owning soul
 *     from the source's chain (or fall back to the active soul) →
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

  // 2. Viewport drop — the cell under the cursor in whichever viewport the
  // cursor is over (world, mini-zone, OR inventory; they're all `LayoutWorld`s
  // distinguished by `(owner, surface)`, not grid shape).
  const coord = resolveWorldDropCoords(c);
  if (coord) {
    const occupant = findCardAtTile(
      c.ctx,
      coord.q,
      coord.r,
      coord.surface,
      coord.owner,
      c.card.cardId,
    );
    if (occupant) {
      const occupantIntent = intentForCardTarget(c, occupant);
      if (occupantIntent !== null) return occupantIntent;
      // Occupant exists but can't be stacked on (chain overflow,
      // full hex mount). Fall through to fallback — do NOT place on
      // the cell, since it isn't empty.
      return resolveFallback(c);
    }
    return {
      kind: "world",
      q: coord.q,
      r: coord.r,
      surface: coord.surface,
      owner: coord.owner,
      offsetX: coord.offsetX,
      offsetY: coord.offsetY,
    };
  }

  // 3/4. No target, no viewport → fallback
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
  if (!ctx.definitions.hasCardFlag(sourceRow.flagsState, sourceRow.flagsBk, "surface_locked")) {
    return intent;
  }
  const destSurface = destinationSurface(intent, ctx);
  if (destSurface === null) return intent;
  if (destSurface === sourceRow.macroZone.surface) return intent;
  return {
    kind: "rejected",
    reason: `surface_locked source (surface=${sourceRow.macroZone.surface}) cannot move to surface=${destSurface}`,
  };
}

/**
 * Execute a resolved + gated intent. Two phases:
 *
 *  1. **Local write** via `CardManager.setCardPosition` / `stack`.
 *     `stack` is used only for rect-on-rect (it walks the chain and
 *     re-stacks A's descendants); hex mounts and all other intents
 *     go through `setCardPosition` directly. The local overlay
 *     reflects the move immediately; the server reply below
 *     reconciles when it lands.
 *  2. **Server sync via `placeCard`** for every non-loose intent.
 *     One generic reducer handles equip / unequip / re-equip /
 *     branch transitions / generic stacking — see
 *     `docs/PLACE_CARD_GENERALIZATION.md`. `loose` skips the server
 *     call because the source's stored position doesn't change for
 *     a same-surface loose placement (purely a visual nudge).
 */
export function executeDrop(c: DropContext, intent: DropIntent): void {
  if (intent.kind === "rejected") return;

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
        surface: intent.surface,
        owner: intent.owner,
        offsetX: intent.offsetX,
        offsetY: intent.offsetY,
      });
      break;
    case "loose":
      c.card.setPosition({ kind: "loose", x: intent.x, y: intent.y });
      break;
    case "inventory":
      c.ctx.cards?.setCardPosition(c.card.cardId, {
        kind: "inventory",
        soulCardId: intent.soulCardId,
        x: intent.x,
        y: intent.y,
        surface: intent.surface,
      });
      break;
  }

  firePlaceCard(c, intent);
}

// ============================================================
// Internal helpers
// ============================================================

/** Resolve the cursor's hit-target into a stacking intent, or null when
 *  the target isn't usable as a stack destination. Returns `rejected`
 *  when the target is blocked by `drop_hold` / `drop_locked`. */
function intentForCardTarget(c: DropContext, target: Card): DropIntent | null {
  if (targetBlocksDrop(c, target)) {
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
 *  → inventory return when a soul context can be derived, otherwise
 *  loose in the source's current zone. The soul is derived from the
 *  source card's chain root (so dropping a card you grabbed off
 *  soul B's chain returns it to B's inventory) — if the source has
 *  no owning soul (truly free world card never chained), falls back
 *  to the locally-active soul. Surface-locked sources still flow
 *  through the inventory branch here; `applySourceGate` converts to
 *  `rejected` downstream. */
function resolveFallback(c: DropContext): DropIntent {
  if (c.sourceRow.macroZone.surface >= WORLD_LAYER) {
    const ownedSoul = owningSoul(c.ctx, c.card.cardId);
    const soulId = ownedSoul?.soulCardId ?? c.ctx.souls.getSoulId() ?? 0;
    if (soulId !== 0) {
      const inv = c.ctx.layout?.surfaceFor(makeMacroZone(soulId, INVENTORY_LAYER, 0, 0).packed);
      if (inv) {
        const ig = inv.container.getGlobalPosition();
        return {
          kind: "inventory",
          soulCardId: soulId,
          surface: INVENTORY_LAYER,
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
  // Only accept loose-in-own-zone when the cursor actually landed
  // on a valid drop target — a `LayoutInventory`, `LayoutWorld`, or
  // `LayoutCard`. Dropping on the blueprints / details panels would
  // otherwise produce a loose position relative to the source
  // inventory that sits visually outside the panel; reject instead
  // so the card snap-backs to its original spot.
  if (!isDroppableHit(c.up.hit)) {
    return {
      kind: "rejected",
      reason: "drop landed outside any inventory / world / card target",
    };
  }
  const sg = surface.container.getGlobalPosition();
  return {
    kind: "loose",
    x: c.up.x - sg.x - c.offsetX,
    y: c.up.y - sg.y - c.offsetY,
  };
}

/** Walk `hit`'s LayoutNode parent chain. Returns true if any ancestor
 *  (inclusive) is a `LayoutWorld` (world OR inventory viewport) or a
 *  `LayoutCard` — the node types the drop resolver treats as legitimate
 *  drop targets. Used to reject drops that land on chrome panels
 *  (blueprints, details). */
function isDroppableHit(hit: LayoutNode | null): boolean {
  let n: LayoutNode | null = hit;
  while (n) {
    if (n instanceof LayoutWorld) return true;
    if (n instanceof LayoutCard) return true;
    n = n.parent;
  }
  return false;
}

/** Convert intent → destination `surface` for the source-side gate.
 *  Returns null for intent kinds whose surface either doesn't change
 *  (`loose`) or is already filtered out (`rejected`). */
function destinationSurface(intent: DropIntent, ctx: GameContext): number | null {
  switch (intent.kind) {
    case "stack": {
      const targetRow = ctx.data.cardsLocal.get(intent.target.cardId);
      return targetRow?.macroZone.surface ?? null;
    }
    case "world":
      return intent.surface;
    case "inventory":
      return intent.surface;
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
  if (row && ctx.definitions.hasCardFlag(row.flagsState, row.flagsBk, "dead")) return null;
  return ctx.cards?.get(hit.cardId) ?? null;
}

/** True if the target's state blocks incoming drops:
 *  - `dead`: row was consumed by a recipe (`action_completion::commit`
 *    flipped the bit). The card is on its way to GC; stacking onto
 *    it would write into a doomed chain and surprise the player when
 *    the row vanishes. Reject so the drop falls through to the
 *    resolver's fallback (loose / inventory return).
 *  - `drop_hold_count > 0`: server-side block. Subsumes the
 *    pre-rework `drop_hold` (transient) + `drop_locked` (permanent)
 *    bits — both folded into the count via the lock-via-`+1`-forever
 *    idiom. See `docs/UNIFIED_HOLD_COUNTS.md`.
 *  - `DragHoldStore.has(target)`: client-side "I'm currently mid-drag
 *    on this card" sidecar. The server has no concept of drags, so
 *    this lives off-row. */
function targetBlocksDrop(c: DropContext, target: Card): boolean {
  const row = c.ctx.data.cardsLocal.get(target.cardId);
  if (!row) return false;
  if (c.ctx.definitions.hasCardFlag(row.flagsState, row.flagsBk, "dead")) return true;
  const dropHoldCount = c.ctx.definitions.cardFlagFieldValueIn(
    "cards_bk",
    row.flagsBk,
    "drop_hold_count",
  ) ?? 0;
  if (dropHoldCount > 0) return true;
  if (c.dragHoldStore?.has(target.cardId)) return true;
  return false;
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

/** Compute the hex `(q, r)` + surface under the cursor, or `null`
 *  when the drop isn't inside any hex-grid view. Two signals:
 *
 *  - Explicit hit on a `LayoutWorld` (empty grid area). With
 *    multiple game-view panels open (e.g. the overworld view + a
 *    mini-zone view), we use the SPECIFIC LayoutWorld the cursor
 *    landed on — not the singleton `ctx.layout.worldView`. That
 *    pointer is last-write-wins and may not match the panel the
 *    user is hovering.
 *  - Hit on a Card whose row sits on a hex-grid surface (a card
 *    occluded the tile). Walk up the card's LayoutNode ancestors
 *    to find the LayoutWorld it lives under so we get the right
 *    surface + coord frame. */
function resolveWorldDropCoords(
  c: DropContext,
): { q: number; r: number; surface: number; owner: number; offsetX: number; offsetY: number } | null {
  // A drop into ANY viewport resolves to that viewport's `(owner, surface)` +
  // the cell under the cursor — grid shape is irrelevant (a hex inventory
  // owned by a soul behaves like the world owned by 0). The world is the
  // owner-0, multi-chunk case; an inventory / mini-zone is a single-chunk
  // bucket, so clamp its cell into chunk (0,0).
  const view = findLayoutWorldInChain(c.up.hit);
  if (!view) return null;
  const g = view.container.getGlobalPosition();
  const localX = c.up.x - g.x;
  const localY = c.up.y - g.y;
  let { q, r } = view.localToWorld(localX, localY);
  if (view.singleChunk) {
    q = Math.max(0, Math.min(7, q));
    r = Math.max(0, Math.min(7, r));
  }
  // Within-cell offset for arbitrary placement. Preserve the drag's visual
  // continuity: during drag the card top-left tracks `cursor - grabPoint`
  // (where `(c.offsetX, c.offsetY)` is the cursor→card-top-left offset at
  // drag start), so the card's *centre* is at `cursor - grab + halfCard`.
  // We want the card to land where the user released it — its centre at the
  // same position — which means the offset from the cell centre is:
  //     offset = (cursor − grab + halfCard) − cellCentre
  // Without the grab term, the card snaps so its centre lands under the
  // cursor regardless of where on the card you grabbed it (visual jump).
  // Zero when `forceSnap` is on; clamped to i12 (the `micro_location.x/y`
  // storage width — world hexes are ~96px radius, well within the limit).
  let offsetX = 0;
  let offsetY = 0;
  if (!view.forceSnap) {
    const cellCenter = view.worldToLocal(q, r);
    const halfW = c.card.layoutCard.width / 2;
    const halfH = c.card.layoutCard.height / 2;
    offsetX = clampI12(Math.round(localX - c.offsetX + halfW - cellCenter.x));
    offsetY = clampI12(Math.round(localY - c.offsetY + halfH - cellCenter.y));
  }
  debug.log(
    ["drag"],
    `[drop] viewport hit → owner=${view.owner} surface=${view.surface} (q=${q}, r=${r}) offset=(${offsetX}, ${offsetY})`,
    3,
  );
  return { q, r, surface: view.surface, owner: view.owner, offsetX, offsetY };
}

function clampI12(v: number): number {
  return Math.max(-2048, Math.min(2047, v));
}

/** Walk a hit node's LayoutNode parent chain looking for a
 *  `LayoutWorld`. Returns it (with its `surface`) or `null`. Used
 *  by `resolveWorldDropCoords` so the resolver targets the actual
 *  panel the cursor is over rather than the last-written singleton. */
function findLayoutWorldInChain(hit: LayoutNode | null): LayoutWorld | null {
  let n: LayoutNode | null = hit;
  while (n) {
    if (n instanceof LayoutWorld) return n;
    n = n.parent;
  }
  return null;
}

/** Search `cardsLocal` for the card occupying hex tile `(q, r)` on
 *  `surface`. Prefers a rect occupant (the rect is the chain root
 *  for further state-1 chain members) over a hex occupant.
 *  `excludeId` excludes the dragged card itself. `surface` is the
 *  layer the LayoutWorld under the cursor renders — `WORLD_LAYER`
 *  for the overworld, `MINI_ZONE_LAYER` for a deployed mini-zone. */
function findCardAtTile(
  ctx: GameContext,
  q: number,
  r: number,
  surface: number,
  owner: number,
  excludeId: number,
): Card | null {
  const cards = ctx.cards;
  if (!cards) return null;
  const zoneQ = Math.floor(q / ZONE_SIZE) * ZONE_SIZE;
  const zoneR = Math.floor(r / ZONE_SIZE) * ZONE_SIZE;
  const localQ = q - zoneQ;
  const localR = r - zoneR;
  // Full packed zone key for the viewport — owner band from the viewport (0 for
  // world, the soul/anchor card_id for an inventory / mini-zone). Matches the
  // `macroZone.packed` on rows in that zone exactly.
  const targetMacroZone = makeMacroZone(owner, surface, zoneQ, zoneR).packed;

  let hexCard: Card | null = null;
  let rectCard: Card | null = null;
  for (const [id, row] of ctx.data.cardsLocal) {
    if (id === excludeId) continue;
    if (row.macroZone.surface !== surface) continue;
    if (row.macroZone.packed !== targetMacroZone) continue;
    // Skip dead cards — `action_completion` flips `dead` at recipe
    // completion (e.g. `cut_tree` on the actor faculty) but the row
    // sits in `cardsLocal` until GC retention runs. Letting the
    // resolver pick it up would let the player stack onto a doomed
    // chain. Same reasoning as `targetBlocksDrop`.
    if (ctx.definitions.hasCardFlag(row.flagsState, row.flagsBk, "dead")) continue;
    // A loose card on a grid surface carries its cell in `microLocation`.
    const { localQ: otherLocalQ, localR: otherLocalR } = microLooseCell(row.microLocation);
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

/** `Placement.kind` discriminator constants. Mirror the server-side
 *  `place.rs` values. */
const PLACEMENT_STACK = 0;
const PLACEMENT_LOOSE = 1;

/** Server-side `STACK_DIR_*` values. Mirror `content/src/packed.rs`'s
 *  `STACK_DIR_HEX = 0 / UP = 1 / DOWN = 2`. The client's
 *  `STACK_DIRECTION_*` constants from `cardData.ts` share these
 *  numerics; we redeclare here so the placement construction reads
 *  the same way on both sides without an extra import. */
const STACK_DIR_HEX = 0;
const STACK_DIR_UP = 1;
const STACK_DIR_DOWN = 2;

/** Fire `placeCard` for the resolved intent — but ONLY for drops
 *  that change the card's bucket address. The design intent is
 *  that the server hears about *state changes*, not every visual
 *  nudge:
 *
 *  - `stack` → always fires. Chain restructuring is a real state
 *    change (equipment-onto-soul is the canonical example; the
 *    server needs to track the chain root + position).
 *  - `world` → fires only when `surface` differs from the source's.
 *    Same-surface drag-on-world produces a new `(q, r)`, but the
 *    bucket address (surface + macro_zone post-chunking) is the
 *    same; we keep that local.
 *  - `inventory` → fires only when `(surface, macro_zone)` differ
 *    from the source's. Same-bucket inventory drops are already
 *    short-circuited inside `resolveInventoryDropTarget`, but the
 *    gate here is belt-and-suspenders.
 *  - `loose` / `rejected` → never fire (no bucket change).
 *
 *  Pure-visual nudges (drag-around-the-same-inventory, drag-
 *  around-the-same-world-tile, etc.) stay local. The `cardsLocal`
 *  overlay carries them within the session; a refresh resets to
 *  the last server-known position, which is the explicit trade-off
 *  for this scope.
 *
 *  See `docs/PLACE_CARD_GENERALIZATION.md` and
 *  [place.rs](../../../../spacetime/server/modules/shard/src/place.rs).
 */
function firePlaceCard(c: DropContext, intent: DropIntent): void {
  if (!shouldSyncPlacement(c, intent)) return;
  const placement = buildPlacement(c, intent);
  if (placement === null) return;
  void c.ctx.reducers.placeCard({
    cardId: c.card.cardId,
    placement,
  });
}

/** Bucket-change gate — see the doc-comment on `firePlaceCard` for
 *  the semantics. Pulled out so the rule is easy to find when
 *  someone audits "why didn't this drop sync?" */
function shouldSyncPlacement(c: DropContext, intent: DropIntent): boolean {
  switch (intent.kind) {
    case "stack":
      return true;
    case "world":
      // Bucket change = surface OR owner differs from the source. Same-bucket
      // (e.g. in-inventory or in-world-tile nudge) stays local.
      return (
        intent.surface !== c.sourceRow.macroZone.surface ||
        intent.owner !== c.sourceRow.macroZone.owner
      );
    case "inventory":
      return (
        intent.surface !== c.sourceRow.macroZone.surface ||
        intent.soulCardId !== c.sourceRow.macroZone.owner
      );
    case "loose":
    case "rejected":
      return false;
  }
}

/** Map a resolved `DropIntent` to a `Placement` for the server.
 *  Returns `null` for intents that don't sync (`loose`, `rejected`)
 *  or that can't be expressed (`inventory` without a resolvable
 *  soul target). */
function buildPlacement(
  c: DropContext,
  intent: DropIntent,
): {
  kind: number;
  parentId: number;
  direction: number;
  surface: number;
  macroZone: bigint;
  q: number;
  r: number;
  xy: number;
} | null {
  switch (intent.kind) {
    case "stack": {
      const direction =
        intent.direction === "top"  ? STACK_DIR_UP   :
        intent.direction === "bottom" ? STACK_DIR_DOWN :
        STACK_DIR_HEX;
      return {
        kind: PLACEMENT_STACK,
        parentId: intent.target.cardId,
        direction,
        surface: 0,
        macroZone: 0n,
        q: 0,
        r: 0,
        xy: 0,
      };
    }
    case "world": {
      // Convert (q, r) → (macroZone, localQ, localR). Same 8×8-chunk math for
      // any viewport; the owner band comes from the viewport (0 = world, a
      // soul/anchor card_id for an inventory / mini-zone bucket).
      const zoneQ = Math.floor(intent.q / ZONE_SIZE) * ZONE_SIZE;
      const zoneR = Math.floor(intent.r / ZONE_SIZE) * ZONE_SIZE;
      const localQ = intent.q - zoneQ;
      const localR = intent.r - zoneR;
      // Pack the within-cell offset into the wire `xy` u32 (same shape the
      // inventory arm uses): high u16 = x, low u16 = y. Zero when the source
      // viewport's `forceSnap` was on (resolver left offsets undefined).
      const ox = intent.offsetX ?? 0;
      const oy = intent.offsetY ?? 0;
      const clampedX = Math.max(I16_MIN, Math.min(I16_MAX, ox));
      const clampedY = Math.max(I16_MIN, Math.min(I16_MAX, oy));
      const xy = ((clampedX & 0xffff) << 16) | (clampedY & 0xffff);
      return {
        kind: PLACEMENT_LOOSE,
        parentId: 0,
        direction: 0,
        surface: intent.surface,
        macroZone: makeMacroZone(intent.owner, intent.surface, zoneQ, zoneR).packed,
        q: localQ,
        r: localR,
        xy,
      };
    }
    case "inventory": {
      // For soul-inventory intents derived from a fallback (where
      // `soulCardId` wasn't set by an explicit panel hit), confirm
      // the source has a resolvable owning soul. For explicit
      // panel hits (`resolveInventoryDropTarget`) the soulCardId
      // already names the bucket and the inferTargetSoul gate is
      // a no-op overhead — skip it on the player-inventory layer
      // where the bucket is the player_id (a non-soul value).
      if (intent.surface === INVENTORY_LAYER) {
        const soulId = inferTargetSoul(c);
        if (soulId === null) return null;
      }
      const clampedX = Math.max(I16_MIN, Math.min(I16_MAX, intent.x));
      const clampedY = Math.max(I16_MIN, Math.min(I16_MAX, intent.y));
      // micro_location packs (x, y) into u32: high u16 = x, low u16 = y.
      const xy = ((clampedX & 0xffff) << 16) | (clampedY & 0xffff);
      return {
        kind: PLACEMENT_LOOSE,
        parentId: 0,
        direction: 0,
        surface: intent.surface,
        // Bucket id lives in the owner band; server reads it via `owner_of`.
        macroZone: makeMacroZone(intent.soulCardId, intent.surface, 0, 0).packed,
        q: 0,
        r: 0,
        xy,
      };
    }
    case "loose":
    case "rejected":
      return null;
  }
}

/** Find the soul to target for an `inventory` intent. Prefers the
 *  source's existing owning soul (so dragging a card off a soul S
 *  drops it back into S's inventory, regardless of which soul the
 *  player is "actively" playing). Falls back to the active soul
 *  when the source has no owning soul (e.g. a world-loose card
 *  being picked up).
 *
 *  Walks `ownerId` (via `owningSoul`), not chain root: ownership is
 *  independent of chain shape post unified-card model. A card S owns
 *  via `ownerId` can be temporarily chained under a world-tile root
 *  (chain_stitch makes the hex tile root, the soul-owned rect a
 *  child), and `rootOf` would surface the world tile — which has no
 *  `FLAG_OWNED_BY_PLAYER` and would defeat the "drop returns to
 *  source soul" intent. */
function inferTargetSoul(c: DropContext): number | null {
  const owned = owningSoul(c.ctx, c.card.cardId);
  if (owned !== null) return owned.soulCardId;
  // Fall back to the active soul. `playerSession.getPlayer` carries
  // the player_id; the active soul card is the one with
  // FLAG_OWNED_BY_PLAYER whose owner_id matches.
  const player = c.ctx.playerSession.getPlayer();
  if (!player) return null;
  for (const row of c.ctx.data.cardsLocal.values()) {
    if ((row.flagsState & FLAG_OWNED_BY_PLAYER) === 0) continue;
    if (row.ownerId !== player.playerId) continue;
    return row.cardId;
  }
  return null;
}
