import { client_cards, type CardId } from "@/spacetime/Data";

/**
 * Card flag tuple: [name, a, b, c].
 * The three booleans are game-rule semantics defined per card type.
 */
export type CardFlag = [name: string, a: boolean, b: boolean, c: boolean];

export interface CardStyle {
  /** Ordered color palette for this card. Length varies by card type. */
  color: string[];
}

export interface CardDefinition {
  name:            string;
  style?:          CardStyle;
  vars?:           Record<string, string | number | boolean | null>;
  flags?:          CardFlag[];
  title_on_bottom?: boolean;
}

interface CardDefinitionFile {
  card_type: number;
  cards: CardDefinition[];
}

// Keyed by packed definition: ((card_type & 0xf) << 12) | (definition_id & 0xfff)
const registry = new Map<number, CardDefinition>();

function pack(card_type: number, definition_id: number): number {
  return (((card_type & 0xf) << 12) | (definition_id & 0xfff)) >>> 0;
}

/**
 * Load all JSON files from src/data/cards/ into the registry.
 * Cards are 1-indexed within each file: cards[0] → definition_id 1, cards[1] → 2, etc.
 * Call once at startup before accessing any definitions.
 */
export function bootstrapCardDefinitions(): void {
  if (registry.size > 0) return;

  const files = import.meta.glob<CardDefinitionFile>("../cards/*.json", {
    eager: true,
    import: "default",
  });

  for (const file of Object.values(files)) {
    if (!Array.isArray(file.cards)) continue;

    for (let i = 0; i < file.cards.length; i++) {
      const definition_id = i + 1; // 1-based to match the packed wire format
      registry.set(pack(file.card_type, definition_id), file.cards[i]);
    }
  }
}

export function getDefinition(card_type: number, definition_id: number): CardDefinition | undefined {
  return registry.get(pack(card_type, definition_id));
}

export function getDefinitionByPacked(packed: number): CardDefinition | undefined {
  return registry.get(packed);
}

export function getRegistry(): ReadonlyMap<number, CardDefinition> {
  return registry;
}

// ─── Per-card title helpers ──────────────────────────────────────────────────

/** True iff the card's definition has title_on_bottom set. Missing card or definition → false. */
export function isBottomTitleByDef(cardId: CardId): boolean {
  const c = client_cards[cardId];
  if (!c) return false;
  return getDefinitionByPacked(c.packed_definition)?.title_on_bottom ?? false;
}

/**
 * Effective title-on-bottom for a card: stacked_down → true, stacked_up →
 * false, otherwise the definition's title_on_bottom value.  Mirrors the rule
 * Card.redraw applies, so renderers and consumers (DragManager, etc.) agree
 * on what edge a card visually presents its title.
 * Missing card → false.
 */
export function getEffectiveTitleOnBottom(cardId: CardId): boolean {
  const c = client_cards[cardId];
  if (!c) return false;
  if (c.stacked_down) return true;
  if (c.stacked_up)   return false;
  return getDefinitionByPacked(c.packed_definition)?.title_on_bottom ?? false;
}
