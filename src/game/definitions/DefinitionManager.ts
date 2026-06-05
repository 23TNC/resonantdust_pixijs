/** Content/definition access — backed by the shared `resonantdust-wasm` runtime
 *  loaded from the gate (`contentBoot`). Replaces the deleted legacy
 *  `resonantdust_content` wasm.
 *
 *  The DSL models differ from the legacy crate, so this layer ADAPTS:
 *   - **Aspects** are name-keyed in the DSL (multi-parent `satisfies`). The
 *     client still wants numeric ids for its id-keyed render/UI code, so we
 *     build a stable client-local id space from `Content.aspectNames()` (ids
 *     never cross the wire now). `aspectInfo(id)` maps id→name→record and
 *     approximates the legacy single `parent` as `satisfies[0]`.
 *   - **Visuals** are `shape`/`color.{bg,title,text}`/`objects[]`/`texture`;
 *     `decode()` adapts them into the legacy `CardDefinition` (`style[3]` from
 *     the colors, `object` from `objects[0]`).
 *   - **Recipes** are VM bytecode, so matching runs on the VM via
 *     `Content.matchRecipe`; `findRecipeMatch` drives discovery with
 *     `Content.recipeMeta`.
 *
 *  Bootstrap: `await initDefinitions()` (alias of `initContent`) once at
 *  startup before any DefinitionManager method. */

import {
  initContent,
  onContentReloaded,
  sharedContent,
  sharedLocales,
} from "./contentBoot";
import {
  cardFlagBit as wasmCardFlagBit,
  cardFlagBitIn as wasmCardFlagBitIn,
  cardFlagFieldShape as wasmCardFlagFieldShape,
  cardFlagFieldValueAny as wasmCardFlagFieldValueAny,
  cardFlagFieldValueIn as wasmCardFlagFieldValueIn,
  hasCardFlag as wasmHasCardFlag,
  cardTypeId as wasmCardTypeId,
  isHexType as wasmIsHexType,
} from "../../wasm/pkg/resonantdust_wasm";
import {
  findRecipeMatch as findRecipeMatchInternal,
  type CardRow as MatcherCardRow,
  type MatchResult,
  type PlacedCard,
  type RecipeCandidate,
  type RecipeMeta,
} from "../actions/recipeMatcher";

export type AspectCategory = "aspect" | "feature" | "trait";

export interface AspectInfo {
  id: number;
  name: string;
  icon: string;
  /** `0xRRGGBB`. */
  color: number;
  /** Top-level family — the root of the `satisfies` chain. */
  group: string;
  /** Approximated as the first `satisfies` entry's id, or `null`. */
  parent: number | null;
  category: AspectCategory;
}

export interface Blueprint {
  id: number;
  key: string;
  blueprintKey: string;
  blueprintPackedDefinition: number;
  cardKey: string;
  cardPackedDefinition: number;
}

export type StockMode = "count" | "index";

export interface StockSlot {
  aspectId: number;
  max: number;
  default: number;
  mode: StockMode;
}

export interface CardDefinition {
  cardType: number;
  definitionId: number;
  key: string;
  /** `&shape` from the DSL — `"rect"` | `"hex"` | `"generic"`. Drives which
   *  Layout half `Card.spawn` builds (generic → the PrimList reconciler). */
  shape: string;
  /** `[bg, title, text]` CSS hex strings (from the DSL `color.*`). */
  style: readonly string[];
  object?: { name: string; index?: number; scale?: { min: number; max: number } } | null;
  texture?: { name: string; index?: number; scale?: { min: number; max: number } } | null;
  aspects: ReadonlyArray<readonly [number, number]>;
  flags: number;
  lifecycleRecipeKey?: string | null;
  lifecycleDurationMs?: number | null;
  stock: readonly StockSlot[];
}

// ---- DSL-native wasm shapes (JSON across the boundary) ----------------

interface DslAspectInfo {
  name: string;
  icon: string;
  color: number;
  section: string;
  satisfies: string[];
  art: string | null;
}

