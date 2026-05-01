import { deathState, dropLocalState } from "@/model/CardModel";

// ─── ID aliases ───────────────────────────────────────────────────────────────
export type CardId        = number;  // u32
export type PlayerId      = number;  // u32
export type ActionId      = number;  // u32
/** Numeric u32 macro_zone — panel: soul_card_id; world: [zone_q:i16][zone_r:i16]. */
export type MacroZone     = number;  // u32
export type MicroZone     = number;  // u8
export type MicroLocation = number;  // u32

// ─── Constants ────────────────────────────────────────────────────────────────
export const ZONE_SIZE = 8;

/// Layer values strictly less than this are panel layers; ≥ this are world.
export const PANEL_LAYER_MAX = 32;

/** Default panel layer for the player's primary inventory.  Mirrors
 *  `PANEL_LAYER_INVENTORY` in `packing.rs`. */
export const PANEL_LAYER_INVENTORY = 1;

/** Default world layer for the ground.  Mirrors `WORLD_LAYER_GROUND`. */
export const WORLD_LAYER_GROUND = 32;

export function isPanelLayer(layer: number): boolean { return layer < PANEL_LAYER_MAX; }
export function isWorldLayer(layer: number): boolean { return layer >= PANEL_LAYER_MAX; }

// ─── Flag bits (must mirror packing.rs) ──────────────────────────────────────
//
// Bit map:
//   0   STACKABLE
//   1   POSITION_LOCKED
//   2   POSITION_HOLD
//   3   SLOT_HOLD
//   4-5 reserved
//   6-7 STACK_STATE  (2-bit field)
//   8-15 reserved

export const CARD_FLAG_STACKABLE       = 1 << 0;
export const CARD_FLAG_POSITION_LOCKED = 1 << 1;
export const CARD_FLAG_POSITION_HOLD   = 1 << 2;
/** Set on every card claimed by a running action's slots.  Matcher excludes
 *  these from new recipes; movement reducers do NOT check this flag (drag-to-
 *  cancel is allowed). */
export const CARD_FLAG_SLOT_HOLD       = 1 << 3;

export const CARD_FLAG_STACK_STATE_MASK  = 0b11 << 6;
export const CARD_FLAG_STACK_STATE_SHIFT = 6;

export const STACK_STATE_LOOSE    = 0b00;
export const STACK_STATE_UP       = 0b01;
export const STACK_STATE_DOWN     = 0b10;
export const STACK_STATE_ATTACHED = 0b11;

export function stackStateFromFlags(flags: number): number {
  return (flags & CARD_FLAG_STACK_STATE_MASK) >>> CARD_FLAG_STACK_STATE_SHIFT;
}

export function withStackState(flags: number, state: number): number {
  return ((flags & ~CARD_FLAG_STACK_STATE_MASK) | ((state & 0b11) << CARD_FLAG_STACK_STATE_SHIFT)) >>> 0;
}

export function isStackedFlags(flags: number): boolean {
  const s = stackStateFromFlags(flags);
  return s === STACK_STATE_UP || s === STACK_STATE_DOWN;
}

/** Sentinel value of `micro_location` under `STACK_STATE_ATTACHED` meaning
 *  "attached to whatever hex card sits at my own (layer, macro_zone, micro_zone)." */
export const MICRO_ATTACHED_TO_FLOOR = 0;

// card_type values (high nibble of packed_definition) live in CardTypes.ts,
// loaded from data/card_types.json at bootstrap.  Re-exported here so existing
// `import { CARD_TYPE_X } from "@/spacetime/Data"` callers keep working.
export {
  CARD_TYPE_REQUISITES,
  CARD_TYPE_REVERY,
  CARD_TYPE_DISCIPLINE,
  CARD_TYPE_FACULTY,
  CARD_TYPE_SOUL,
  CARD_TYPE_FLOOR,
  CARD_TYPE_TILE_OBJECT,
  CARD_TYPE_TILE_DECORATOR,
  isDraggableCardType,
  isPassableCardType,
  isHexCardType,
  isRectCardType,
  getCardShape,
} from "@/definitions/CardTypes";

// ─── Server row types ─────────────────────────────────────────────────────────
// Mirror of SpacetimeDB table schemas. No derived fields.

