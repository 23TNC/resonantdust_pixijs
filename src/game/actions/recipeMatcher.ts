/** Client-side recipe matcher for the tape-form recipe model.
 *
 *  Given a chain configuration (`root` + per-branch card lists) and
 *  the full recipe catalog from `recipesAll()`, finds the
 *  highest-priority recipe whose `input` predicates are satisfied —
 *  returning the recipe id and the per-iterator bindings the server
 *  needs in `proposeAction`.
 *
 *  Replaces the legacy `matchStackRecipe` / `matchMagneticRecipe`
 *  wasm matchers, which are gone in the unified card model.
 *
 *  **Current scope (Phase 10.2 v1):**
 *  - Predicates: `<path>.def_id: <key>`. `<path>.aspect.<name>.min:
 *    <N>` is stubbed (no aspect-name → id lookup exposed from wasm
 *    yet — TODO).
 *  - Iterators: top-level only (`parent === []`). Nested iterators
 *    (e.g., `slot.1.0.owner.slot.1.0` reaching into actor's
 *    equipment) cause the recipe to be skipped. TODO: equipment-walk
 *    helper.
 *  - Comparison ops in `when` gates are output-side only and not
 *    evaluated here.
 *
 *  Priority order: highest `AnchorSet.priorityKey` first (more
 *  anchors required = more specific = tried first). Within the same
 *  priority, source order in the recipe catalog wins. */

// ---------- Recipe IR mirror types ----------------------------------
//
// These mirror the Rust types in `pixijs/src/content/src/recipe_tape.rs`
// serialized via `wasm-bindgen` + `serde_wasm_bindgen`. The wasm
// boundary returns these as `unknown`; the matcher asserts the shape
// at entry.

/** Resolved path segment. `slot.<branch>.<index>` triplets in the
 *  source path have been collapsed into a single `Slot` ref at
 *  parse time. */
export type Seg =
  | { type: "word"; value: string }
  | { type: "index"; value: number }
  | { type: "slot"; value: { iteratorId: number; offset: number } };

/** Statement value — `Int` becomes a number, `Str` becomes a string.
 *  Untagged on the wasm side. */
export type StatementValue = number | string;

export interface Stmt {
  segments: Seg[];
  value: StatementValue | null;
  /** Hold-policy tokens (`borrow.` / `share.` / `claim.` / `use.`)
   *  on the source statement collapse into these two booleans.
   *  Default (no prefix) is `claim` = `(true, true)`. The matcher
   *  doesn't read them — only the server's `apply_locks` does — but
   *  they round-trip through wasm for completeness. */
  slotHold: boolean;
  positionHold: boolean;
}

export interface Iterator {
  /** Resolved segments before the `slot.<branch>` marker. Empty for
   *  top-level iterators (whose parent is the implicit action
   *  anchor); deeper iterators reference earlier ones via
   *  `Seg::Slot` in their parent path. */
  parent: Seg[];
  branch: number;
  /** Aggregated hold policy for this iterator's bindings — derived
   *  from per-statement prefix tokens via last-write-wins across
   *  input statements. Server-only; the matcher doesn't use these. */
  slotHold: boolean;
  positionHold: boolean;
}

export interface AnchorSet {
  root: boolean;
  /** Bitmask of top-level branch numbers referenced. Bit `n` set
   *  means the recipe needs branch `n` to be available. */
  branches: number;
}

export interface Recipe {
  id: string;
  input: Stmt[];
  output: Stmt[];
  iterators: Iterator[];
  anchors: AnchorSet;
  /** Hold-policy tokens for the implicit root anchor — same
   *  derivation as `Iterator.slotHold` / `positionHold` but for
   *  input statements whose path starts with `root`. Server-only;
   *  the matcher doesn't use these. Both `false` when no root
   *  anchor; default `(true, true)` (claim) otherwise. */
  rootSlotHold: boolean;
  rootPositionHold: boolean;
}

export interface RecipeEntry {
  /** Stable u16 id from `recipes/id.json`. */
  id: number;
  recipe: Recipe;
}

// ---------- Matcher input / output ----------------------------------

/** Minimal card row shape the matcher needs to read. */
export interface CardRow {
  cardId: number;
  packedDefinition: number;
  ownerId: number;
  microLocation: number;
}

