/** Client-side hex-grid A*. Ports the server's
 *  `movement::pathfind` verbatim so client-computed paths line up
 *  with the server's `move_soul_path` validator by construction
 *  (same algorithm, same step-cost formula, same heuristic, same
 *  node cap).
 *
 *  Reads tile data from `data.zonesLocal` via `getZoneTileDef` and
 *  resolves per-tile `cost` traits via `DefinitionManager.traitValue`.
 *  Boundedly fails when the goal is in a zone the client hasn't
 *  subscribed to — surface that as "pan first, then try again" UX.
 *
 *  Companion: `pixijs/src/server/spacetime/bindings/shard/move_soul_path_reducer.ts`
 *  (generated). Server validator: [movement.rs `move_soul_path`](../../../../spacetime/server/modules/shard/src/movement.rs).
 */
import type { Zone } from "../../server/spacetime/bindings/types";
import type { DefinitionManager } from "../definitions/DefinitionManager";
import { packMacroZone, packMicroZone, unpackMacroZone, unpackMicroZone } from "../../server/data/packing";
import { STACKED_LOOSE } from "../cards/cardData";
import { ZONE_SIZE, getZoneTileDef } from "./worldCoords";

/** Default soul speed when the soul's def carries no `speed` trait.
 *  Mirrors `DEFAULT_SOUL_SPEED` in `movement.rs`. */
const DEFAULT_SOUL_SPEED = 10;

/** Fallback when a tile def carries no `cost` trait. Mirrors
 *  `DEFAULT_TILE_COST` in `movement.rs`. */
const DEFAULT_TILE_COST = 10;

/** Cap on A* node expansions. Mirrors `MAX_PATH_NODES` in
 *  `movement.rs`. */
const MAX_PATH_NODES = 1000;

/** Axial-hex neighbour offsets. Mirrors `HEX_DIRS` in `movement.rs`. */
const HEX_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, -1],
  [-1, 1],
];

/** Global axial-hex coord. `q = macroQ * 8 + localQ`, same for `r`. */
export interface Coord {
  q: number;
  r: number;
}

/** One step on the wire to `move_soul_path`. Matches the
 *  `TilePoint` SpacetimeType on the server. */
export interface TilePoint {
  surface: number;
  macroZone: number;
  microZone: number;
}

