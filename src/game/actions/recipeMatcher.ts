/** Client-side recipe discovery — wasm-backed.
 *
 *  The DSL recipe is VM bytecode, not a path-statement IR, so predicate
 *  evaluation runs on the shared VM via `Content.matchRecipe` (the SAME engine
 *  the gate validates with — no TS↔Rust drift). This module keeps the
 *  *discovery* logic that's client-specific: which recipe to try (3-pass root
 *  promotion + anchor priority), and the per-iterator `bindings` `proposeAction`
 *  sends. Each candidate's structure (`iterators` + `anchors`) comes from
 *  `Content.recipeMeta`.
 *
 *  Scope: top-level iterators + the branch-0 synthetic tile are fully handled;
 *  nested (equipment-chain) iterators are placed best-effort via `branchWalker`. */

/** A recipe's structure from `Content.recipeMeta` (deserialized). */
export interface RecipeMeta {
  iterators: { parent: string; branch: number; slotHold: boolean; positionHold: boolean }[];
  root: boolean;
  /** Bitmask of top-level branches referenced. */
  branches: number;
  rootSlotHold: boolean;
  rootPositionHold: boolean;
  /** `@input` statement count (≤1 → debounce bypass). */
  inputCount: number;
  /** Required card count per top-level branch (index 0..=2). */
  branchCounts: number[];
}

/** A recipe candidate: wire id + name + structure. */
export interface RecipeCandidate {
  id: number;
  name: string;
  meta: RecipeMeta;
}

/** Minimal card row the matcher reads. */
export interface CardRow {
  cardId: number;
  packedDefinition: number;
  ownerId: number;
  microLocation: number;
}

/** A card placed into the VM frame: the bundle's global `defId` + stock values. */
export interface PlacedCard {
  defId: number;
  stock: number[];
}

export interface MatchInput {
  root: number;
  branches: number[][];
  cardLookup(id: number): CardRow | null;
  /** Build the VM-frame card (global def id + stock) for a row, or `null`. */
  placedFor(card: CardRow): PlacedCard | null;
  /** Synthetic tile under the root (branch-0 sentinel), already def-id'd. */
  syntheticTile: PlacedCard | null;
  /** Walk a card's chain in a branch direction (for nested iterators). */
  branchWalker(parentId: number, direction: number): readonly number[];
  /** Run the VM `@input` match for `recipeName` over a placed frame. The bool
   *  is the VM's `matched` verdict (predicate eval — shared with the gate). */
  matchRecipe(placed: [string, PlacedCard][], recipeName: string): boolean;
}

export interface MatchResult {
  recipeId: number;
  /** The matched recipe's name (Bundle key) — for lifecycle key comparison. */
  recipeKey: string;
  /** `@input` statement count of the matched recipe (debounce bypass). */
  inputCount: number;
  bindings: number[][];
  /** Card the debounce progress bar anchors to (first top branch, else root). */
  progressAnchor: number;
}

/** The DSL slot path for an iterator at `offset`. Mirrors `Iter::path` in Rust. */
function iterPath(it: { parent: string; branch: number }, offset: number): string {
  return it.parent === ""
    ? `slot.${it.branch}.${offset}`
    : `${it.parent}.slot.${it.branch}.${offset}`;
}

/** Try the catalog in three passes, first success wins: top-stack promotion >
 *  root-anchored raw > bottom-stack promotion. */
export function findRecipeMatch(
  input: MatchInput,
  candidates: RecipeCandidate[],
): MatchResult | null {
  if (input.root !== 0) {
    const m1 = tryPass(promoteRoot(input, 1), candidates, false);
    if (m1) return m1;
  }
  const m2 = tryPass(input, candidates, true);
  if (m2) return m2;
  if (input.root === 0) return null;
  return tryPass(promoteRoot(input, 2), candidates, false);
}

function tryPass(
  input: MatchInput,
  candidates: RecipeCandidate[],
  rootRequired: boolean,
): MatchResult | null {
  const have = availableAnchors(input);
  const filtered = candidates
    .filter((c) => c.meta.root === rootRequired && anchorsFit(c.meta, have))
    .sort((a, b) => priorityKey(b.meta) - priorityKey(a.meta));

  for (const cand of filtered) {
    const placed = buildPlaced(cand.meta, input);
    if (placed === null) continue;
    if (!input.matchRecipe(placed, cand.name)) continue;
    const bindings = buildBindings(cand.meta, input);
    return {
      recipeId: cand.id,
      recipeKey: cand.name,
      inputCount: cand.meta.inputCount,
      bindings,
      progressAnchor: progressAnchor(bindings, input.root),
    };
  }
  return null;
}

/** Prepend `root` to `branches[branch]` and clear root (top/bottom promotion). */
function promoteRoot(input: MatchInput, branch: number): MatchInput {
  const branches = input.branches.slice();
  while (branches.length <= branch) branches.push([]);
  branches[branch] = [input.root, ...branches[branch]];
  return { ...input, root: 0, branches };
}

/** Assemble the VM frame: `(slotPath, PlacedCard)` for every bound card, plus
 *  the branch-0 synthetic tile when branch 0 is empty. `null` if a referenced
 *  card has no placed view (mirror miss → can't match this candidate). */