export interface MatchInput {
  /** Root card_id — the action's chain anchor. `0` if no root
   *  (rare; recipes that need root will be skipped). */
  root: number;
  /** `branches[i]` = cards in branch `i`, in offset order. */
  branches: number[][];
  /** Card lookup by id. Returns `null` if the card isn't in the
   *  client's mirror. */
  cardLookup(id: number): CardRow | null;
  /** Card-definition lookup. Returns `null` for unknown packed
   *  definitions. Includes `aspects` and `stock` for
   *  `aspect.X.min` predicate evaluation. */
  cardDefinitionLookup(packedDef: number): {
    key: string;
    aspects: ReadonlyArray<readonly [number, number]>;
    stock: ReadonlyArray<{ aspectId: number }>;
  } | null;
  /** Resolve an aspect's numeric id by name. Returns `null` for
   *  unknown names. Mirrors `wasm_api::aspect_id_by_name`. */
  aspectIdByName(name: string): number | null;
  /** Direct parent of an aspect in the aspect tree, or `null` for
   *  top-level aspects / unknown ids. Used by `aspect.X.min`
   *  predicates to widen the match: a card carrying `corpus+`
   *  satisfies a `corpus` predicate because `corpus+`'s parent
   *  chain walks up to `corpus`. Mirrors the server's
   *  `is_aspect_descendant` walk. */
  aspectParent(id: number): number | null;
  /** Synthetic tile under the root when branch 0 has no card
   *  backing it and the root is positioned on a world surface.
   *  `packedDef` is the tile's def (from zone tile bytes);
   *  `stocks` are the per-row stock values. `null` when no tile
   *  applies (inventory chains, branch 0 has a real card, etc.).
   *
   *  When non-null, recipe references to `slot.0.0` (branch 0,
   *  offset 0) resolve to this synthetic tile; the matcher reads
   *  stocks-aware aspect totals for `min` predicates. The wire
   *  format conveys this to the server as `bindings[N][0] = 0`
   *  (the no-card sentinel) for the branch-0 iterator. */
  syntheticTile: {
    packedDef: number;
    stock0: number;
    stock1: number;
  } | null;
  /** Walk a card's chain in the given branch direction. Returns
   *  card IDs in offset order, outward from the parent card.
   *  Direction maps to the `STACK_DIRECTION_*` constants
   *  (0 = HEX / tile, 1 = UP / top, 2 = DOWN / bottom).
   *
   *  Used by the matcher to resolve nested iterators (e.g.
   *  `slot.1.0.owner.slot.1.0.def_id: axe` — the inner Slot ref
   *  needs the owner soul's branch-1 chain). Typically wired to
   *  `cards.buildChain(parentId, direction)`. */
  branchWalker(parentId: number, direction: number): readonly number[];
}

export interface MatchResult {
  recipeId: number;
  recipe: Recipe;
  /** Per-iterator card bindings, in `recipe.iterators` source order.
   *  `proposeAction` consumes this directly. The wire format is
   *  promotion-aware: if root was promoted to `slot.<branch>.0`,
   *  the root's card_id appears at index 0 of that iterator's row. */
  bindings: number[][];
  /** Card the UI anchors the debounce progress bar to. Picked from
   *  the matched bindings: first card of the recipe's top-level
   *  branch-1 iterator → first card of the top-level branch-2
   *  iterator → root. When root was promoted to `slot.1.0`, this is
   *  root itself (which is what the player visually expects). */
  progressAnchor: number;
}

// ---------- Public entry point --------------------------------------

/** Try the recipe catalog in three passes, stopping at the first
 *  pass that yields any match. Each pass filters the catalog by
 *  whether the recipe anchors on root, then promotes (or doesn't)
 *  to suit. Passes run in priority order: top-stack promotion >
 *  root-anchored > bottom-stack promotion.
 *
 *  1. **Non-root-required, root promoted to slot.1.0** — only
 *     recipes with `anchors.root === false` are tried. The loose
 *     root is prepended to branch 1 (top), so a 3-card stack
 *     matches `slot.1.0 + slot.1.1 + slot.1.2` rather than just the
 *     upper two cards. Highest priority — stacking on top is the
 *     dominant interaction shape.
 *  2. **Root-required, no promotion** — only recipes with
 *     `anchors.root === true` are tried. Input is raw. Fires when
 *     no top-stack interpretation matched.
 *  3. **Non-root-required, root promoted to slot.2.0** — same idea
 *     as pass 1 but for the bottom stack (branch 2). Lowest priority
 *     — downward recipes (e.g. `stick`) are specialized shapes that
 *     should only fire when no upward / root interpretation applies.
 *
 *  Splitting root-required from non-root-required by pass keeps the
 *  more-specific match honest: with 3 stacked corpuses, the
 *  root-required pass finds nothing (no root-anchored recipe
 *  applies), the top-promote pass gets `branches[1] = [A, B, C]` —
 *  `triple_corpus` (3 slots) matches with the full chain rather
 *  than `corpus_b.1` (2 slots) short-circuiting on the upper two.
 *
 *  Returns the highest-priority match within whichever pass first
 *  succeeds, or `null` if no recipe matches in any pass. */