interface DslCardDef {
  card_type: number;
  def_id: number;
  key: string;
  type_name: string;
  shape: string;
  color_bg: number;
  color_title: number;
  color_text: number;
  texture: string | null;
  objects: string[];
  aspects: [string, number][];
  stock: { aspect: string; max: number; default: number }[];
  lifecycle_recipe: string | null;
  lifecycle_duration_ms: number | null;
}

interface DslBlueprint {
  id: number;
  key: string;
  blueprint_card: string;
  blueprint_packed: number;
  output_card: string;
  output_packed: number;
}

/** Boot the shared content runtime (alias of `initContent`). Idempotent. */
export async function initDefinitions(): Promise<void> {
  await initContent();
}

function hex(color: number): string {
  return "#" + (color >>> 0).toString(16).padStart(6, "0");
}

function sectionToCategory(section: string): AspectCategory {
  if (section === "features") return "feature";
  if (section === "traits") return "trait";
  return "aspect";
}

export class DefinitionManager {
  constructor() {
    // Drop content-derived caches when the gate pushes a runtime add/modify, so
    // the next read reflects the rebuilt corpus. (`decode`/`aspectInfo`/etc.
    // read `sharedContent()` live, so only the memoized maps below need this.)
    onContentReloaded(() => this.invalidate());
  }

  /** Reset every content-derived cache after a content reload. */
  invalidate(): void {
    this.aspectIdToName = null;
    this.aspectNameToId = null;
    this.cachedCandidates = null;
    this.factionAspectId = undefined;
    this.allBlueprintsCache = null;
  }

  // ---- aspect id↔name space (client-local; ids never cross the wire) ----
  private aspectIdToName: string[] | null = null;
  private aspectNameToId: Map<string, number> | null = null;

  private ensureAspectMaps(): void {
    if (this.aspectIdToName !== null) return;
    const names = sharedContent().aspectNames();
    this.aspectIdToName = names;
    this.aspectNameToId = new Map(names.map((n, i) => [n, i + 1]));
  }

  aspectIdByName(name: string): number | null {
    this.ensureAspectMaps();
    return this.aspectNameToId!.get(name) ?? null;
  }

  private aspectNameById(id: number): string | null {
    this.ensureAspectMaps();
    return this.aspectIdToName![id - 1] ?? null;
  }

  private dslAspect(name: string): DslAspectInfo | null {
    const raw = sharedContent().aspectInfo(name);
    return JSON.parse(raw) as DslAspectInfo | null;
  }

  aspectInfo(id: number): AspectInfo | null {
    const name = this.aspectNameById(id);
    if (name === null) return null;
    const dsl = this.dslAspect(name);
    if (dsl === null) return null;
    // group = root of the satisfies chain.
    let group = name;
    let cur: string | undefined = dsl.satisfies[0];
    for (let i = 0; i < 8 && cur !== undefined; i++) {
      group = cur;
      cur = this.dslAspect(cur)?.satisfies[0];
    }
    const parentName = dsl.satisfies[0];
    return {
      id,
      name,
      icon: dsl.icon,
      color: dsl.color,
      group,
      parent: parentName !== undefined ? this.aspectIdByName(parentName) : null,
      category: sectionToCategory(dsl.section),
    };
  }

  decode(packed: number): CardDefinition | null {
    const raw = sharedContent().cardDef(packed);
    const dsl = JSON.parse(raw) as DslCardDef | null;
    if (dsl === null) return null;
    return {
      cardType: dsl.card_type,
      definitionId: dsl.def_id,
      key: dsl.key,
      shape: dsl.shape,
      style: [hex(dsl.color_bg), hex(dsl.color_title), hex(dsl.color_text)],
      object: dsl.objects.length > 0 ? { name: dsl.objects[0] } : null,
      texture: dsl.texture !== null ? { name: dsl.texture } : null,
      aspects: dsl.aspects.map(([n, v]) => [this.aspectIdByName(n) ?? 0, v] as const),
      flags: 0,
      lifecycleRecipeKey: dsl.lifecycle_recipe,
      lifecycleDurationMs: dsl.lifecycle_duration_ms,
      stock: dsl.stock.map((s) => ({
        aspectId: this.aspectIdByName(s.aspect) ?? 0,
        max: s.max,
        default: s.default,
        mode: "count" as StockMode,
      })),
    };
  }

