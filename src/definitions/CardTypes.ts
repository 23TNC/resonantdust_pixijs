// Card type registry — values come from data/card_types.json at bootstrap.
// The constants below are `let` bindings that exist for ergonomic call sites
// (`case CARD_TYPE_SOUL:` reads better than `case getCardTypeId('soul'):`).
// They are populated by `bootstrapCardTypes()`, which must run before any
// code that depends on the actual numeric values.

import cardTypesJson from "@/data/card_types.json";

// ─── Public re-exports populated at bootstrap ────────────────────────────────

export let CARD_TYPE_REQUISITES     = 0;
export let CARD_TYPE_REVERY         = 0;
export let CARD_TYPE_DISCIPLINE     = 0;
export let CARD_TYPE_FACULTY        = 0;
export let CARD_TYPE_SOUL           = 0;
export let CARD_TYPE_FLOOR          = 0;
export let CARD_TYPE_TILE_OBJECT    = 0;
export let CARD_TYPE_TILE_DECORATOR = 0;

// Visibility partition is encoded by `id < PUBLIC_MAX_ID + 1`.
// Subscriptions use `packed_definition < (1 << (12 + log2(PUBLIC_MAX_ID + 1)))`
// — but PUBLIC_MAX_ID is fixed at 3 (4 public slots) so the cutoff is 0x4000.
export const PUBLIC_MAX_ID = 3;
export const PUBLIC_PACKED_DEFINITION_CUTOFF = 0x4000;

// ─── Internal registry ──────────────────────────────────────────────────────

export type CardShape = "rect" | "hex";

interface CardTypeEntry {
  id:         number;
  visibility: "public" | "private";
  shape:      CardShape;
}

interface CardTypesFile {
  _comment?: string;
  _rules?: {
    public_max_id?:     number;
    max_id?:            number;
    subscription_mask?: string;
    shapes?:            string[];
  };
  types: Record<string, CardTypeEntry & { _comment?: string }>;
}

const _by_name = new Map<string, CardTypeEntry>();
const _by_id   = new Map<number, string>();

// Predicate sets populated at bootstrap.  Set membership replaces the old
// "card_type within numeric range" check, which broke under the renumbering
// (the new ids are not contiguous within any meaningful semantic group).
const _draggable = new Set<number>();
const _passable  = new Set<number>();
const _hex_types  = new Set<number>();
const _rect_types = new Set<number>();

let _bootstrapped = false;

// ─── Public API ─────────────────────────────────────────────────────────────

/** Look up a type id by canonical name (e.g. "discipline" → 4). */
export function getCardTypeId(name: string): number | undefined {
  return _by_name.get(name)?.id;
}

/** Inverse — look up the canonical name for an id (4 → "discipline"). */
export function getCardTypeName(id: number): string | undefined {
  return _by_id.get(id);
}

/** True iff the type at this id is in the public partition (visible across players). */
export function isPublicCardType(id: number): boolean {
  return id < PUBLIC_MAX_ID + 1;
}

/** Card types that participate in drag-and-drop pickup (inventory-resident cards). */
export function isDraggableCardType(card_type: number): boolean {
  return _draggable.has(card_type);
}

/** Card types that are part of the floor and don't block hex drop targets. */
export function isPassableCardType(card_type: number): boolean {
  return _passable.has(card_type);
}

/** True iff the card type is drawn as a hexagon (and may serve as an attachment anchor). */
export function isHexCardType(card_type: number): boolean {
  return _hex_types.has(card_type);
}

/** True iff the card type is drawn as a rectangle (forms RectCard chains). */
export function isRectCardType(card_type: number): boolean {
  return _rect_types.has(card_type);
}

/** Look up the shape of a card type. Returns undefined for unknown ids. */
export function getCardShape(card_type: number): CardShape | undefined {
  if (_hex_types.has(card_type))  return "hex";
  if (_rect_types.has(card_type)) return "rect";
  return undefined;
}

/**
 * Load card types from data/card_types.json.  Validates that each entry's
 * `visibility` field matches the `id < 4` derivation; throws on mismatch
 * to surface authoring errors at startup.
 *
 * Idempotent — repeat calls are no-ops.
 */
export function bootstrapCardTypes(): void {
  if (_bootstrapped) return;
  _bootstrapped = true;

  const file = cardTypesJson as CardTypesFile;
  if (!file?.types) {
    throw new Error("card_types.json: missing 'types' field");
  }

  for (const [name, entry] of Object.entries(file.types)) {
    if (typeof entry?.id !== "number") {
      throw new Error(`card_types.json: type '${name}' missing numeric id`);
    }
    if (entry.visibility !== "public" && entry.visibility !== "private") {
      throw new Error(`card_types.json: type '${name}' has invalid visibility '${entry.visibility}'`);
    }
    const expectedVis = isPublicCardType(entry.id) ? "public" : "private";
    if (entry.visibility !== expectedVis) {
      throw new Error(
        `card_types.json: type '${name}' (id ${entry.id}) declares visibility '${entry.visibility}' ` +
        `but bit cutoff (id < ${PUBLIC_MAX_ID + 1}) implies '${expectedVis}'`,
      );
    }
    if (entry.shape !== "rect" && entry.shape !== "hex") {
      throw new Error(`card_types.json: type '${name}' has invalid shape '${entry.shape}' (expected 'rect' or 'hex')`);
    }
    if (_by_id.has(entry.id)) {
      throw new Error(
        `card_types.json: id ${entry.id} appears on both '${_by_id.get(entry.id)}' and '${name}'`,
      );
    }
    _by_name.set(name, { id: entry.id, visibility: entry.visibility, shape: entry.shape });
    _by_id.set(entry.id, name);
  }

  // Populate the named exports.  Reserved slots stay 0 (unassigned).
  CARD_TYPE_REQUISITES     = _required("requisites");
  CARD_TYPE_REVERY         = _required("revery");
  CARD_TYPE_DISCIPLINE     = _required("discipline");
  CARD_TYPE_FACULTY        = _required("faculty");
  CARD_TYPE_SOUL           = _required("soul");
  CARD_TYPE_FLOOR          = _required("floor");
  CARD_TYPE_TILE_OBJECT    = _required("tile_object");
  CARD_TYPE_TILE_DECORATOR = _required("tile_decorator");

  // Predicate sets — explicit semantic membership, not numeric ranges.
  _draggable.clear();
  _draggable.add(CARD_TYPE_REQUISITES);
  _draggable.add(CARD_TYPE_REVERY);
  _draggable.add(CARD_TYPE_DISCIPLINE);
  _draggable.add(CARD_TYPE_FACULTY);

  _passable.clear();
  _passable.add(CARD_TYPE_FLOOR);
  _passable.add(CARD_TYPE_TILE_OBJECT);
  _passable.add(CARD_TYPE_TILE_DECORATOR);

  _hex_types.clear();
  _rect_types.clear();
  for (const entry of _by_name.values()) {
    if (entry.shape === "hex")  _hex_types.add(entry.id);
    if (entry.shape === "rect") _rect_types.add(entry.id);
  }
}

function _required(name: string): number {
  const id = _by_name.get(name)?.id;
  if (id === undefined) throw new Error(`card_types.json: required type '${name}' not present`);
  return id;
}
