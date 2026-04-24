import disciplineCards from "./discipline.json";
import facultyCards from "./faculty.json";
import soulCards from "./soul.json";
import tileCards from "./tile.json";

type DefinitionStyle = {
  color?: Array<number | string>;
};

export type CardDefinition = {
  name?: string;
  style?: DefinitionStyle;
  vars?: Record<string, string | number | boolean | null>;
  flags?: Array<[string, boolean, boolean, boolean]>;
};

type CardDefinitionJsonEntry = CardDefinition & {
  id?: number;
  definition_id?: number;
};

type CardDefinitionJsonFile = {
  card_type: number;
  cards: CardDefinitionJsonEntry[];
};

const definitionFiles: CardDefinitionJsonFile[] = [
  disciplineCards,
  facultyCards,
  soulCards,
  tileCards,
];

const definitionRegistry: Record<number, CardDefinition> = Object.create(null);

function packDefinition(card_type: number, definition_id: number): number {
  return (((card_type & 0x0f) << 12) | (definition_id & 0x0fff)) >>> 0;
}

function resolveDefinitionId(entry: CardDefinitionJsonEntry, index: number): number {
  if (Number.isInteger(entry.definition_id) && entry.definition_id! > 0) {
    return entry.definition_id!;
  }

  if (Number.isInteger(entry.id) && entry.id! > 0) {
    return entry.id!;
  }

  return index + 1;
}

function buildDefinitionRegistry(): void {
  for (const file of definitionFiles) {
    for (let index = 0; index < file.cards.length; index += 1) {
      const sourceEntry = file.cards[index];
      const definition_id = resolveDefinitionId(sourceEntry, index);
      const definition = packDefinition(file.card_type, definition_id);

      const { id: _ignoredId, definition_id: _ignoredDefinitionId, ...entry } = sourceEntry;
      definitionRegistry[definition] = entry;
    }
  }
}

buildDefinitionRegistry();

export function getCardDefinition(definition: number): CardDefinition | undefined {
  return definitionRegistry[definition];
}

export function getCardDefinitions(): Readonly<Record<number, CardDefinition>> {
  return definitionRegistry;
}