  /** Display label for a packed def. Locale key is `cards.<type>.<key>.label`
   *  (falling back to `cards.<key>.label`, then the bare key). */
  label(packedDef: number, _lang = "en"): string {
    const def = this.decode(packedDef);
    if (def === null) return "?";
    const dsl = JSON.parse(sharedContent().cardDef(packedDef)) as DslCardDef;
    const loc = sharedLocales();
    return (
      loc.string(`cards.${dsl.type_name}.${def.key}.label`) ??
      loc.string(`cards.${def.key}.label`) ??
      def.key
    );
  }

  findPackedByKey(key: string): number | undefined {
    return sharedContent().packedDef(key) ?? undefined;
  }

  shape(typeId: number): "rect" | "hex" | "generic" | undefined {
    try {
      // "generic" routes a card to the DSL-driven PrimList renderer
      // (LayoutGenericCard). The signal is content-side — when the DSL marks a
      // card's shape as generic, return "generic" here. Until that's wired, the
      // value is never produced, so the generic path stays inert.
      return wasmIsHexType(typeId) ? "hex" : "rect";
    } catch {
      return undefined;
    }
  }

  cardFlagBit(name: string): number | undefined {
    return wasmCardFlagBit(name);
  }

  cardFlagMask(name: string): number {
    const bit = wasmCardFlagBit(name);
    return bit === undefined ? 0 : 1 << bit;
  }

  hasCardFlag(flagsState: number, flagsBk: number, name: string): boolean {
    return wasmHasCardFlag(flagsState, flagsBk, name);
  }

  cardFlagFieldValueAny(flagsState: number, flagsBk: number, name: string): number | undefined {
    return wasmCardFlagFieldValueAny(flagsState, flagsBk, name);
  }

  /** **Legacy** single-host read — routes via the field-aware lookup using the
   *  same value for both hosts (ambiguous; prefer the explicit variants). */
  cardFlagFieldValue(flags: number, name: string): number | undefined {
    return wasmCardFlagFieldValueAny(flags, flags, name);
  }

  cardFlagBitIn(field: "cards_state" | "cards_bk", name: string): number | undefined {
    return wasmCardFlagBitIn(field, name);
  }

  cardFlagFieldShape(
    field: "cards_state" | "cards_bk",
    name: string,
  ): [number, number] | undefined {
    const arr = wasmCardFlagFieldShape(field, name);
    if (arr === undefined || arr.length !== 2) return undefined;
    return [arr[0], arr[1]];
  }

  cardFlagFieldValueIn(
    field: "cards_state" | "cards_bk",
    host: number,
    name: string,
  ): number | undefined {
    return wasmCardFlagFieldValueIn(field, host, name);
  }

  cardTypeId(name: string): number | undefined {
    return wasmCardTypeId(name);
  }

  aspectValue(packedDefinition: number, name: string): number | null {
    const v = sharedContent().aspectValue(packedDefinition, name);
    return v === undefined ? null : Number(v);
  }

  isCardType(packedDefinition: number, typeName: string): boolean {
    const typeId = this.cardTypeId(typeName);
    if (typeId === undefined) return false;
    const def = this.decode(packedDefinition);
    return def !== null && def.cardType === typeId;
  }

  // ---------- recipes (discovery on the VM) ----------

  private cachedCandidates: RecipeCandidate[] | null = null;

  private candidates(): RecipeCandidate[] {
    if (this.cachedCandidates === null) {
      const content = sharedContent();
      this.cachedCandidates = content.recipeNames().map((name) => ({
        id: content.recipeId(name) ?? 0,
        name,
        meta: JSON.parse(content.recipeMeta(name)) as RecipeMeta,
      }));
    }
    return this.cachedCandidates;
  }

  /** Numeric wire id for a recipe name, or `null`. */
  recipeIdByKey(key: string): number | null {
    return sharedContent().recipeId(key) ?? null;
  }

  /** A recipe's [`RecipeMeta`] by wire id (iterators + holds + arity), or `null`. */
  recipeMetaById(id: number): RecipeMeta | null {
    return this.candidates().find((c) => c.id === id)?.meta ?? null;
  }

