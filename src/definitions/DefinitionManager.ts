import cardTypesData from "../data/card_types.json";
import cardIdsData from "../data/cards/id.json";

export type ColorTriple = readonly [string, string, string];
export type AspectEntry = readonly [name: string, value: number];

export interface CardDefinition {
  readonly packed: number;
  readonly typeId: number;
  readonly typeName: string;
  readonly categoryId: number;
  readonly categoryName: string;
  readonly definitionId: number;
  readonly key: string;
  readonly name: string;
  readonly style: ColorTriple;
  readonly aspects: readonly AspectEntry[];
}

export interface PackedParts {
  readonly typeId: number;
  readonly categoryId: number;
  readonly definitionId: number;
}

export type CardShape = "rect" | "hex";

interface CardTypesJson {
  types: Record<string, { id: number; shape?: CardShape }>;
  categories: Record<string, { id: number }>;
}

type RawCard = readonly [string, ColorTriple, readonly AspectEntry[]];

interface CardGroupJson {
  card_type: string;
  category: string;
  cards: Record<string, RawCard>;
}

const cardModules = import.meta.glob<{ default: CardGroupJson[] }>(
  "../data/cards/[0-9]*.json",
  { eager: true },
);

export class DefinitionManager {
  private readonly byPacked = new Map<number, CardDefinition>();
  private readonly typeNameById = new Map<number, string>();
  private readonly typeIdByName = new Map<string, number>();
  private readonly typeShapeById = new Map<number, CardShape>();
  private readonly categoryNameById = new Map<number, string>();
  private readonly categoryIdByName = new Map<string, number>();

  constructor() {
    const types = cardTypesData as unknown as CardTypesJson;
    if (!types || typeof types.types !== "object" || typeof types.categories !== "object") {
      throw new Error("[DefinitionManager] card_types.json missing types or categories object");
    }

    for (const [name, entry] of Object.entries(types.types)) {
      const id = entry?.id;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw new Error(`[DefinitionManager] card_types.json type "${name}" missing integer id`);
      }
      if (id < 0 || id > 0xf) {
        throw new Error(`[DefinitionManager] card_types.json type "${name}" id ${id} doesn't fit in u4 (0-15)`);
      }
      this.typeIdByName.set(name, id);
      this.typeNameById.set(id, name);
      if (entry.shape === "rect" || entry.shape === "hex") {
        this.typeShapeById.set(id, entry.shape);
      }
    }

    for (const [name, entry] of Object.entries(types.categories)) {
      const id = entry?.id;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw new Error(`[DefinitionManager] card_types.json category "${name}" missing integer id`);
      }
      if (id < 0 || id > 0xf) {
        throw new Error(`[DefinitionManager] card_types.json category "${name}" id ${id} doesn't fit in u4 (0-15)`);
      }
      this.categoryIdByName.set(name, id);
      this.categoryNameById.set(id, name);
    }

    this.loadCards();
  }

  static unpack(packed: number): PackedParts {
    return {
      typeId: (packed >>> 12) & 0xf,
      categoryId: (packed >>> 8) & 0xf,
      definitionId: packed & 0xff,
    };
  }

  static pack(typeId: number, categoryId: number, definitionId: number): number {
    return (
      ((typeId & 0xf) << 12) |
      ((categoryId & 0xf) << 8) |
      (definitionId & 0xff)
    );
  }

  decode(packed: number): CardDefinition | undefined {
    return this.byPacked.get(packed);
  }

  all(): readonly CardDefinition[] {
    return Array.from(this.byPacked.values());
  }

  typeName(typeId: number): string | undefined {
    return this.typeNameById.get(typeId);
  }

  /** Resolve a card-type name (e.g. `"discipline"`) to its u4 id. Used by
   *  RecipeManager to parse `"@<type>"` entity strings at recipe-build time
   *  — same role as `cards_registry().type_ids` on the server. */
  typeId(name: string): number | undefined {
    return this.typeIdByName.get(name);
  }

  categoryName(categoryId: number): string | undefined {
    return this.categoryNameById.get(categoryId);
  }

  shape(typeId: number): CardShape | undefined {
    return this.typeShapeById.get(typeId);
  }

  private loadCards(): void {
    const entries = Object.entries(cardModules);
    if (entries.length === 0) {
      console.warn(
        "[DefinitionManager] no card files matched ../data/cards/*.json — symlink missing?",
      );
      return;
    }

    const seenGroups = new Map<number, string>();

    for (const [path, module] of entries) {
      for (const group of module.default) {
        const typeId = this.typeIdByName.get(group.card_type);
        if (typeId === undefined) {
          console.warn(
            `[DefinitionManager] ${path}: unknown card_type "${group.card_type}", skipping group`,
          );
          continue;
        }
        const categoryId = this.categoryIdByName.get(group.category);
        if (categoryId === undefined) {
          console.warn(
            `[DefinitionManager] ${path}: unknown category "${group.category}", skipping group`,
          );
          continue;
        }

        const groupKey = (typeId << 4) | categoryId;
        const existingPath = seenGroups.get(groupKey);
        if (existingPath !== undefined) {
          throw new Error(
            `[DefinitionManager] duplicate (${group.card_type}, ${group.category}) group in ${path} — already declared in ${existingPath}`,
          );
        }
        seenGroups.set(groupKey, path);

        const typeName = this.typeNameById.get(typeId)!;
        const categoryName = this.categoryNameById.get(categoryId)!;

        const cardIds = cardIdsData as unknown as Record<string, Record<string, Record<string, number>>>;
        const groupIds = cardIds[group.card_type]?.[group.category];
        if (groupIds === undefined) {
          throw new Error(
            `[DefinitionManager] ${path}: no id.json entry for "${group.card_type}"/"${group.category}"`,
          );
        }
        for (const [key, raw] of Object.entries(group.cards)) {
          const definitionId = groupIds[key];
          if (definitionId === undefined) {
            throw new Error(
              `[DefinitionManager] ${path}: card "${key}" missing from data/cards/id.json under "${group.card_type}"/"${group.category}"`,
            );
          }
          const packed = DefinitionManager.pack(typeId, categoryId, definitionId);
          const [displayName, style, aspects] = raw;
          this.byPacked.set(packed, {
            packed,
            typeId,
            typeName,
            categoryId,
            categoryName,
            definitionId,
            key,
            name: displayName,
            style,
            aspects,
          });
        }
      }
    }
  }
}