export function findRecipeMatch(
  input: MatchInput,
  recipes: RecipeEntry[],
): MatchResult | null {
  // Pass 1: non-root-required, root → slot.1.0 (top-stack promotion).
  // Skip when no root exists to promote — the promotion would no-op
  // and we'd duplicate the root-required pass's work.
  if (input.root !== 0) {
    const m1 = tryMatchPass(
      promoteRootToBranch(input, 1),
      recipes,
      /* rootRequired */ false,
    );
    if (m1) return m1;
  }

  // Pass 2: root-required recipes only, raw input.
  const m2 = tryMatchPass(input, recipes, /* rootRequired */ true);
  if (m2) return m2;

  // Pass 3: non-root-required, root → slot.2.0 (bottom-stack promotion).
  if (input.root === 0) return null;
  const m3 = tryMatchPass(
    promoteRootToBranch(input, 2),
    recipes,
    /* rootRequired */ false,
  );
  if (m3) return m3;

  return null;
}

/** One pass of the matcher. `rootRequired` filters the catalog to
 *  only those recipes whose `anchors.root` matches the flag —
 *  splitting root-anchored recipes (pass 1, raw input) from
 *  non-root-anchored recipes (passes 2/3, promoted input) so a
 *  promotion-eligible recipe can't be short-circuited by a
 *  less-specific non-promoted match. */
function tryMatchPass(
  input: MatchInput,
  recipes: RecipeEntry[],
  rootRequired: boolean,
): MatchResult | null {
  const available = computeAvailableAnchors(input);
  const candidates = recipes.filter(({ recipe }) => {
    if (recipe.anchors.root !== rootRequired) return false;
    return anchorSetFits(recipe.anchors, available);
  });
  candidates.sort(
    (a, b) =>
      priorityKey(b.recipe.anchors) - priorityKey(a.recipe.anchors),
  );

  for (const entry of candidates) {
    if (!evaluatePredicates(entry.recipe, input)) continue;
    const bindings = buildBindings(entry.recipe, input);
    return {
      recipeId: entry.id,
      recipe: entry.recipe,
      bindings,
      progressAnchor: computeProgressAnchor(
        entry.recipe,
        bindings,
        input.root,
        input.cardLookup,
      ),
    };
  }
  return null;
}

/** Return a new `MatchInput` with `input.root` prepended to
 *  `branches[branch]` and `root` cleared. Promotes root into the
 *  specified branch's slot.0 — every existing card in that branch
 *  shifts one offset higher.
 *
 *  After promotion, `slot.<branch>.0` resolves to the original root
 *  during predicate eval, and the wire-format bindings sent to the
 *  server carry root at index 0 of that iterator's row. The server
 *  recognises `bindings[iter][offset] == root` and skips
 *  chain-stitch / apply-locks for it (root is already loose / locked
 *  via the separate `root` argument of `proposeAction`). */
function promoteRootToBranch(input: MatchInput, branch: number): MatchInput {
  const newBranches = input.branches.slice();
  while (newBranches.length <= branch) newBranches.push([]);
  newBranches[branch] = [input.root, ...newBranches[branch]];
  return { ...input, root: 0, branches: newBranches };
}

/** Pick the card the debounce progress bar anchors to by scanning
 *  `recipe.output` for `<path>.style.set` statements. The first such
 *  statement's resolved card_id is returned; recipes with no
 *  `style.set` get `0` (no bar).
 *
 *  Mirrors the server's `progress_style` placement, which keys on the
 *  same statements via `walker.styles` (see
 *  `action_completion::apply`). Resolving the path here uses the same
 *  shape the server's `resolve_card_target` does: a leading
 *  `Seg::Slot` (binding[iter][offset]) or `Seg::Word("root")` (the
 *  recipe's root), optionally followed by `.owner` / `.parent` walk
 *  steps. */