export interface ServerCard {
  card_id:           CardId;
  layer:             number;            // u8 — panel (0..31) vs world (32..255)
  macro_zone:        MacroZone;         // u32 — panel: soul_id, world: [zone_q:i16][zone_r:i16]
  micro_zone:        MicroZone;         // u8  — [local_q:u3][local_r:u3][unused:u2]
  micro_location:    MicroLocation;     // u32, variant by stack_state in flags
  owner_id:          CardId;
  flags:             number;            // u16 — see CARD_FLAG_* + STACK_STATE bits 6-7
  packed_definition: number;            // u16 — [card_type:u4][category:u4][definition_id:u8]
  data:              bigint;            // u64, type-specific payload
  action_id:         number;            // u32, queued/running action on this card
}

export interface ServerPlayer {
  player_id:  PlayerId;
  name:       string;
  soul_id:    CardId;
  layer:      number;
  macro_zone: MacroZone;
  micro_zone: MicroZone;
}

export interface ServerAction {
  action_id:    ActionId;
  card_id:      CardId;
  recipe:       number;        // u16
  end:          number;        // u32 — completion time in seconds since Unix epoch (0 = queued)
  owner_id:     CardId;
  layer:        number;
  macro_zone:   MacroZone;
  micro_zone:   MicroZone;
  participants: number;        // u8 [up:4][down:4]
}

export interface ServerZone {
  layer:      number;
  macro_zone: MacroZone;
  definition: number;          // u8: [card_type:u4][category:u4]
  t0: bigint; t1: bigint; t2: bigint; t3: bigint;
  t4: bigint; t5: bigint; t6: bigint; t7: bigint;
}

// ─── Client row types ─────────────────────────────────────────────────────────
// Extends server rows with all packed fields pre-decoded. No re-unpacking needed.

export interface ClientCard extends ServerCard {
  // From packed_definition
  card_type:     number;
  category:      number;
  definition_id: number;
  // From flags / stack_state
  stack_state:     number;       // STACK_STATE_*
  loose:           boolean;      // stack_state == LOOSE
  stacked_up:      boolean;      // stack_state == UP
  stacked_down:    boolean;      // stack_state == DOWN
  attached:        boolean;      // stack_state == ATTACHED
  stackable:       boolean;
  position_locked: boolean;
  position_hold:   boolean;
  slot_hold:       boolean;
  // Parent / anchor references (depending on stack_state)
  /** When `stacked_up || stacked_down`: parent rect card_id (for chain walks).
   *  Otherwise 0. */
  stacked_on_id: CardId;
  /** When `attached && micro_location != 0`: the hex card_id we're anchored
   *  to.  When `attached && micro_location == 0`: 0 (floor at our own hex —
   *  resolved from zone data + materialized override at `(layer, macro_zone, micro_zone)`).
   *  Otherwise 0. */
  attached_to_id: CardId;
  /** True iff `attached && micro_location == 0` (anchor is the floor at our hex). */
  attached_to_floor: boolean;
  // Macro/micro zone decoded into legible coords
  is_panel:      boolean;        // layer < PANEL_LAYER_MAX
  is_world:      boolean;        // layer >= PANEL_LAYER_MAX
  zone_q:        number;         // is_world only
  zone_r:        number;         // is_world only
  panel_card_id: CardId;         // is_panel only (== macro_zone)
  local_q:       number;         // 0..7 — own micro_zone bits
  local_r:       number;         // 0..7
  // micro_location decoded by stack_state
  pixel_x:       number;         // LOOSE only
  pixel_y:       number;         // LOOSE only
  // Derived world coords (only meaningful when is_world)
  world_q: number;
  world_r: number;
  // Local UI state (dragging, animating, hidden, dead) lives in
  // model/CardModel.ts, keyed by card_id — not on this row.
}

export interface ClientPlayer extends ServerPlayer {
  is_panel:      boolean;
  is_world:      boolean;
  zone_q:        number;
  zone_r:        number;
  panel_card_id: CardId;
  local_q:       number;
  local_r:       number;
  world_q:       number;
  world_r:       number;
}

export interface ClientAction extends ServerAction {
  is_panel:      boolean;
  is_world:      boolean;
  zone_q:        number;
  zone_r:        number;
  panel_card_id: CardId;
  local_q:       number;
  local_r:       number;
  world_q:       number;
  world_r:       number;
  local_start:   number;
  /** Adjacency length consumed in the up branch (excludes actor). */
  participants_up:   number;
  /** Adjacency length consumed in the down branch (excludes actor). */
  participants_down: number;
}

export interface ClientZone extends ServerZone {
  zone_q: number;
  zone_r: number;
  // From definition
  card_type: number;
  category:  number;
  // Pre-decoded tile data — avoids re-decoding bigint rows every frame
  tile_definition_ids: number[][];  // [r][q] → raw byte (0–255)
  tile_definitions:    number[][];  // [r][q] → packed_definition for card lookup
}

