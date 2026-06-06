import type { CardDefinition, DefinitionManager } from "../definitions/DefinitionManager";
import { STACK_DIR_DOWN, STACK_DIR_HEX, STACK_DIR_UP } from "./cardData";

/**
 * Generalized stacking eligibility — two bit-fields over stack indices
 * (bit i = stack i: 0 hex/under-root, 1 top, 2 bottom). This is the sole
 * stacking-legality mechanism; the old per-shape gating it replaced is gone.
 *
 *   stack_hosts — stacks this card SOURCES as a root (slots others attach to)
 *   stack_joins — stacks this card can OCCUPY as a member
 *
 * Drop `a` onto `b`: try `a` joins `b` (`b.hosts & a.joins`), else `b` joins `a`
 * (`a.hosts & b.joins`). Leftmost stack wins (hex 0 preferred when free), with
 * the cursor's Y half breaking a top/bottom tie. Stack 0 is capacity-1 (one
 * tile/hex under a root); 1 and 2 grow. The root is always the host side — the
 * source from which all branches originate.
 *
 * Aspects live in content (`content/data/aspect/01.rd`, section `traits`); tiles
 * and events set `stack_joins = {0}`. Cards that declare neither aspect take the
 * regular-card default below.
 */
export interface StackBits {
  hosts: number;
  joins: number;
}

/** Regular card: hosts the hex slot + top + bottom, joins top/bottom. */
const DEFAULT_BITS: StackBits = { hosts: 0b111, joins: 0b110 };

const bit = (stack: number): number => 1 << stack;

function aspectValue(def: CardDefinition, id: number | null): number | undefined {
  if (id === null) return undefined;
  for (const [aid, val] of def.aspects) if (aid === id) return val;
  return undefined;
}

/** Read a card's stacking bit-fields from its definition. `stack_joins` present
 *  marks an explicit config (tiles/events, `{0}`); absent → regular default.
 *  `stack_hosts` defaults to 0 when only joins is set (a tile hosts nothing). */
export function stackBits(defs: DefinitionManager, def: CardDefinition): StackBits {
  const joins = aspectValue(def, defs.aspectIdByName("stack_joins"));
  if (joins === undefined) return DEFAULT_BITS;
  return { hosts: aspectValue(def, defs.aspectIdByName("stack_hosts")) ?? 0, joins };
}

/** Stack a `joiner` occupies on a `host`, or null if none. Every stack grows
 *  (a root may hold many stack-0 members — e.g. several tiles — up to chain
 *  depth, enforced by the caller). Leftmost wins (hex 0 first); `dropDir`
 *  (UP/DOWN) breaks a top+bottom tie from the cursor. */
export function matchStack(host: StackBits, joiner: StackBits, dropDir: number): number | null {
  const m = host.hosts & joiner.joins;
  if (m === 0) return null;
  if (m & bit(STACK_DIR_HEX)) return STACK_DIR_HEX;
  const up = m & bit(STACK_DIR_UP);
  const down = m & bit(STACK_DIR_DOWN);
  if (up && down) return dropDir === STACK_DIR_DOWN ? STACK_DIR_DOWN : STACK_DIR_UP;
  if (up) return STACK_DIR_UP;
  if (down) return STACK_DIR_DOWN;
  return null;
}

export interface StackResolution {
  /** true → the dragged card joins the target (target is root): the normal
   *  card-onto-card stack. false → the target joins the dragged card (dragged
   *  is root, target absorbed into its stack): the card-onto-tile case, where
   *  the tile is pushed into the dragged card's stack 0. */
  draggedIsMember: boolean;
  /** Stack index the member occupies on the root (STACK_DIR_*). */
  stack: number;
}

/** Bidirectional resolve for dropping `dragged` onto `target`. Forward first
 *  (dragged joins target), then reverse (target joins dragged). Null = the two
 *  can't stack either way → caller rejects / falls back. */
export function resolveStackDrop(
  draggedBits: StackBits,
  targetBits: StackBits,
  dropDir: number,
): StackResolution | null {
  const fwd = matchStack(targetBits, draggedBits, dropDir);
  if (fwd !== null) return { draggedIsMember: true, stack: fwd };
  const rev = matchStack(draggedBits, targetBits, dropDir);
  if (rev !== null) return { draggedIsMember: false, stack: rev };
  return null;
}