function computeProgressAnchor(
  recipe: Recipe,
  bindings: number[][],
  root: number,
  cardLookup: (id: number) => CardRow | null,
): number {
  for (const stmt of recipe.output) {
    const segs = stmt.segments;
    const n = segs.length;
    if (n < 3) continue;
    const last = segs[n - 1];
    const penult = segs[n - 2];
    if (last.type !== "word" || last.value !== "set") continue;
    if (penult.type !== "word" || penult.value !== "style") continue;
    const targetPath = segs.slice(0, n - 2);
    const id = resolveCardPath(targetPath, bindings, root, cardLookup);
    if (id !== 0) return id;
  }
  return 0;
}

/** Mirror of `resolve_card_target` in
 *  `spacetime/server/modules/shard/src/action_completion.rs`. Walks a
 *  card-path expression (leading `Slot` or `root` anchor, then
 *  optional `.owner` / `.parent` / `Slot` steps) and returns the
 *  resolved card_id, or `0` on resolution failure. Used by the
 *  client matcher to pre-resolve `style.set` targets for the
 *  debounce-phase progress bar. */
function resolveCardPath(
  path: Seg[],
  bindings: number[][],
  root: number,
  cardLookup: (id: number) => CardRow | null,
): number {
  if (path.length === 0) return 0;
  let cardId: number;
  const first = path[0];
  if (first.type === "word" && first.value === "root") {
    if (root === 0) return 0;
    cardId = root;
  } else if (first.type === "slot") {
    const row = bindings[first.value.iteratorId];
    if (!row) return 0;
    const id = row[first.value.offset];
    if (id === undefined || id === 0) return 0;
    cardId = id;
  } else {
    return 0;
  }
  for (let i = 1; i < path.length; i++) {
    const seg = path[i];
    if (seg.type === "word" && seg.value === "owner") {
      const row = cardLookup(cardId);
      if (!row || row.ownerId === 0) return 0;
      cardId = row.ownerId;
    } else if (seg.type === "word" && seg.value === "parent") {
      const row = cardLookup(cardId);
      if (!row || row.microLocation === 0) return 0;
      cardId = row.microLocation;
    } else if (seg.type === "slot") {
      const row = bindings[seg.value.iteratorId];
      if (!row) return 0;
      const id = row[seg.value.offset];
      if (id === undefined || id === 0) return 0;
      cardId = id;
    } else {
      return 0;
    }
  }
  return cardId;
}

// ---------- Anchor set helpers -------------------------------------

/** Which top-level anchors does the player's configuration provide?
 *  `root` is set if `input.root !== 0`; branches are set if the
 *  corresponding `input.branches[i]` is non-empty. Branch 0 is
 *  additionally set when a synthetic tile resolves under root,
 *  so tile recipes (`slot.0.0.aspect.X.min`) match against
 *  world-positioned roots even when no tile-card row exists. */
function computeAvailableAnchors(input: MatchInput): AnchorSet {
  let branches = 0;
  for (let i = 0; i < input.branches.length; i++) {
    if (input.branches[i].length > 0) {
      branches |= 1 << i;
    }
  }
  if (input.syntheticTile !== null) {
    branches |= 1 << 0;
  }
  return { root: input.root !== 0, branches };
}

function anchorSetFits(need: AnchorSet, have: AnchorSet): boolean {
  if (need.root && !have.root) return false;
  if ((need.branches & ~have.branches) !== 0) return false;
  return true;
}

/** Same formula as `recipe_tape::AnchorSet::priority_key`. Higher
 *  key = higher priority. */
function priorityKey(a: AnchorSet): number {
  const count =
    (a.root ? 1 : 0) + bitCount(a.branches & 0xffff);
  // Within same count: prefer lower-numbered branches (branch 0 =
  // tile = most specific). Match the Rust formula exactly.
  const inverted = (~a.branches) & 0xffff;
  return ((count << 24) | ((a.root ? 1 : 0) << 16) | inverted) >>> 0;
}