// ─── macro_zone packing ───────────────────────────────────────────────────────
//
// World: [zone_q:i16][zone_r:i16]
// Panel: full u32 = soul_card_id

export function packMacroWorld(zone_q: number, zone_r: number): MacroZone {
  return (((zone_q & 0xFFFF) << 16) | (zone_r & 0xFFFF)) >>> 0;
}

export function packMacroPanel(soul_card_id: CardId): MacroZone {
  return soul_card_id >>> 0;
}

export function zoneQFromMacro(mz: MacroZone): number {
  const raw = (mz >>> 16) & 0xFFFF;
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

export function zoneRFromMacro(mz: MacroZone): number {
  const raw = mz & 0xFFFF;
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

export function soulIdFromMacro(mz: MacroZone): CardId { return mz >>> 0; }

// ─── micro_zone packing (u8) ──────────────────────────────────────────────────
//
// [local_q:u3][local_r:u3][unused:u2]

export function packMicroZone(local_q: number, local_r: number): MicroZone {
  return (((local_q & 0x07) << 5) | ((local_r & 0x07) << 2)) & 0xFF;
}

export function localQFromMicroZone(mz: MicroZone): number { return (mz >>> 5) & 0x07; }
export function localRFromMicroZone(mz: MicroZone): number { return (mz >>> 2) & 0x07; }

// ─── micro_location packing (u32) — variant by stack_state ────────────────────

export function packMicroPixel(pixel_x: number, pixel_y: number): MicroLocation {
  return (((pixel_x & 0xFFFF) << 16) | (pixel_y & 0xFFFF)) >>> 0;
}
export function pixelXFromMicro(micro: MicroLocation): number {
  const raw = (micro >>> 16) & 0xFFFF;
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}
export function pixelYFromMicro(micro: MicroLocation): number {
  const raw = micro & 0xFFFF;
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

export function packMicroParent(parent_card_id: CardId): MicroLocation { return parent_card_id >>> 0; }
export function packMicroAttached(hex_card_id: CardId): MicroLocation  { return hex_card_id >>> 0; }

// ─── packed_definition ────────────────────────────────────────────────────────
// [card_type:u4][category:u4][definition_id:u8]

export function packDefinition(card_type: number, category: number, definition_id: number): number {
  return (((card_type & 0xF) << 12) | ((category & 0xF) << 8) | (definition_id & 0xFF)) >>> 0;
}
export function cardTypeFromDefinition(def: number): number     { return (def >>> 12) & 0xF; }
export function categoryFromDefinition(def: number): number     { return (def >>> 8)  & 0xF; }
export function definitionIdFromDefinition(def: number): number { return  def         & 0xFF; }

// ─── Zone definition ──────────────────────────────────────────────────────────
// [card_type:u4][category:u4]

export function packZoneDefinition(card_type: number, category: number): number {
  return (((card_type & 0xF) << 4) | (category & 0xF)) >>> 0;
}
export function zoneCardTypeFromDefinition(def: number): number { return (def >>> 4) & 0xF; }
export function zoneCategoryFromDefinition(def: number): number { return  def        & 0xF; }

export function resolveZoneTileDefinition(zone_definition: number, tile_def_id: number): number {
  return packDefinition(
    zoneCardTypeFromDefinition(zone_definition),
    zoneCategoryFromDefinition(zone_definition),
    tile_def_id,
  );
}

// ─── Action helpers ───────────────────────────────────────────────────────────

export function isActionVisibleToSoul(action: ServerAction, soul_id: CardId): boolean {
  return action.owner_id === 0 || action.owner_id === soul_id;
}

export function isActionRunning(action: ServerAction): boolean {
  return action.end !== 0;
}

export function getActionProgress(action: ClientAction, now_seconds: number): number {
  if (!isActionRunning(action)) return 0;
  const duration = Math.max(1, action.end - action.local_start);
  return Math.min(1, Math.max(0, (now_seconds - action.local_start) / duration));
}

export function participantsUp(participants: number):   number { return (participants >>> 4) & 0x0F; }
export function participantsDown(participants: number): number { return  participants        & 0x0F; }

// ─── Server tables ────────────────────────────────────────────────────────────
// Written only by SpacetimeDB subscription callbacks (insert / update / delete).

export const server_cards:   Record<CardId,   ServerCard>   = {};
export const server_players: Record<PlayerId, ServerPlayer> = {};
export const server_actions: Record<ActionId, ServerAction> = {};
/** Zones keyed by composite `(layer, macro_zone)` packed into a JS number
 *  pair-key string.  Zone PK is `macro_zone`, but multiple layers may share
 *  a zone slot (sky/ground/underground). */
export const server_zones:   Map<string, ServerZone> = new Map();

// ─── Client tables ────────────────────────────────────────────────────────────
// Derived from server tables; all packed fields pre-decoded for fast reads.

export const client_cards:   Record<CardId,   ClientCard>   = {};
export const client_players: Record<PlayerId, ClientPlayer> = {};
export const client_actions: Record<ActionId, ClientAction> = {};
export const client_zones:   Map<string, ClientZone> = new Map();

/** Composite key for the zones map: `${layer}:${macro_zone}`.  Stable for use
 *  as a Map key without tuple support. */
export function zoneKey(layer: number, macro_zone: MacroZone): string {
  return `${layer}:${macro_zone >>> 0}`;
}

// ─── Secondary indexes ────────────────────────────────────────────────────────
// All keyed by macro_zone alone — within a single subscription scope, macro_zone
// uniquely identifies the (layer, macro_zone) bucket because:
//   - World zones at the same macro_zone share a layer (each zone is per-layer).
//   - Panel cards share macro_zone == soul_id and may span layers, but the
//     panel/world layer split is itself a discriminator at lookup time.

export const macro_zone_cards:   Map<MacroZone, Set<CardId>>   = new Map();
export const macro_zone_players: Map<MacroZone, Set<PlayerId>> = new Map();
export const macro_zone_actions: Map<MacroZone, Set<ActionId>> = new Map();

// Maps each parent rect card_id to the sets of children stacked on it, by direction.
export const stacked_up_children:   Map<CardId, Set<CardId>> = new Map();
export const stacked_down_children: Map<CardId, Set<CardId>> = new Map();

// Maps each hex card_id to the set of rect cards attached to it (state 11
// with micro_location != 0).
export const attached_to_hex_children: Map<CardId, Set<CardId>> = new Map();

// ─── Session state ────────────────────────────────────────────────────────────

export let player_id   = 0 as PlayerId;
export let player_name = "";
export let soul_id     = 0 as CardId;
export let observer_id = 0 as CardId;
export let viewed_id   = 0 as CardId;

export let selected_card_id = 0 as CardId;

export function setPlayerId(id: PlayerId):   void { player_id   = id; }
export function setPlayerName(n: string):    void { player_name = n; }
export function setSoulId(id: CardId):       void { soul_id     = id; }
export function setObserverId(id: CardId):   void { observer_id = id; }
export function setViewedId(id: CardId):     void { viewed_id   = id; }

export function setSelectedState(card_id: CardId): void { selected_card_id = card_id; }
export function clearSelectedState(): void              { selected_card_id = 0; }

// ─── Index helpers ────────────────────────────────────────────────────────────

function addToMacroIndex<T>(index: Map<MacroZone, Set<T>>, mz: MacroZone, id: T): void {
  let set = index.get(mz);
  if (!set) { set = new Set(); index.set(mz, set); }
  set.add(id);
}

function removeFromMacroIndex<T>(index: Map<MacroZone, Set<T>>, mz: MacroZone, id: T): void {
  const set = index.get(mz);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) index.delete(mz);
}

function addToParentIndex(index: Map<CardId, Set<CardId>>, parent_id: CardId, child_id: CardId): void {
  let set = index.get(parent_id);
  if (!set) { set = new Set(); index.set(parent_id, set); }
  set.add(child_id);
}

function removeFromParentIndex(index: Map<CardId, Set<CardId>>, parent_id: CardId, child_id: CardId): void {
  const set = index.get(parent_id);
  if (!set) return;
  set.delete(child_id);
  if (set.size === 0) index.delete(parent_id);
}

function stackIndexFor(stacked_up: boolean): Map<CardId, Set<CardId>> {
  return stacked_up ? stacked_up_children : stacked_down_children;
}

// ─── Client builders ──────────────────────────────────────────────────────────

export function buildClientCard(server: ServerCard): ClientCard {
  const flags        = server.flags;
  const state        = stackStateFromFlags(flags);
  const loose        = state === STACK_STATE_LOOSE;
  const stacked_up   = state === STACK_STATE_UP;
  const stacked_down = state === STACK_STATE_DOWN;
  const attached     = state === STACK_STATE_ATTACHED;
  const is_panel     = isPanelLayer(server.layer);
  const is_world     = isWorldLayer(server.layer);
  const stacked_on_id = (stacked_up || stacked_down) ? server.micro_location : 0;
  const attached_to_floor = attached && server.micro_location === MICRO_ATTACHED_TO_FLOOR;
  const attached_to_id    = attached && !attached_to_floor ? server.micro_location : 0;
  const local_q = localQFromMicroZone(server.micro_zone);
  const local_r = localRFromMicroZone(server.micro_zone);
  const zone_q  = is_world ? zoneQFromMacro(server.macro_zone) : 0;
  const zone_r  = is_world ? zoneRFromMacro(server.macro_zone) : 0;
  const panel_card_id = is_panel ? soulIdFromMacro(server.macro_zone) : 0;
  const pixel_x = loose ? pixelXFromMicro(server.micro_location) : 0;
  const pixel_y = loose ? pixelYFromMicro(server.micro_location) : 0;
  const world_q = is_world ? zone_q * ZONE_SIZE + local_q : 0;
  const world_r = is_world ? zone_r * ZONE_SIZE + local_r : 0;

  return {
    ...server,
    card_type:       cardTypeFromDefinition(server.packed_definition),
    category:        categoryFromDefinition(server.packed_definition),
    definition_id:   definitionIdFromDefinition(server.packed_definition),
    stack_state:     state,
    loose,
    stacked_up,
    stacked_down,
    attached,
    stackable:       (flags & CARD_FLAG_STACKABLE)       !== 0,
    position_locked: (flags & CARD_FLAG_POSITION_LOCKED) !== 0,
    position_hold:   (flags & CARD_FLAG_POSITION_HOLD)   !== 0,
    slot_hold:       (flags & CARD_FLAG_SLOT_HOLD)       !== 0,
    stacked_on_id,
    attached_to_id,
    attached_to_floor,
    is_panel,
    is_world,
    zone_q,
    zone_r,
    panel_card_id,
    local_q,
    local_r,
    pixel_x,
    pixel_y,
    world_q,
    world_r,
  };
}

export function buildClientPlayer(server: ServerPlayer): ClientPlayer {
  const is_panel      = isPanelLayer(server.layer);
  const is_world      = isWorldLayer(server.layer);
  const zone_q        = is_world ? zoneQFromMacro(server.macro_zone) : 0;
  const zone_r        = is_world ? zoneRFromMacro(server.macro_zone) : 0;
  const panel_card_id = is_panel ? soulIdFromMacro(server.macro_zone) : 0;
  const local_q       = localQFromMicroZone(server.micro_zone);
  const local_r       = localRFromMicroZone(server.micro_zone);
  const world_q       = is_world ? zone_q * ZONE_SIZE + local_q : 0;
  const world_r       = is_world ? zone_r * ZONE_SIZE + local_r : 0;
  return { ...server, is_panel, is_world, zone_q, zone_r, panel_card_id, local_q, local_r, world_q, world_r };
}

export function buildClientAction(server: ServerAction, local_start?: number): ClientAction {
  const is_panel      = isPanelLayer(server.layer);
  const is_world      = isWorldLayer(server.layer);
  const zone_q        = is_world ? zoneQFromMacro(server.macro_zone) : 0;
  const zone_r        = is_world ? zoneRFromMacro(server.macro_zone) : 0;
  const panel_card_id = is_panel ? soulIdFromMacro(server.macro_zone) : 0;
  const local_q       = localQFromMicroZone(server.micro_zone);
  const local_r       = localRFromMicroZone(server.micro_zone);
  const world_q       = is_world ? zone_q * ZONE_SIZE + local_q : 0;
  const world_r       = is_world ? zone_r * ZONE_SIZE + local_r : 0;
  return {
    ...server,
    is_panel, is_world, zone_q, zone_r, panel_card_id, local_q, local_r, world_q, world_r,
    local_start: local_start ?? Date.now() / 1000,
    participants_up:   participantsUp(server.participants),
    participants_down: participantsDown(server.participants),
  };
}

function decodeZoneRow(row: bigint): number[] {
  const ids: number[] = [];
  for (let q = 0; q < ZONE_SIZE; q++) ids.push(Number((row >> BigInt(q * 8)) & 0xFFn));
  return ids;
}

export function buildClientZone(server: ServerZone): ClientZone {
  const zone_q    = zoneQFromMacro(server.macro_zone);
  const zone_r    = zoneRFromMacro(server.macro_zone);
  const card_type = zoneCardTypeFromDefinition(server.definition);
  const category  = zoneCategoryFromDefinition(server.definition);

  const rows = [server.t0, server.t1, server.t2, server.t3, server.t4, server.t5, server.t6, server.t7];
  const tile_definition_ids = rows.map(decodeZoneRow);
  const tile_definitions    = tile_definition_ids.map((row) =>
    row.map((id) => resolveZoneTileDefinition(server.definition, id))
  );

  return { ...server, zone_q, zone_r, card_type, category, tile_definition_ids, tile_definitions };
}

// ─── Card-change notifier ─────────────────────────────────────────────────────

let _cardChangeNotifier: (cardId: CardId) => void = () => {};

export function bindCardChangeNotifier(fn: (cardId: CardId) => void): void {
  _cardChangeNotifier = fn;
}

function notifyCard(cardId: CardId): void {
  if (cardId !== 0) _cardChangeNotifier(cardId);
}

// ─── Deferred upserts ─────────────────────────────────────────────────────────

interface PendingUpsert {
  server:      ServerCard;
  /** The dying parent we're waiting on. */
  deferredFor: CardId;
}

const _pending_upserts:   Map<CardId, PendingUpsert> = new Map();
const _pending_by_parent: Map<CardId, Set<CardId>>   = new Map();

function _addPending(cardId: CardId, server: ServerCard, parentId: CardId): void {
  _removePending(cardId);
  _pending_upserts.set(cardId, { server, deferredFor: parentId });
  let set = _pending_by_parent.get(parentId);
  if (!set) { set = new Set(); _pending_by_parent.set(parentId, set); }
  set.add(cardId);
}

function _removePending(cardId: CardId): void {
  const existing = _pending_upserts.get(cardId);
  if (!existing) return;
  _pending_upserts.delete(cardId);
  const set = _pending_by_parent.get(existing.deferredFor);
  if (set) {
    set.delete(cardId);
    if (set.size === 0) _pending_by_parent.delete(existing.deferredFor);
  }
}

export function resolvePendingUpserts(parentId: CardId): void {
  const children = _pending_by_parent.get(parentId);
  if (!children) return;
  const snapshot = [...children];
  _pending_by_parent.delete(parentId);
  for (const childId of snapshot) {
    const pending = _pending_upserts.get(childId);
    if (!pending) continue;
    _pending_upserts.delete(childId);
    upsertClientCard(pending.server);
  }
}

export function hasPendingUpsert(cardId: CardId): boolean {
  return _pending_upserts.has(cardId);
}

export function clearPendingUpserts(): void {
  _pending_upserts.clear();
  _pending_by_parent.clear();
}

// ─── Upsert / remove ──────────────────────────────────────────────────────────

/** Reads the parent or anchor id implied by a server row's flags + micro_location.
 *  Returns 0 for loose / floor-attached cards. */
function parentishOf(server: ServerCard): CardId {
  const state = stackStateFromFlags(server.flags);
  if (state === STACK_STATE_UP || state === STACK_STATE_DOWN) return server.micro_location;
  if (state === STACK_STATE_ATTACHED && server.micro_location !== MICRO_ATTACHED_TO_FLOOR) return server.micro_location;
  return 0;
}

export function upsertClientCard(server: ServerCard): void {
  _removePending(server.card_id);

  // Defer if our current OR new parent is dying.
  const previous   = client_cards[server.card_id];
  const oldParent  = previous?.stacked_on_id ?? previous?.attached_to_id ?? 0;
  const newParent  = parentishOf(server);

  let dyingParent: CardId = 0;
  if (oldParent !== 0 && deathState(oldParent) === 1) dyingParent = oldParent;
  else if (newParent !== 0 && deathState(newParent) === 1) dyingParent = newParent;

  if (dyingParent !== 0) {
    _addPending(server.card_id, server, dyingParent);
    return;
  }

  if (previous && previous.macro_zone !== server.macro_zone) {
    removeFromMacroIndex(macro_zone_cards, previous.macro_zone, server.card_id);
  }
  const next = buildClientCard(server);
  client_cards[next.card_id] = next;
  addToMacroIndex(macro_zone_cards, next.macro_zone, next.card_id);

  // Stack-parent index (rect-on-rect chains)
  const old_stack_parent = previous?.stacked_on_id ?? 0;
  const old_up           = previous?.stacked_up   ?? false;
  const new_stack_parent = next.stacked_on_id;
  const new_up           = next.stacked_up;
  if (old_stack_parent !== new_stack_parent || old_up !== new_up) {
    if (old_stack_parent !== 0) removeFromParentIndex(stackIndexFor(old_up), old_stack_parent, next.card_id);
    if (new_stack_parent !== 0) addToParentIndex(stackIndexFor(new_up), new_stack_parent, next.card_id);
    notifyCard(old_stack_parent);
    notifyCard(new_stack_parent);
  }

  // Hex-attachment index (rect-on-hex anchors)
  const old_attach = previous?.attached_to_id ?? 0;
  const new_attach = next.attached_to_id;
  if (old_attach !== new_attach) {
    if (old_attach !== 0) removeFromParentIndex(attached_to_hex_children, old_attach, next.card_id);
    if (new_attach !== 0) addToParentIndex(attached_to_hex_children, new_attach, next.card_id);
    notifyCard(old_attach);
    notifyCard(new_attach);
  }

  notifyCard(next.card_id);
}

export function removeClientCard(card_id: CardId): void {
  const card = client_cards[card_id];
  if (!card) return;
  removeFromMacroIndex(macro_zone_cards, card.macro_zone, card_id);
  if (card.stacked_on_id !== 0) removeFromParentIndex(stackIndexFor(card.stacked_up), card.stacked_on_id, card_id);
  if (card.attached_to_id !== 0) removeFromParentIndex(attached_to_hex_children, card.attached_to_id, card_id);
  delete client_cards[card_id];
  _removePending(card_id);
  dropLocalState(card_id);
  notifyCard(card.stacked_on_id);
  notifyCard(card.attached_to_id);
}

export function upsertClientPlayer(server: ServerPlayer): void {
  const previous = client_players[server.player_id];
  if (previous && previous.macro_zone !== server.macro_zone) {
    removeFromMacroIndex(macro_zone_players, previous.macro_zone, server.player_id);
  }
  const next = buildClientPlayer(server);
  client_players[next.player_id] = next;
  addToMacroIndex(macro_zone_players, next.macro_zone, next.player_id);
}

export function removeClientPlayer(player_id: PlayerId): void {
  const player = client_players[player_id];
  if (!player) return;
  removeFromMacroIndex(macro_zone_players, player.macro_zone, player_id);
  delete client_players[player_id];
}

export function upsertClientAction(server: ServerAction): void {
  const previous = client_actions[server.action_id];
  if (previous && previous.macro_zone !== server.macro_zone) {
    removeFromMacroIndex(macro_zone_actions, previous.macro_zone, server.action_id);
  }
  const next = buildClientAction(server, previous?.local_start);
  client_actions[next.action_id] = next;
  addToMacroIndex(macro_zone_actions, next.macro_zone, next.action_id);
}

export function removeClientAction(action_id: ActionId): void {
  const action = client_actions[action_id];
  if (!action) return;
  removeFromMacroIndex(macro_zone_actions, action.macro_zone, action_id);
  delete client_actions[action_id];
}

export function upsertClientZone(server: ServerZone): void {
  client_zones.set(zoneKey(server.layer, server.macro_zone), buildClientZone(server));
}

export function removeClientZone(layer: number, macro_zone: MacroZone): void {
  client_zones.delete(zoneKey(layer, macro_zone));
}

// ─── Local mutation helpers ───────────────────────────────────────────────────
// For optimistic UI changes not yet published to the server (e.g. dragging).

/** Move a card to a free position as a LOOSE root.  Caller chooses whether
 *  the new position is panel (layer < 32, macro_zone = soul_id, micro_location =
 *  pixel coords) or world (layer >= 32, macro_zone = packed (zq, zr),
 *  micro_zone = packed (lq, lr)).  Clears stack state. */
export function moveClientCard(
  card_id:        CardId,
  layer:          number,
  macro_zone:     MacroZone,
  micro_zone:     MicroZone,
  micro_location: MicroLocation,
): void {
  const card = client_cards[card_id];
  if (!card) return;

  if (card.macro_zone !== macro_zone) {
    removeFromMacroIndex(macro_zone_cards, card.macro_zone, card_id);
  }

  const old_stack  = card.stacked_on_id;
  const old_attach = card.attached_to_id;
  const old_up     = card.stacked_up;

  card.layer          = layer;
  card.macro_zone     = macro_zone;
  card.micro_zone     = micro_zone;
  card.micro_location = micro_location;
  card.flags          = withStackState(card.flags, STACK_STATE_LOOSE);

  // Refresh derived fields
  Object.assign(card, buildClientCard(card));

  if (old_stack  !== 0) removeFromParentIndex(stackIndexFor(old_up), old_stack, card_id);
  if (old_attach !== 0) removeFromParentIndex(attached_to_hex_children, old_attach, card_id);

  addToMacroIndex(macro_zone_cards, macro_zone, card_id);
  notifyCard(old_stack);
  notifyCard(old_attach);
  notifyCard(card_id);
}

function applyStackClientCard(card_id: CardId, onto_id: CardId, stacked_up: boolean): void {
  const card   = client_cards[card_id];
  const parent = client_cards[onto_id];
  if (!card || !parent) return;

  const old_stack  = card.stacked_on_id;
  const old_attach = card.attached_to_id;
  const old_up     = card.stacked_up;

  if (card.macro_zone !== parent.macro_zone) {
    removeFromMacroIndex(macro_zone_cards, card.macro_zone, card_id);
  }
  if (old_stack  !== 0 && (old_stack  !== onto_id || old_up !== stacked_up)) {
    removeFromParentIndex(stackIndexFor(old_up), old_stack, card_id);
  }
  if (old_attach !== 0) {
    removeFromParentIndex(attached_to_hex_children, old_attach, card_id);
  }

  card.layer          = parent.layer;
  card.macro_zone     = parent.macro_zone;
  card.micro_zone     = parent.micro_zone;
  card.micro_location = packMicroParent(onto_id);
  card.flags          = withStackState(card.flags, stacked_up ? STACK_STATE_UP : STACK_STATE_DOWN);

  Object.assign(card, buildClientCard(card));

  addToMacroIndex(macro_zone_cards, card.macro_zone, card_id);
  if (card.stacked_on_id !== 0) addToParentIndex(stackIndexFor(stacked_up), onto_id, card_id);

  if (old_stack !== onto_id) notifyCard(old_stack);
  if (old_attach !== 0)      notifyCard(old_attach);
  notifyCard(onto_id);
  notifyCard(card_id);
}

export function stackClientCardUp(card_id: CardId, onto_id: CardId):   void { applyStackClientCard(card_id, onto_id, true);  }
export function stackClientCardDown(card_id: CardId, onto_id: CardId): void { applyStackClientCard(card_id, onto_id, false); }

/** Optimistically attach `card_id` as an ATTACHED root onto a hex card. */
export function attachClientCardToHex(card_id: CardId, hex_card_id: CardId): void {
  const card = client_cards[card_id];
  const hex  = client_cards[hex_card_id];
  if (!card || !hex) return;

  const old_stack  = card.stacked_on_id;
  const old_attach = card.attached_to_id;

  if (card.macro_zone !== hex.macro_zone) {
    removeFromMacroIndex(macro_zone_cards, card.macro_zone, card_id);
  }
  if (old_stack  !== 0) removeFromParentIndex(stackIndexFor(card.stacked_up), old_stack, card_id);
  if (old_attach !== 0 && old_attach !== hex_card_id) {
    removeFromParentIndex(attached_to_hex_children, old_attach, card_id);
  }

  card.layer          = hex.layer;
  card.macro_zone     = hex.macro_zone;
  card.micro_zone     = hex.micro_zone;
  card.micro_location = packMicroAttached(hex_card_id);
  card.flags          = withStackState(card.flags, STACK_STATE_ATTACHED);

  Object.assign(card, buildClientCard(card));

  addToMacroIndex(macro_zone_cards, card.macro_zone, card_id);
  if (card.attached_to_id !== 0 && old_attach !== hex_card_id) {
    addToParentIndex(attached_to_hex_children, hex_card_id, card_id);
  }

  if (old_stack  !== 0) notifyCard(old_stack);
  if (old_attach !== 0 && old_attach !== hex_card_id) notifyCard(old_attach);
  notifyCard(hex_card_id);
  notifyCard(card_id);
}

// ─── Bulk sync from server tables ─────────────────────────────────────────────

export function syncClientCardsFromServer(): void {
  for (const k in server_cards) upsertClientCard(server_cards[Number(k)]);
  for (const k in client_cards) { const id = Number(k); if (!(id in server_cards)) removeClientCard(id); }
}

export function syncClientPlayersFromServer(): void {
  for (const k in server_players) upsertClientPlayer(server_players[Number(k)]);
  for (const k in client_players) { const id = Number(k); if (!(id in server_players)) removeClientPlayer(id); }
}

export function syncClientActionsFromServer(): void {
  for (const k in server_actions) upsertClientAction(server_actions[Number(k)]);
  for (const k in client_actions) { const id = Number(k); if (!(id in server_actions)) removeClientAction(id); }
}

export function syncClientZonesFromServer(): void {
  for (const zone of server_zones.values()) upsertClientZone(zone);
  for (const key of client_zones.keys()) {
    if (!server_zones.has(key)) {
      const z = client_zones.get(key)!;
      removeClientZone(z.layer, z.macro_zone);
    }
  }
}
