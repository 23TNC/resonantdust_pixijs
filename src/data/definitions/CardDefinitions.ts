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

/**
 * Names of all supported card abilities.  Each ability claims a fixed slice
 * of bits within the card's u64 `data` field, allocated in the order the
 * card's definition lists them.  Adding a new ability:
 *   1. Add the name to AbilityName.
 *   2. Add an entry to ABILITY_SPECS giving its bit width.
 *   3. (Optionally) add a typed convenience reader/writer.
 */
export type AbilityName = "fleeting" | "card_target";

interface AbilitySpec {
  /** Number of bits this ability consumes within the card's u64 data. */
  width: number;
}

const ABILITY_SPECS: Readonly<Record<AbilityName, AbilitySpec>> = {
  /** Absolute expiry time (32 bits) — the card disappears at/after this tick. */
  fleeting:    { width: 32 },
  /** Target card id (32 bits) — e.g. a soul-reference card pointing at a soul. */
  card_target: { width: 32 },
};

export interface CardDefinition {
  name:            string;
  style?:          CardStyle;
  vars?:           Record<string, string | number | boolean | null>;
  flags?:          CardFlag[];
  /** Ordered list of abilities this card has.  Bits within `data` are
   *  allocated in declaration order: the first ability occupies the
   *  low-order bits, the next claims the bits above it, and so on. */
  abilities?:       AbilityName[];
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

// ─── Ability accessors ──────────────────────────────────────────────────────

/**
 * Locate an ability's bit slice within a card's `data` field, given the
 * card's definition.  Returns the offset and the masked, unshifted value
 * already extracted, or undefined if the card lacks the ability.
 */
function readAbilitySlice(
  data:       bigint,
  abilities:  AbilityName[],
  ability:    AbilityName,
): bigint | undefined {
  let offset = 0;
  for (const a of abilities) {
    const spec = ABILITY_SPECS[a];
    if (a === ability) {
      const mask = (1n << BigInt(spec.width)) - 1n;
      return (data >> BigInt(offset)) & mask;
    }
    offset += spec.width;
  }
  return undefined;
}

/**
 * Read an ability's value from a card's `data` as a JS number.  Returns
 * undefined if the card has no definition or the ability isn't declared on
 * it.  All currently-defined abilities fit in 32 bits, so a JS number is
 * lossless.
 */
export function getAbilityValue(cardId: CardId, ability: AbilityName): number | undefined {
  const c = client_cards[cardId];
  if (!c) return undefined;
  const def = getDefinitionByPacked(c.packed_definition);
  if (!def?.abilities) return undefined;
  const v = readAbilitySlice(c.data, def.abilities, ability);
  return v === undefined ? undefined : Number(v);
}

/**
 * Write an ability's value into a card's `data`, replacing only that
 * ability's bit slice.  Returns true on success, false if the card or the
 * ability isn't on its definition.  This mutates client_cards[id].data
 * locally; sending the change to the server is the caller's responsibility.
 */
export function setAbilityValue(cardId: CardId, ability: AbilityName, value: number): boolean {
  const c = client_cards[cardId];
  if (!c) return false;
  const def = getDefinitionByPacked(c.packed_definition);
  if (!def?.abilities) return false;

  let offset = 0;
  for (const a of def.abilities) {
    const spec = ABILITY_SPECS[a];
    if (a === ability) {
      const mask    = (1n << BigInt(spec.width)) - 1n;
      const slot    = mask << BigInt(offset);
      const payload = (BigInt(value) & mask) << BigInt(offset);
      c.data = (c.data & ~slot) | payload;
      return true;
    }
    offset += spec.width;
  }
  return false;
}

/** True iff the card's definition declares the named ability. */
export function hasAbility(cardId: CardId, ability: AbilityName): boolean {
  const c = client_cards[cardId];
  if (!c) return false;
  const def = getDefinitionByPacked(c.packed_definition);
  return !!def?.abilities?.includes(ability);
}

// ─── Typed convenience accessors ────────────────────────────────────────────

/** Absolute expiry time of a fleeting card (undefined if not fleeting). */
export function getFleetingExpiry(cardId: CardId): number | undefined {
  return getAbilityValue(cardId, "fleeting");
}

export function setFleetingExpiry(cardId: CardId, expiry: number): boolean {
  return setAbilityValue(cardId, "fleeting", expiry);
}

/** Target CardId for a card with the card_target ability (e.g. soul reference). */
export function getCardTarget(cardId: CardId): CardId | undefined {
  return getAbilityValue(cardId, "card_target") as CardId | undefined;
}

export function setCardTarget(cardId: CardId, target: CardId): boolean {
  return setAbilityValue(cardId, "card_target", target);
}
