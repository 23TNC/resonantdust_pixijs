export type CardDefinitionStyle = {
  color: [string, string, string];
};

export type CardDefinitionVarValue = string | number | boolean | null;

export type CardDefinitionVars = Record<string, CardDefinitionVarValue>;

export type CardDefinitionFlag = [string, boolean, boolean, boolean];

export type CardDefinitionEntry = {
  name: string;
  style: CardDefinitionStyle;
  vars: CardDefinitionVars;
  flags: CardDefinitionFlag[];
};

export type CardDefinitionFile = {
  card_type: number;
  cards: CardDefinitionEntry[];
};

export type CardDefinitionTypeMap = Map<number, CardDefinitionEntry>;
export type CardDefinitionGlobalMap = Map<number, CardDefinitionTypeMap>;

const cardDefinitions: CardDefinitionGlobalMap = new Map();
let initialized = false;

export function unpackDefinition(definition: number): { card_type: number; definition_id: number } {
  return {
    card_type: (definition >>> 12) & 0x0f,
    definition_id: definition & 0x0fff,
  };
}

export function getDefinition(card_type: number, definition_id: number): CardDefinitionEntry | undefined {
  return cardDefinitions.get(card_type)?.get(definition_id);
}

export function getDefinitionByPacked(definition: number): CardDefinitionEntry | undefined {
  const { card_type, definition_id } = unpackDefinition(definition);
  return getDefinition(card_type, definition_id-1);
}

export function getCardDefinitions(): ReadonlyMap<number, ReadonlyMap<number, CardDefinitionEntry>> {
  return cardDefinitions;
}

export async function bootstrapCardDefinitions(): Promise<void> {
  
  if (initialized) {
    return;
  }
  
  const modules = import.meta.glob<CardDefinitionFile>("../cards/*.json", {
    eager: true,
    import: "default",
  });

  for (const fileData of Object.values(modules)) {
    if (!fileData.cards) {
      continue;
    }
    let typeMap = cardDefinitions.get(fileData.card_type);

    if (!typeMap) {
      typeMap = new Map<number, CardDefinitionEntry>();
      cardDefinitions.set(fileData.card_type, typeMap);
    }

    for (let definition_id = 0; definition_id < fileData.cards.length; definition_id += 1) {
      typeMap.set(definition_id, fileData.cards[definition_id]);
    }
  }

  initialized = true;
}
