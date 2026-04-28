// ─── ID aliases ───────────────────────────────────────────────────────────────
export type CardId        = number;  // u32
export type PlayerId      = number;  // u32
export type ActionId      = number;  // u32
export type MacroLocation = bigint;  // u64
export type MicroLocation = number;  // u32

// ─── Constants ────────────────────────────────────────────────────────────────
export const ZONE_SIZE = 8;

// macro_location surface discriminants
export const SURFACE_WORLD = 1;
export const SURFACE_PANEL = 2;

// card flags — bits within ServerCard.flags
export const CARD_FLAG_STACKED_UP      = 1 << 0;  // child above its parent
export const CARD_FLAG_STACKED_DOWN    = 1 << 1;  // child below its parent
export const CARD_FLAG_STACKABLE       = 1 << 2;
export const CARD_FLAG_POSITION_LOCKED = 1 << 3;
export const CARD_FLAG_POSITION_HOLD   = 1 << 4;

// action flags — bits within ServerAction.flags
export const ACTION_FLAG_STARTED   = 1 << 0;
export const ACTION_FLAG_COMPLETED = 1 << 1;

// card_type values (high nibble of packed_definition)
export const CARD_TYPE_DISCIPLINE     = 1;
export const CARD_TYPE_FACULTY        = 2;
export const CARD_TYPE_REQUISITES     = 3;
export const CARD_TYPE_REVERY         = 4;
export const CARD_TYPE_SOUL           = 5;
export const CARD_TYPE_TILE           = 6;
export const CARD_TYPE_TILE_OBJECT    = 7;
export const CARD_TYPE_TILE_DECORATOR = 8;

/** Card types that participate in drag-and-drop pickup. */
export function isDraggableCardType(card_type: number): boolean {
  return card_type >= CARD_TYPE_DISCIPLINE && card_type <= CARD_TYPE_REVERY;
}

/** Card types that are part of the floor and don't block hex drop targets. */
export function isPassableCardType(card_type: number): boolean {
  return card_type === CARD_TYPE_TILE
      || card_type === CARD_TYPE_TILE_OBJECT
      || card_type === CARD_TYPE_TILE_DECORATOR;
}

// ─── Server row types ─────────────────────────────────────────────────────────
// Mirror of SpacetimeDB table schemas. No derived fields.

export interface ServerCard {
  card_id:           CardId;
  macro_location:    MacroLocation;    // surface=1: world zone | surface=2: soul panel
  micro_location:    MicroLocation;    // stacked_id | hex [q:u4][r:u4] | pixel [x:i16][y:i16]
  owner_id:          CardId;
  flags:             number;           // u16
  packed_definition: number;           // u16: [card_type:u4][category:u4][definition_id:u8]
  data:              bigint;           // u64, type-specific payload
}

export interface ServerPlayer {
  player_id:      PlayerId;
  name:           string;
  soul_id:        CardId;
  macro_location: MacroLocation;
  micro_location: MicroLocation;
}

export interface ServerAction {
  action_id:      ActionId;
  card_id:        CardId;
  recipe:         number;              // u16
  start:          number;              // u32
  end:            number;              // u32
  flags:          number;              // u8
  owner_id:       CardId;
  macro_location: MacroLocation;
  micro_location: MicroLocation;
}

export interface ServerZone {
  macro_location: MacroLocation;
  definition:     number;              // u8: [card_type:u4][category:u4]
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
  // From flags
  stacked_up:      boolean;
  stacked_down:    boolean;
  stackable:       boolean;
  position_locked: boolean;
  position_hold:   boolean;
  // From macro_location
  surface:       number;
  layer:         number;
  zone_q:        number;       // surface=1 only
  zone_r:        number;       // surface=1 only
  panel_card_id: CardId;       // surface=2 only
  // From micro_location — mode determined by surface (and stacked flag for cards)
  stacked_on_id: CardId;       // CARD_FLAG_STACKED: full u32 = parent card_id
  local_q:       number;       // surface=1, not stacked: hex [q:u4]
  local_r:       number;       // surface=1, not stacked: hex [r:u4]
  pixel_x:       number;       // surface=2, not stacked: pixel [x:i16]
  pixel_y:       number;       // surface=2, not stacked: pixel [y:i16]
  // Derived
  world_q: number;             // surface=1, not stacked
  world_r: number;             // surface=1, not stacked
  // Local UI state — not server-authoritative
  selected:  boolean;
  dragging:  boolean;
  returning: boolean;
  hidden:    boolean;
  stale:     boolean;
  dirty:     boolean;
}