  /** A recipe's [`RecipeMeta`] by name, or `null`. */
  recipeMetaByKey(key: string): RecipeMeta | null {
    return this.candidates().find((c) => c.name === key)?.meta ?? null;
  }

  findRecipeMatch(input: {
    root: number;
    branches: number[][];
    cardLookup(id: number): MatcherCardRow | null;
    syntheticTile?: { packedDef: number; stock0: number; stock1: number } | null;
    branchWalker?(parentId: number, direction: number): readonly number[];
  }): MatchResult | null {
    const content = sharedContent();
    const placedFor = (card: MatcherCardRow): PlacedCard | null => {
      const defId = content.defIdForPacked(card.packedDefinition);
      // Bound cards carry no per-instance stock into matching (their
      // recipe-relevant aspects are static `@define` values) — same as the gate.
      return defId === undefined ? null : { defId, stock: [] };
    };
    const synthetic =
      input.syntheticTile != null
        ? (() => {
            const defId = content.defIdForPacked(input.syntheticTile!.packedDef);
            return defId === undefined
              ? null
              : { defId, stock: [input.syntheticTile!.stock0, input.syntheticTile!.stock1] };
          })()
        : null;
    return findRecipeMatchInternal(
      {
        root: input.root,
        branches: input.branches,
        cardLookup: input.cardLookup,
        placedFor,
        syntheticTile: synthetic,
        branchWalker: input.branchWalker ?? (() => [] as readonly number[]),
        matchRecipe: (placed, name) => {
          const json = JSON.stringify(
            placed.map(([path, c]) => [path, { def_id: c.defId, stock: c.stock }]),
          );
          const plan = JSON.parse(content.matchRecipe(json, name)) as { matched: boolean } | null;
          return plan?.matched ?? false;
        },
      },
      this.candidates(),
    );
  }

  // ---------- faction override (render folder) ----------

  private factionAspectId: number | null | undefined = undefined;

  cardFactionOverride(
    def: { aspects: ReadonlyArray<readonly [number, number]> } | null | undefined,
  ): string | null {
    if (!def) return null;
    if (this.factionAspectId === undefined) {
      this.factionAspectId = this.aspectIdByName("faction");
    }
    const factionId = this.factionAspectId;
    if (factionId === null) return null;
    for (const [aspectId] of def.aspects ?? []) {
      let cur: number | null = aspectId;
      for (let depth = 0; depth < 16 && cur !== null; depth++) {
        const info = this.aspectInfo(cur);
        if (!info) break;
        if (info.id === factionId) {
          return this.aspectInfo(aspectId)?.name ?? null;
        }
        cur = info.parent;
      }
    }
    return null;
  }

  // ---------- blueprints ----------

  private allBlueprintsCache: Blueprint[] | null = null;

  private adaptBlueprint(b: DslBlueprint): Blueprint {
    return {
      id: b.id,
      key: b.key,
      blueprintKey: b.blueprint_card,
      blueprintPackedDefinition: b.blueprint_packed,
      cardKey: b.output_card,
      cardPackedDefinition: b.output_packed,
    };
  }

  allBlueprints(): Blueprint[] {
    if (this.allBlueprintsCache === null) {
      const raw = JSON.parse(sharedContent().allBlueprints()) as DslBlueprint[];
      this.allBlueprintsCache = raw.map((b) => this.adaptBlueprint(b));
    }
    return this.allBlueprintsCache;
  }

  blueprintById(id: number): Blueprint | null {
    return this.allBlueprints().find((b) => b.id === id) ?? null;
  }

  blueprintByKey(key: string): Blueprint | null {
    return this.allBlueprints().find((b) => b.key === key) ?? null;
  }

  // ---------- packed codec (static) ----------

  static unpack(packedDef: number): { typeId: number; definitionId: number } {
    return { typeId: (packedDef >> 12) & 0xf, definitionId: packedDef & 0xfff };
  }

  static pack(typeId: number, definitionId: number): number {
    return ((typeId & 0xf) << 12) | (definitionId & 0xfff);
  }
}