/** A* / step-cost helpers, exposed for unit tests. */
export function hexDistance(a: Coord, b: Coord): number {
  return (
    (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2
  );
}

/** Same formula as `step_cost` in `movement.rs`:
 *  `(from/2 + to/2) / speed`. Uniform cost-10 terrain at speed 10
 *  = 1 sec/hex. */
export function stepCost(speed: number, from: number, to: number): number {
  return (0.5 * (from + to)) / speed;
}

/** Resolve a soul's `speed` trait, falling back to
 *  `DEFAULT_SOUL_SPEED`. */
export function soulSpeed(
  defs: DefinitionManager,
  packedDef: number,
): number {
  const v = defs.aspectValue(packedDef, "speed");
  return v ?? DEFAULT_SOUL_SPEED;
}

/** Resolve a tile def's `cost` trait. Returns `null` for impassable
 *  tiles (the server's `tile_cost` returns `None` for `def_id == 0`
 *  and unresolvable defs; this mirrors that). */
function tileCostFromPacked(
  defs: DefinitionManager,
  packedDef: number,
): number | null {
  if (packedDef === 0) return null;
  // Same `traitValue` lookup the server uses via `def.trait_value`.
  // Missing trait → fall back to DEFAULT_TILE_COST, matching the
  // server's `unwrap_or(DEFAULT_TILE_COST)` in `tile_cost`.
  const v = defs.aspectValue(packedDef, "cost");
  return v ?? DEFAULT_TILE_COST;
}

/** Look up the tile def_id at a global coord on `surface`. Mirrors
 *  `tile_def_at` in `movement.rs` — but only consults `zonesLocal`
 *  (world tier; no mini_zone overlay support yet — see
 *  [MOVEMENT_REWRITE.md](../../../../docs/MOVEMENT_REWRITE.md) "Out
 *  of scope"). Returns `0` (impassable) for tiles in unsubscribed
 *  zones. */
function tileDefAt(
  zonesLocal: ReadonlyMap<number, Zone>,
  surface: number,
  coord: Coord,
): number {
  const macroQ = Math.floor(coord.q / ZONE_SIZE);
  const macroR = Math.floor(coord.r / ZONE_SIZE);
  const localQ = ((coord.q % ZONE_SIZE) + ZONE_SIZE) % ZONE_SIZE;
  const localR = ((coord.r % ZONE_SIZE) + ZONE_SIZE) % ZONE_SIZE;
  const macroZone = packMacroZone(macroQ * ZONE_SIZE, macroR * ZONE_SIZE);
  // `getZoneTileDef` doesn't filter by surface; gate that here so a
  // hypothetical inventory-surface zone with the same macroZone
  // doesn't shadow the world tile.
  for (const zone of zonesLocal.values()) {
    if (zone.macroZone !== macroZone) continue;
    if (zone.surface !== surface) continue;
    return getZoneTileDef(zonesLocal, macroZone, localQ, localR);
  }
  return 0;
}

/** Encode a global coord back into a `TilePoint` on the given surface.
 *  `microZone` packs state=Free; the server's `move_soul` validator
 *  checks `state == Free` per step. State 3 is now `STACKED_DEFERRED`
 *  (anchored deferred placement, emitted by recipe outputs); using it
 *  for a pathfind target would mis-signal "resolve at mirror time"
 *  to the placement layer. */
function coordToTilePoint(coord: Coord, surface: number): TilePoint {
  const macroQ = Math.floor(coord.q / ZONE_SIZE);
  const macroR = Math.floor(coord.r / ZONE_SIZE);
  const localQ = ((coord.q % ZONE_SIZE) + ZONE_SIZE) % ZONE_SIZE;
  const localR = ((coord.r % ZONE_SIZE) + ZONE_SIZE) % ZONE_SIZE;
  return {
    surface,
    macroZone: packMacroZone(macroQ * ZONE_SIZE, macroR * ZONE_SIZE),
    microZone: packMicroZone(localQ, localR, STACKED_LOOSE),
  };
}

/** Decode a `Card`-shaped tile address (`surface, macro_zone,
 *  micro_zone`) into a global `Coord`. The caller already trusts
 *  that `micro_zone` carries an `OnHex` state — soul rows always do
 *  in the world layer. */
export function coordFromTileAddress(
  surface: number,
  macroZone: number,
  microZone: number,
): Coord {
  const { zoneQ, zoneR } = unpackMacroZone(macroZone);
  const { localQ, localR } = unpackMicroZone(microZone);
  void surface;
  return {
    q: zoneQ + localQ,
    r: zoneR + localR,
  };
}

/** Result of [`findPath`]. `null` when no path exists within the
 *  node-expansion cap, OR when the goal is in an unsubscribed
 *  zone (its tile def reads back as `0`). */
export type PathResult = { path: TilePoint[] } | null;

/** A* between two world-hex coords on a single surface. Returns the
 *  path EXCLUDING the starting tile (the soul is already there) and
 *  INCLUDING the goal — matches the wire shape `move_soul_path`
 *  expects.
 *
 *  Reads tile data from `zonesLocal` and resolves tile costs via
 *  `defs`. Stops after `MAX_PATH_NODES` expansions — same cap the
 *  server's A* used to use; defends against pathological searches
 *  (target across an unreachable chasm, off-map goal).
 *
 *  Use [`findPathForSoul`] for the common case where the caller has
 *  a soul row + a target tile address.
 */
export function findPath(
  zonesLocal: ReadonlyMap<number, Zone>,
  defs: DefinitionManager,
  surface: number,
  start: Coord,
  goal: Coord,
  speed: number,
): PathResult {
  if (start.q === goal.q && start.r === goal.r) {
    return { path: [] };
  }
  // Heuristic scaling: minimum possible per-step cost on this surface
  // is `step_cost(speed, DEFAULT_TILE_COST, DEFAULT_TILE_COST)`. The
  // heuristic `hex_distance * h_scale` stays admissible provided no
  // tile costs less than `DEFAULT_TILE_COST`. Same admissibility
  // contract the server's A* relies on.
  const hScale = stepCost(speed, DEFAULT_TILE_COST, DEFAULT_TILE_COST);

  const cameFrom = new Map<string, Coord>();
  const gScore = new Map<string, number>();
  const key = (c: Coord): string => `${c.q},${c.r}`;
  gScore.set(key(start), 0);

  // Min-heap-by-f-score. Native JS has no heap; for the typical
  // path lengths (<100 nodes) a sorted-insert + shift is acceptable.
  // If profiles ever flag this, swap in a binary heap.
  const open: { f: number; c: Coord }[] = [{ f: 0, c: start }];

  let expanded = 0;
  while (open.length > 0) {
    // Pop the lowest-f node. `shift` is O(N); for small N it's
    // faster than maintaining a real heap thanks to cache effects.
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i]!.f < open[bestIdx]!.f) bestIdx = i;
    }
    const node = open.splice(bestIdx, 1)[0]!;
    const current = node.c;
    if (current.q === goal.q && current.r === goal.r) {
      // Reconstruct path, then drop the starting tile (soul is
      // already there — the wire format excludes it).
      const rev: Coord[] = [current];
      let cur = current;
      while (true) {
        const prev = cameFrom.get(key(cur));
        if (!prev) break;
        rev.push(prev);
        cur = prev;
      }
      rev.reverse();
      const result = rev
        .slice(1) // drop start
        .map((c) => coordToTilePoint(c, surface));
      return { path: result };
    }
    expanded++;
    if (expanded > MAX_PATH_NODES) return null;

    const currentG = gScore.get(key(current)) ?? Infinity;
    const currDef = tileDefAt(zonesLocal, surface, current);
    const currCost = tileCostFromPacked(defs, currDef);
    if (currCost === null) continue;

    for (const [dq, dr] of HEX_DIRS) {
      const neighbour: Coord = { q: current.q + dq, r: current.r + dr };
      const neighDef = tileDefAt(zonesLocal, surface, neighbour);
      const neighCost = tileCostFromPacked(defs, neighDef);
      if (neighCost === null) continue;
      const tentative = currentG + stepCost(speed, currCost, neighCost);
      const nKey = key(neighbour);
      const existing = gScore.get(nKey) ?? Infinity;
      if (tentative < existing) {
        cameFrom.set(nKey, current);
        gScore.set(nKey, tentative);
        const f = tentative + hexDistance(neighbour, goal) * hScale;
        open.push({ f, c: neighbour });
      }
    }
  }
  return null;
}

/** Convenience: pathfind from a soul-shaped row to a target tile
 *  address on the same surface. Wraps [`findPath`] with the
 *  coord-decode + speed-resolve glue every caller needs.
 *
 *  Returns `null` if the surfaces differ (cross-surface moves
 *  aren't supported) or if A* fails. */
export function findPathForSoul(
  zonesLocal: ReadonlyMap<number, Zone>,
  defs: DefinitionManager,
  soul: {
    packedDefinition: number;
    surface: number;
    macroZone: number;
    microZone: number;
  },
  target: { surface: number; macroZone: number; microZone: number },
): PathResult {
  if (soul.surface !== target.surface) return null;
  const start = coordFromTileAddress(
    soul.surface,
    soul.macroZone,
    soul.microZone,
  );
  const goal = coordFromTileAddress(
    target.surface,
    target.macroZone,
    target.microZone,
  );
  const speed = soulSpeed(defs, soul.packedDefinition);
  return findPath(zonesLocal, defs, soul.surface, start, goal, speed);
}