export interface ClientPlayer extends ServerPlayer {
  surface:       number;
  layer:         number;
  zone_q:        number;
  zone_r:        number;
  panel_card_id: CardId;
  local_q:       number;       // surface=1: hex [q:u4]
  local_r:       number;       // surface=1: hex [r:u4]
  pixel_x:       number;       // surface=2: pixel [x:i16]
  pixel_y:       number;       // surface=2: pixel [y:i16]
  world_q:       number;
  world_r:       number;
  stale: boolean;
  dirty: boolean;
}

export interface ClientAction extends ServerAction {
  surface:       number;
  layer:         number;
  zone_q:        number;
  zone_r:        number;
  panel_card_id: CardId;
  local_q:       number;       // surface=1: hex [q:u4]
  local_r:       number;       // surface=1: hex [r:u4]
  pixel_x:       number;       // surface=2: pixel [x:i16]
  pixel_y:       number;       // surface=2: pixel [y:i16]
  world_q:       number;
  world_r:       number;
  stale: boolean;
  dirty: boolean;
}

export interface ClientZone extends ServerZone {
  // From macro_location (zones are always surface=1)
  zone_q: number;
  zone_r: number;
  layer:  number;
  // From definition
  card_type: number;
  category:  number;
  // Pre-decoded tile data — avoids re-decoding bigint rows every frame
  tile_definition_ids: number[][];  // [r][q] → raw byte (0–255)
  tile_definitions:    number[][];  // [r][q] → packed_definition for card lookup
  stale: boolean;
  dirty: boolean;
}

// ─── macro_location packing ───────────────────────────────────────────────────
// surface=1 (world): [zone_q:i16][zone_r:i16][reserved:u16][layer:u8][1:u8]
// surface=2 (panel): [card_id:u32][reserved:u16][layer:u8][2:u8]

export function packMacroWorld(zone_q: number, zone_r: number, layer: number): MacroLocation {
  return (BigInt(zone_q & 0xFFFF) << 48n)
       | (BigInt(zone_r & 0xFFFF) << 32n)
       | (BigInt(layer & 0xFF) << 8n)
       | 1n;
}

export function packMacroPanel(card_id: CardId, layer: number): MacroLocation {
  return (BigInt(card_id) << 32n) | (BigInt(layer & 0xFF) << 8n) | 2n;
}

export function surfaceFromMacro(loc: MacroLocation): number { return Number(loc & 0xFFn); }
export function layerFromMacro(loc: MacroLocation): number   { return Number((loc >> 8n) & 0xFFn); }