function bitCount(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// ---------- Predicate evaluation -----------------------------------

function evaluatePredicates(recipe: Recipe, input: MatchInput): boolean {
  for (const stmt of recipe.input) {
    if (!evaluateStmt(stmt, recipe, input)) return false;
  }
  return true;
}

function evaluateStmt(
  stmt: Stmt,
  recipe: Recipe,
  input: MatchInput,
): boolean {
  const op = lastWord(stmt.segments);
  if (op === null) return false;

  switch (op) {
    case "def_id": {
      if (typeof stmt.value !== "string") return false;
      const targetPath = stmt.segments.slice(0, -1);
      const target = resolveTarget(targetPath, recipe, input);
      if (target === null) return false;
      const def = input.cardDefinitionLookup(target.packedDef);
      return def?.key === stmt.value;
    }
    case "min": {
      // Shape: <path>.aspect.<name>.min: <N>
      // segments = [<path...>, aspect, <name>, min]
      if (stmt.segments.length < 4) return false;
      const aspectSeg = stmt.segments[stmt.segments.length - 3];
      const nameSeg = stmt.segments[stmt.segments.length - 2];
      if (aspectSeg.type !== "word" || aspectSeg.value !== "aspect") return false;
      if (nameSeg.type !== "word") return false;
      if (typeof stmt.value !== "number") return false;
      const aspectName = nameSeg.value;
      const minValue = stmt.value;

      const aspectId = input.aspectIdByName(aspectName);
      if (aspectId === null) return false;

      // Target is everything before `.aspect.<name>.min`.
      const targetPath = stmt.segments.slice(0, stmt.segments.length - 3);
      const target = resolveTarget(targetPath, recipe, input);
      if (target === null) return false;
      const def = input.cardDefinitionLookup(target.packedDef);
      if (def === null) return false;

      // Stock-aware aspect total. When the target carries per-row
      // stocks (synthetic tile case), sum stock values for slots
      // whose declared aspect is a descendant of the predicate's
      // aspect; if any stock slot matched, that's the answer
      // (mirrors server-side widening — stock takes precedence over
      // static when both exist for the same aspect). Otherwise fall
      // back to static aspects.
      //
      // Sub-aspect widening: a `wood` predicate matches a tile
      // carrying `wood++` (a sub-aspect of `wood`). We walk the
      // declared aspect's parent chain via `aspectParent` looking
      // for the predicate's aspect; same shape as the server's
      // `is_aspect_descendant`.
      let total = 0;
      if (target.stock0 !== undefined && target.stock1 !== undefined) {
        let stockMatched = false;
        for (let i = 0; i < def.stock.length; i++) {
          if (isAspectDescendant(def.stock[i].aspectId, aspectId, input)) {
            stockMatched = true;
            total += i === 0 ? target.stock0 : target.stock1;
          }
        }
        if (stockMatched) return total >= minValue;
      }
      for (const [id, value] of def.aspects) {
        if (isAspectDescendant(id, aspectId, input)) total += value;
      }
      return total >= minValue;
    }
    default:
      // Unknown predicate ops aren't input-side; recipe authoring
      // bug. Treat as no-match rather than throwing — the matcher
      // shouldn't crash on bad recipes.
      return false;
  }
}

function lastWord(segments: Seg[]): string | null {
  const last = segments[segments.length - 1];
  if (last && last.type === "word") return last.value;
  return null;
}

/** Is `child` either `ancestor` or a descendant of `ancestor` in the
 *  aspect tree? Walks `child`'s parent chain via `input.aspectParent`
 *  looking for `ancestor`. Mirrors the server's
 *  `definition_core::is_aspect_descendant`. Bounded by tree depth
 *  (≤4 in practice today, capped at 16 defensively to match server). */
function isAspectDescendant(
  child: number,
  ancestor: number,
  input: MatchInput,
): boolean {
  if (child === 0 || ancestor === 0) return false;
  let current: number | null = child;
  for (let i = 0; i < 16 && current !== null; i++) {
    if (current === ancestor) return true;
    current = input.aspectParent(current);
  }
  return false;
}

/** Result of resolving a predicate's target path. `packedDef` is
 *  the def of the card / tile the predicate applies to; `stock0` /
 *  `stock1` are non-undefined only when the target is a synthetic
 *  tile (Phase 12 / 13 v2c carries them through). */
interface ResolvedTarget {
  packedDef: number;
  stock0?: number;
  stock1?: number;
}

/** Walk a path to its terminal target. Handles both the synthetic-
 *  tile case (single Slot ref to branch 0 / offset 0 with
 *  `input.syntheticTile`) and the standard real-card path walk. */
function resolveTarget(
  path: Seg[],
  recipe: Recipe,
  input: MatchInput,
): ResolvedTarget | null {
  // Synthetic-tile short-circuit: single Slot ref to branch 0 /
  // offset 0 (top-level iterator, no chain steps) AND a synthetic
  // tile is available. The "card" is the tile def from zone data,
  // with stocks for stock-aware predicate eval.
  if (path.length === 1 && path[0].type === "slot") {
    const slot = path[0].value;
    const it = recipe.iterators[slot.iteratorId];
    if (
      it !== undefined &&
      it.parent.length === 0 &&
      it.branch === 0 &&
      slot.offset === 0 &&
      input.syntheticTile !== null
    ) {
      const branchCards = input.branches[0];
      // Only synthesize when branch 0 is empty AND the tile is
      // present — otherwise the player's actual card wins.
      if (branchCards === undefined || branchCards.length === 0) {
        return {
          packedDef: input.syntheticTile.packedDef,
          stock0: input.syntheticTile.stock0,
          stock1: input.syntheticTile.stock1,
        };
      }
    }
  }
  // Standard path: resolve to a card via the existing walker.
  const card = resolveTargetCard(path, recipe, input);
  if (card === null) return null;
  return { packedDef: card.packedDefinition };
}

/** Walk a path's segments to resolve the terminal `card_id`. Path
 *  may start with `root` (uses `input.root`) or a `Seg::Slot` (uses
 *  the corresponding binding), then traverse via `.owner` /
 *  `.parent` and further `Seg::Slot`s. */
function resolveTargetCard(
  path: Seg[],
  recipe: Recipe,
  input: MatchInput,
): CardRow | null {
  if (path.length === 0) return null;
  const first = path[0];

  let cardId: number;
  if (first.type === "word" && first.value === "root") {
    if (input.root === 0) return null;
    cardId = input.root;
  } else if (first.type === "slot") {
    const { offset } = first.value;
    const it = recipe.iterators[first.value.iteratorId];
    if (!it) return null;
    if (it.parent.length > 0) {
      // A nested iterator should never appear as the FIRST segment
      // of a path — its parent path always anchors at root or
      // another top-level slot. If we see one here, the recipe is
      // malformed.
      return null;
    }
    const branchCards = input.branches[it.branch];
    if (!branchCards) return null;
    const id = branchCards[offset];
    if (id === undefined || id === 0) return null;
    cardId = id;
  } else {
    return null;
  }

  // Traverse subsequent segments.
  for (let i = 1; i < path.length; i++) {
    const seg = path[i];
    if (seg.type === "word" && seg.value === "owner") {
      const card = input.cardLookup(cardId);
      if (card === null) return null;
      cardId = card.ownerId;
      if (cardId === 0) return null;
    } else if (seg.type === "word" && seg.value === "parent") {
      const card = input.cardLookup(cardId);
      if (card === null) return null;
      cardId = card.microLocation;
      if (cardId === 0) return null;
    } else if (seg.type === "slot") {
      // Nested iterator reference — the previous card_id is the
      // parent of the iteration. Walk the parent's branch in the
      // iterator's direction and pick the slot at the given offset.
      const it = recipe.iterators[seg.value.iteratorId];
      if (!it) return null;
      const branchCards = input.branchWalker(cardId, it.branch);
      const targetId = branchCards[seg.value.offset];
      if (targetId === undefined || targetId === 0) return null;
      cardId = targetId;
    } else {
      // Unknown traversal step.
      return null;
    }
  }
  return input.cardLookup(cardId);
}

// ---------- Bindings construction ----------------------------------

/** After predicate evaluation passes, construct `bindings[iter_id]`
 *  for `proposeAction`. For top-level iterators (the only kind we
 *  support today), the binding is `input.branches[iterator.branch]`.
 *  Special case: when the iterator targets branch 0 / offset 0 and
 *  the matcher used the synthetic-tile fallback, the binding is
 *  `[0]` (the no-card sentinel the server interprets via
 *  `derive_synthetic_hex`). */
function buildBindings(recipe: Recipe, input: MatchInput): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < recipe.iterators.length; i++) {
    const it = recipe.iterators[i];
    if (it.parent.length > 0) {
      // Nested iterator — walk the parent path to find the parent
      // card, then walk the parent's branch chain. The server
      // expects `bindings[i]` to carry the card_ids the recipe's
      // slot offsets resolve to.
      const parentCard = resolveTargetCard(it.parent, recipe, input);
      if (parentCard === null) {
        // Predicate eval already succeeded, so the parent path
        // must resolve; defensive empty entry keeps the wire
        // format length right.
        out.push([]);
        continue;
      }
      const chain = input.branchWalker(parentCard.cardId, it.branch);
      out.push([...chain]);
      continue;
    }
    const branchCards = input.branches[it.branch] ?? [];
    if (
      branchCards.length === 0 &&
      it.branch === 0 &&
      input.syntheticTile !== null
    ) {
      out.push([0]);
      continue;
    }
    out.push([...branchCards]);
  }
  return out;
}