function buildPlaced(
  meta: RecipeMeta,
  input: MatchInput,
): [string, PlacedCard][] | null {
  const placed: [string, PlacedCard][] = [];
  // Place the root card at `root` — root-anchored recipes (`*root.def_id` /
  // `*root.aspect.*`) read it, and the gate's `build_frame` places it, so the
  // client frame MUST too or the VM evaluates root predicates against an empty
  // slot (which spuriously passes `def_id eq`, causing bogus matches the gate
  // then rejects). In the promotion passes `root` is 0 (folded into a branch).
  if (input.root !== 0) {
    const rootRow = input.cardLookup(input.root);
    const rootPlaced = rootRow && input.placedFor(rootRow);
    if (!rootPlaced) return null;
    placed.push(["root", rootPlaced]);
  }
  for (const it of meta.iterators) {
    if (it.parent !== "") {
      // nested iterator: walk the parent's chain (best-effort).
      const parentId = nestedParent(it.parent, input);
      if (parentId === 0) continue;
      const chain = input.branchWalker(parentId, it.branch);
      chain.forEach((id, offset) => {
        const row = input.cardLookup(id);
        const pc = row && input.placedFor(row);
        if (pc) placed.push([iterPath(it, offset), pc]);
      });
      continue;
    }
    const cards = input.branches[it.branch] ?? [];
    if (cards.length === 0 && it.branch === 0 && input.syntheticTile !== null) {
      placed.push([iterPath(it, 0), input.syntheticTile]);
      continue;
    }
    for (let offset = 0; offset < cards.length; offset++) {
      const row = input.cardLookup(cards[offset]);
      if (row === null) return null;
      const pc = input.placedFor(row);
      if (pc === null) return null;
      placed.push([iterPath(it, offset), pc]);
    }
  }
  return placed;
}

/** Per-iterator card_id bindings for `proposeAction`. Top-level: the branch's
 *  cards (branch-0 synthetic → `[0]` sentinel). Nested: the parent's chain. */
function buildBindings(meta: RecipeMeta, input: MatchInput): number[][] {
  const out: number[][] = [];
  for (const it of meta.iterators) {
    if (it.parent !== "") {
      const parentId = nestedParent(it.parent, input);
      out.push(parentId === 0 ? [] : [...input.branchWalker(parentId, it.branch)]);
      continue;
    }
    const cards = input.branches[it.branch] ?? [];
    if (cards.length === 0 && it.branch === 0 && input.syntheticTile !== null) {
      out.push([0]);
      continue;
    }
    out.push([...cards]);
  }
  return out;
}

/** Resolve a nested iterator's parent-path prefix (e.g. `slot.1.0.owner`) to a
 *  card_id. Handles `slot.B.O` (top-level branch lookup) + `.owner` / `.parent`
 *  steps. `0` on failure. */
function nestedParent(parent: string, input: MatchInput): number {
  const segs = parent.split(".");
  let cardId = 0;
  let i = 0;
  while (i < segs.length) {
    if (segs[i] === "slot" && i + 2 < segs.length) {
      const branch = Number(segs[i + 1]);
      const offset = Number(segs[i + 2]);
      const cards = input.branches[branch] ?? [];
      cardId = cards[offset] ?? 0;
      if (cardId === 0) return 0;
      i += 3;
    } else if (segs[i] === "owner") {
      const row = input.cardLookup(cardId);
      cardId = row?.ownerId ?? 0;
      if (cardId === 0) return 0;
      i += 1;
    } else if (segs[i] === "parent") {
      const row = input.cardLookup(cardId);
      cardId = row?.microLocation ?? 0;
      if (cardId === 0) return 0;
      i += 1;
    } else {
      i += 1;
    }
  }
  return cardId;
}

/** Progress-bar anchor: first card of the first top-level branch≥1 binding,
 *  else root. (Simplified from the legacy `style.set` scan — the gate stamps
 *  the authoritative progress style on the completion row.) */
function progressAnchor(bindings: number[][], root: number): number {
  for (const row of bindings) {
    const id = row.find((c) => c !== 0);
    if (id !== undefined) return id;
  }
  return root;
}

// ---------- anchor-set helpers (mirror recipe_tape priority) ----------

function availableAnchors(input: MatchInput): { root: boolean; branches: number } {
  let branches = 0;
  for (let i = 0; i < input.branches.length; i++) {
    if (input.branches[i].length > 0) branches |= 1 << i;
  }
  if (input.syntheticTile !== null) branches |= 1 << 0;
  return { root: input.root !== 0, branches };
}

function anchorsFit(meta: RecipeMeta, have: { root: boolean; branches: number }): boolean {
  if (meta.root && !have.root) return false;
  return (meta.branches & ~have.branches) === 0;
}

function priorityKey(meta: RecipeMeta): number {
  const count = (meta.root ? 1 : 0) + bitCount(meta.branches & 0xffff);
  const inverted = ~meta.branches & 0xffff;
  return ((count << 24) | ((meta.root ? 1 : 0) << 16) | inverted) >>> 0;
}

function bitCount(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