export function zoneQFromMacro(loc: MacroLocation): number {
  const raw = Number((loc >> 48n) & 0xFFFFn);
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

export function zoneRFromMacro(loc: MacroLocation): number {
  const raw = Number((loc >> 32n) & 0xFFFFn);
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

export function cardIdFromMacro(loc: MacroLocation): CardId {
  return Number((loc >> 32n) & 0xFFFFFFFFn);
}

// ─── micro_location packing ───────────────────────────────────────────────────

// Stacked: full u32 = stacked_id (the card this one rests on)
export function packMicroStacked(stacked_id: CardId): MicroLocation { return stacked_id >>> 0; }

// Hex: [local_q:u4][local_r:u4][reserved:u24]
export function packMicroHex(local_q: number, local_r: number): MicroLocation {
  return (((local_q & 0xF) << 28) | ((local_r & 0xF) << 24)) >>> 0;
}
export function localQFromMicro(micro: MicroLocation): number { return (micro >>> 28) & 0xF; }
export function localRFromMicro(micro: MicroLocation): number { return (micro >>> 24) & 0xF; }

// Pixel: [local_x:i16][local_y:i16]
export function packMicroPixel(x: number, y: number): MicroLocation {
  return (((x & 0xFFFF) << 16) | (y & 0xFFFF)) >>> 0;
}
export function pixelXFromMicro(micro: MicroLocation): number {
  const raw = (micro >>> 16) & 0xFFFF;
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}
export function pixelYFromMicro(micro: MicroLocation): number {
  const raw = micro & 0xFFFF;
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

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
  return (action.flags & ACTION_FLAG_STARTED)   !== 0
      && (action.flags & ACTION_FLAG_COMPLETED) === 0;
}

export function getActionProgress(action: ServerAction, now_seconds: number): number {
  if ((action.flags & ACTION_FLAG_STARTED)   === 0) return 0;
  if ((action.flags & ACTION_FLAG_COMPLETED) !== 0) return 1;
  const duration = Math.max(1, action.end - action.start);
  return Math.min(1, Math.max(0, (now_seconds - action.start) / duration));
}

// ─── Server tables ────────────────────────────────────────────────────────────
// Written only by SpacetimeDB subscription callbacks (insert / update / delete).

export const server_cards:   Record<CardId,   ServerCard>   = {};
export const server_players: Record<PlayerId, ServerPlayer> = {};
export const server_actions: Record<ActionId, ServerAction> = {};
export const server_zones:   Map<MacroLocation, ServerZone> = new Map();

// ─── Client tables ────────────────────────────────────────────────────────────
// Derived from server tables; all packed fields pre-decoded for fast reads.

export const client_cards:   Record<CardId,   ClientCard>   = {};
export const client_players: Record<PlayerId, ClientPlayer> = {};
export const client_actions: Record<ActionId, ClientAction> = {};
export const client_zones:   Map<MacroLocation, ClientZone> = new Map();

// ─── Secondary indexes ────────────────────────────────────────────────────────
// Kept in sync by upsert / remove operations below.

export const macro_location_cards:   Map<MacroLocation, Set<CardId>>   = new Map();
export const macro_location_players: Map<MacroLocation, Set<PlayerId>> = new Map();
export const macro_location_actions: Map<MacroLocation, Set<ActionId>> = new Map();

// Maps each parent card_id to the sets of children stacked on it, by direction.
export const stacked_up_children:   Map<CardId, Set<CardId>> = new Map();
export const stacked_down_children: Map<CardId, Set<CardId>> = new Map();

// ─── Session state ────────────────────────────────────────────────────────────

export let player_id   = 0 as PlayerId;
export let player_name = "";
export let soul_id     = 0 as CardId;
export let observer_id = 0 as CardId;
export let viewed_id   = 0 as CardId;

export let selected_card_id = 0 as CardId;
export let selected_macro   = 0n as MacroLocation;
export let selected_micro   = 0 as MicroLocation;

export function setPlayerId(id: PlayerId):   void { player_id   = id; }
export function setPlayerName(n: string):    void { player_name = n; }
export function setSoulId(id: CardId):       void { soul_id     = id; }
export function setObserverId(id: CardId):   void { observer_id = id; }
export function setViewedId(id: CardId):     void { viewed_id   = id; }

export function setSelectedState(card_id: CardId, macro: MacroLocation, micro: MicroLocation): void {
  selected_card_id = card_id;
  selected_macro   = macro;
  selected_micro   = micro;
}

export function clearSelectedState(): void {
  selected_card_id = 0;
  selected_macro   = 0n;
  selected_micro   = 0;
}

// ─── Index helpers ────────────────────────────────────────────────────────────

function addToMacroIndex<T>(index: Map<MacroLocation, Set<T>>, loc: MacroLocation, id: T): void {
  let set = index.get(loc);
  if (!set) { set = new Set(); index.set(loc, set); }
  set.add(id);
}

function removeFromMacroIndex<T>(index: Map<MacroLocation, Set<T>>, loc: MacroLocation, id: T): void {
  const set = index.get(loc);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) index.delete(loc);
}

function addToStackIndex(index: Map<CardId, Set<CardId>>, parent_id: CardId, child_id: CardId): void {
  let set = index.get(parent_id);
  if (!set) { set = new Set(); index.set(parent_id, set); }
  set.add(child_id);
}

function removeFromStackIndex(index: Map<CardId, Set<CardId>>, parent_id: CardId, child_id: CardId): void {
  const set = index.get(parent_id);
  if (!set) return;
  set.delete(child_id);
  if (set.size === 0) index.delete(parent_id);
}

function stackIndexFor(stacked_up: boolean): Map<CardId, Set<CardId>> {
  return stacked_up ? stacked_up_children : stacked_down_children;
}

// ─── Location unpacking shared by all builders ────────────────────────────────

function unpackMacro(macro_location: MacroLocation): {
  surface: number; layer: number;
  zone_q: number; zone_r: number; panel_card_id: CardId;
} {
  const surface       = surfaceFromMacro(macro_location);
  const layer         = layerFromMacro(macro_location);
  const zone_q        = surface === SURFACE_WORLD ? zoneQFromMacro(macro_location) : 0;
  const zone_r        = surface === SURFACE_WORLD ? zoneRFromMacro(macro_location) : 0;
  const panel_card_id = surface === SURFACE_PANEL ? cardIdFromMacro(macro_location) : 0;
  return { surface, layer, zone_q, zone_r, panel_card_id };
}

// micro_location mode is determined by surface (plus stacked flag for cards).
// surface=1 → hex [local_q:u4][local_r:u4]; surface=2 → pixel [x:i16][y:i16].
function unpackMicro(
  micro_location: MicroLocation,
  surface: number,
): { local_q: number; local_r: number; pixel_x: number; pixel_y: number } {
  if (surface === SURFACE_WORLD) {
    return { local_q: localQFromMicro(micro_location), local_r: localRFromMicro(micro_location), pixel_x: 0, pixel_y: 0 };
  }
  if (surface === SURFACE_PANEL) {
    return { local_q: 0, local_r: 0, pixel_x: pixelXFromMicro(micro_location), pixel_y: pixelYFromMicro(micro_location) };
  }
  return { local_q: 0, local_r: 0, pixel_x: 0, pixel_y: 0 };
}

// ─── Client builders ──────────────────────────────────────────────────────────

export function buildClientCard(server: ServerCard, previous?: ClientCard): ClientCard {
  const macro         = unpackMacro(server.macro_location);
  const stacked_up    = (server.flags & CARD_FLAG_STACKED_UP)   !== 0;
  const stacked_down  = (server.flags & CARD_FLAG_STACKED_DOWN) !== 0;
  const is_stacked    = stacked_up || stacked_down;
  const stacked_on_id = is_stacked ? server.micro_location : 0;
  const micro         = is_stacked ? { local_q: 0, local_r: 0, pixel_x: 0, pixel_y: 0 }
                                   : unpackMicro(server.micro_location, macro.surface);
  const world_q       = macro.surface === SURFACE_WORLD && !is_stacked ? macro.zone_q * ZONE_SIZE + micro.local_q : 0;
  const world_r       = macro.surface === SURFACE_WORLD && !is_stacked ? macro.zone_r * ZONE_SIZE + micro.local_r : 0;

  return {
    ...server,
    card_type:       cardTypeFromDefinition(server.packed_definition),
    category:        categoryFromDefinition(server.packed_definition),
    definition_id:   definitionIdFromDefinition(server.packed_definition),
    stacked_up,
    stacked_down,
    stackable:       (server.flags & CARD_FLAG_STACKABLE)       !== 0,
    position_locked: (server.flags & CARD_FLAG_POSITION_LOCKED) !== 0,
    position_hold:   (server.flags & CARD_FLAG_POSITION_HOLD)   !== 0,
    ...macro,
    stacked_on_id, ...micro, world_q, world_r,
    selected:  previous?.selected  ?? false,
    dragging:  previous?.dragging  ?? false,
    returning: previous?.returning ?? false,
    hidden:    previous?.hidden    ?? false,
    stale: false,
    dirty: true,
  };
}

export function buildClientPlayer(server: ServerPlayer): ClientPlayer {
  const macro  = unpackMacro(server.macro_location);
  const micro  = unpackMicro(server.micro_location, macro.surface);
  const world_q = macro.surface === SURFACE_WORLD ? macro.zone_q * ZONE_SIZE + micro.local_q : 0;
  const world_r = macro.surface === SURFACE_WORLD ? macro.zone_r * ZONE_SIZE + micro.local_r : 0;
  return { ...server, ...macro, ...micro, world_q, world_r, stale: false, dirty: true };
}

export function buildClientAction(server: ServerAction): ClientAction {
  const macro  = unpackMacro(server.macro_location);
  const micro  = unpackMicro(server.micro_location, macro.surface);
  const world_q = macro.surface === SURFACE_WORLD ? macro.zone_q * ZONE_SIZE + micro.local_q : 0;
  const world_r = macro.surface === SURFACE_WORLD ? macro.zone_r * ZONE_SIZE + micro.local_r : 0;
  return { ...server, ...macro, ...micro, world_q, world_r, stale: false, dirty: true };
}

function decodeZoneRow(row: bigint): number[] {
  const ids: number[] = [];
  for (let q = 0; q < ZONE_SIZE; q++) ids.push(Number((row >> BigInt(q * 8)) & 0xFFn));
  return ids;
}

export function buildClientZone(server: ServerZone): ClientZone {
  const zone_q    = zoneQFromMacro(server.macro_location);
  const zone_r    = zoneRFromMacro(server.macro_location);
  const layer     = layerFromMacro(server.macro_location);
  const card_type = zoneCardTypeFromDefinition(server.definition);
  const category  = zoneCategoryFromDefinition(server.definition);

  const rows = [server.t0, server.t1, server.t2, server.t3, server.t4, server.t5, server.t6, server.t7];
  const tile_definition_ids = rows.map(decodeZoneRow);
  const tile_definitions    = tile_definition_ids.map((row) =>
    row.map((id) => resolveZoneTileDefinition(server.definition, id))
  );

  return { ...server, zone_q, zone_r, layer, card_type, category, tile_definition_ids, tile_definitions, stale: false, dirty: true };
}

// ─── Upsert / remove ──────────────────────────────────────────────────────────

export function upsertClientCard(server: ServerCard): void {
  const previous = client_cards[server.card_id];
  if (previous && previous.macro_location !== server.macro_location) {
    removeFromMacroIndex(macro_location_cards, previous.macro_location, server.card_id);
  }
  const next = buildClientCard(server, previous);
  client_cards[next.card_id] = next;
  addToMacroIndex(macro_location_cards, next.macro_location, next.card_id);

  const old_parent   = previous?.stacked_on_id ?? 0;
  const old_up       = previous?.stacked_up ?? false;
  const new_parent   = next.stacked_on_id;
  const new_up       = next.stacked_up;
  if (old_parent !== new_parent || old_up !== new_up) {
    if (old_parent !== 0) removeFromStackIndex(stackIndexFor(old_up), old_parent, next.card_id);
    if (new_parent !== 0) addToStackIndex(stackIndexFor(new_up), new_parent, next.card_id);
  }
}

export function removeClientCard(card_id: CardId): void {
  const card = client_cards[card_id];
  if (!card) return;
  removeFromMacroIndex(macro_location_cards, card.macro_location, card_id);
  if (card.stacked_on_id !== 0) removeFromStackIndex(stackIndexFor(card.stacked_up), card.stacked_on_id, card_id);
  delete client_cards[card_id];
}

export function upsertClientPlayer(server: ServerPlayer): void {
  const previous = client_players[server.player_id];
  if (previous && previous.macro_location !== server.macro_location) {
    removeFromMacroIndex(macro_location_players, previous.macro_location, server.player_id);
  }
  const next = buildClientPlayer(server);
  client_players[next.player_id] = next;
  addToMacroIndex(macro_location_players, next.macro_location, next.player_id);
}

export function removeClientPlayer(player_id: PlayerId): void {
  const player = client_players[player_id];
  if (!player) return;
  removeFromMacroIndex(macro_location_players, player.macro_location, player_id);
  delete client_players[player_id];
}

export function upsertClientAction(server: ServerAction): void {
  const previous = client_actions[server.action_id];
  if (previous && previous.macro_location !== server.macro_location) {
    removeFromMacroIndex(macro_location_actions, previous.macro_location, server.action_id);
  }
  const next = buildClientAction(server);
  client_actions[next.action_id] = next;
  addToMacroIndex(macro_location_actions, next.macro_location, next.action_id);
}

export function removeClientAction(action_id: ActionId): void {
  const action = client_actions[action_id];
  if (!action) return;
  removeFromMacroIndex(macro_location_actions, action.macro_location, action_id);
  delete client_actions[action_id];
}

export function upsertClientZone(server: ServerZone): void {
  client_zones.set(server.macro_location, buildClientZone(server));
}

export function removeClientZone(macro_location: MacroLocation): void {
  client_zones.delete(macro_location);
}

// ─── Local mutation helpers ───────────────────────────────────────────────────
// For optimistic UI changes not yet published to the server (e.g. dragging).
//
// Parent cards never store child references — only children point to parents
// via micro_location = stacked_id. No parent update is needed in either fn.

// Move a card to a free position (world hex or panel pixel). Clears STACKED.
export function moveClientCard(
  card_id: CardId,
  macro_location: MacroLocation,
  micro_location: MicroLocation,
): void {
  const card = client_cards[card_id];
  if (!card) return;

  if (card.macro_location !== macro_location) {
    removeFromMacroIndex(macro_location_cards, card.macro_location, card_id);
  }

  const macro = unpackMacro(macro_location);
  const micro = unpackMicro(micro_location, macro.surface);

  card.macro_location = macro_location;
  card.micro_location = micro_location;
  if (card.stacked_on_id !== 0) removeFromStackIndex(stackIndexFor(card.stacked_up), card.stacked_on_id, card_id);
  card.flags         &= ~(CARD_FLAG_STACKED_UP | CARD_FLAG_STACKED_DOWN);
  card.stacked_up     = false;
  card.stacked_down   = false;
  card.stacked_on_id  = 0;
  card.surface        = macro.surface;
  card.layer          = macro.layer;
  card.zone_q         = macro.zone_q;
  card.zone_r         = macro.zone_r;
  card.panel_card_id  = macro.panel_card_id;
  card.local_q        = micro.local_q;
  card.local_r        = micro.local_r;
  card.pixel_x        = micro.pixel_x;
  card.pixel_y        = micro.pixel_y;
  card.world_q        = macro.surface === SURFACE_WORLD ? macro.zone_q * ZONE_SIZE + micro.local_q : 0;
  card.world_r        = macro.surface === SURFACE_WORLD ? macro.zone_r * ZONE_SIZE + micro.local_r : 0;
  card.dirty          = true;

  addToMacroIndex(macro_location_cards, macro_location, card_id);
}

function applyStackClientCard(card_id: CardId, onto_id: CardId, stacked_up: boolean): void {
  const card   = client_cards[card_id];
  const parent = client_cards[onto_id];
  if (!card || !parent) return;

  if (card.macro_location !== parent.macro_location) {
    removeFromMacroIndex(macro_location_cards, card.macro_location, card_id);
  }

  if (card.stacked_on_id !== onto_id || card.stacked_up !== stacked_up) {
    if (card.stacked_on_id !== 0) removeFromStackIndex(stackIndexFor(card.stacked_up), card.stacked_on_id, card_id);
    addToStackIndex(stackIndexFor(stacked_up), onto_id, card_id);
  }

  card.macro_location = parent.macro_location;
  card.micro_location = packMicroStacked(onto_id);
  card.flags         &= ~(CARD_FLAG_STACKED_UP | CARD_FLAG_STACKED_DOWN);
  card.flags         |= stacked_up ? CARD_FLAG_STACKED_UP : CARD_FLAG_STACKED_DOWN;
  card.stacked_up     = stacked_up;
  card.stacked_down   = !stacked_up;
  card.stacked_on_id  = onto_id;
  card.surface        = parent.surface;
  card.layer          = parent.layer;
  card.zone_q         = parent.zone_q;
  card.zone_r         = parent.zone_r;
  card.panel_card_id  = parent.panel_card_id;
  card.local_q        = 0;
  card.local_r        = 0;
  card.pixel_x        = 0;
  card.pixel_y        = 0;
  card.world_q        = 0;
  card.world_r        = 0;
  card.dirty          = true;

  addToMacroIndex(macro_location_cards, card.macro_location, card_id);
}

export function stackClientCardUp(card_id: CardId, onto_id: CardId):   void { applyStackClientCard(card_id, onto_id, true);  }
export function stackClientCardDown(card_id: CardId, onto_id: CardId): void { applyStackClientCard(card_id, onto_id, false); }

// ─── Stale mark / sweep ───────────────────────────────────────────────────────
// Pattern: markStale → process server updates → delete anything still stale.

export function markClientCardsStale():   void { for (const k in client_cards)   client_cards[Number(k)].stale   = true; }
export function markClientPlayersStale(): void { for (const k in client_players) client_players[Number(k)].stale = true; }
export function markClientActionsStale(): void { for (const k in client_actions) client_actions[Number(k)].stale = true; }
export function markClientZonesStale():   void { for (const z of client_zones.values()) z.stale = true; }

// ─── Bulk sync from server tables ─────────────────────────────────────────────
// Rebuilds client tables from server tables after loading a full snapshot.

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
  for (const loc of client_zones.keys()) { if (!server_zones.has(loc)) removeClientZone(loc); }
}
