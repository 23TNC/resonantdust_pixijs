import type { GameContext } from "../../GameContext";

/** Maximum aspect-tree depth to walk when checking sub-aspect
 *  ancestry — mirrors the server's `is_aspect_descendant` walk cap
 *  in `definition_core.rs`. Aspect trees are <= 4 deep in practice;
 *  16 is a defensive ceiling. */
const ASPECT_WALK_DEPTH_CAP = 16;

/**
 * Blueprint-slot snapshot: `active` placed-but-unresolved blueprint
 * cards vs the cap `max`. `available = max - active` (floored at 0).
 *
 * Two parallel shapes — one per scope:
 *
 * - **Soul scope** (`getSoulBlueprintCapacity`): cap derived from the
 *   soul's `aspects.builder` value, count from
 *   `SoulPrivate.active_blueprints`. Mirrors the server's
 *   `blueprints::request_blueprint` gate.
 * - **Player scope** (`getPlayerBlueprintCapacity`): cap + count
 *   packed into `PlayerProfile.blueprint_info` (max in low nibble,
 *   count in high nibble — see `pack_nibbles`). Mirrors the server's
 *   `blueprints::request_player_blueprint` gate.
 */
export interface BlueprintCapacity {
  active: number;
  max: number;
  available: number;
}

/** Soul-scope variant. See [BlueprintCapacity] for shape.
 *
 *  Returns `{ active: 0, max: 0, available: 0 }` if the soul row
 *  isn't in `cardsLocal` yet — the request would fail server-side
 *  too, so the empty cap is a safe placeholder. */
export function getSoulBlueprintCapacity(
  ctx: GameContext,
  soulCardId: number,
): BlueprintCapacity {
  const soulCard = ctx.data.cardsLocal.get(soulCardId);
  if (!soulCard) return { active: 0, max: 0, available: 0 };
  const def = ctx.definitions.decode(soulCard.packedDefinition);
  if (!def) return { active: 0, max: 0, available: 0 };

  const builderId = ctx.definitions.aspectIdByName("builder");
  if (builderId === null) return { active: 0, max: 0, available: 0 };

  // Sub-aspect widening: a soul carrying `aspects.builder = 1`
  // matches; so would a `aspects.crafting = 2` if a `builder`
  // child gets added. Negative values clamped to 0 — content
  // shouldn't produce them, but the cap mustn't underflow.
  let max = 0;
  for (const [aspectId, value] of def.aspects) {
    if (isDescendantOfBuilder(ctx, aspectId, builderId)) {
      max += value;
    }
  }
  if (max < 0) max = 0;

  const privateRow = ctx.data.soulPrivatesLocal.get(soulCardId);
  const active = privateRow?.activeBlueprints ?? 0;
  return {
    active,
    max,
    available: Math.max(0, max - active),
  };
}

/** Player-scope variant — reads the packed `blueprint_info` byte off
 *  the local `PlayerProfile` mirror. Returns the empty placeholder
 *  if the profile row hasn't arrived yet (subscription installs at
 *  login; the row is delivered on first promote). */
export function getPlayerBlueprintCapacity(
  ctx: GameContext,
  playerId: number,
): BlueprintCapacity {
  const profile = ctx.data.playerProfilesLocal.get(playerId);
  if (!profile) return { active: 0, max: 0, available: 0 };
  const packed = profile.blueprintInfo;
  // `[count: u4 | max: u4]` — count in high nibble, max in low.
  // Matches `content/src/packed.rs::pack_nibbles`.
  const active = (packed >> 4) & 0xf;
  const max = packed & 0xf;
  return {
    active,
    max,
    available: Math.max(0, max - active),
  };
}

/** True iff `aspectId` is `builderId` or a descendant in the
 *  aspect tree. Walks parents via `aspectInfo(id).parent`. Mirrors
 *  the server's `is_aspect_descendant` walk; bounded by
 *  `ASPECT_WALK_DEPTH_CAP`. */
function isDescendantOfBuilder(
  ctx: GameContext,
  aspectId: number,
  builderId: number,
): boolean {
  if (aspectId === 0 || builderId === 0) return false;
  let current: number | null = aspectId;
  for (let i = 0; i < ASPECT_WALK_DEPTH_CAP && current !== null; i++) {
    if (current === builderId) return true;
    const info = ctx.definitions.aspectInfo(current);
    current = info?.parent ?? null;
  }
  return false;
}
