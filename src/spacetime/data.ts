// ─── ID aliases ──────────────────────────────────────────────────────────────
// Plain numbers at runtime; aliases clarify which field is which at call sites.
export type CardId = number;
export type PlayerId = number;
export type ZoneId = number;
export type PackedPosition = number;

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Cells per zone side. Hard-coded by the 3-bit local_q / local_r encoding
 * in PackedPosition — do not change without updating the pack/unpack functions.
 */
export const ZONE_SIZE = 8;

export const ACTION_FLAG_STARTED   = 1 << 0;
export const ACTION_FLAG_COMPLETED = 1 << 1;

// ─── Card flags ───────────────────────────────────────────────────────────────
// Bits within ServerCard.flags that control card behaviour.

/** Card cannot be moved by the player. */
export const CARD_FLAG_POSITION_LOCKED = 1 << 0;
/** Card position is temporarily held (e.g. mid-server-action). */
export const CARD_FLAG_POSITION_HOLD   = 1 << 1;

export interface ParsedCardFlags {
  position_locked: boolean;
  position_hold:   boolean;
}

export function parseCardFlags(flags: number): ParsedCardFlags {
  return {
    position_locked: (flags & CARD_FLAG_POSITION_LOCKED) !== 0,
    position_hold:   (flags & CARD_FLAG_POSITION_HOLD)   !== 0,
  };
}

// ─── Server row types ─────────────────────────────────────────────────────────
// Mirror of SpacetimeDB table schemas. No derived fields.

export interface ServerCard {
  card_id: CardId;
  definition: number;
  soul_id: CardId;
  link_id: CardId;
  flags: number;
  zone: ZoneId;
  position: PackedPosition;
}

export interface ServerPlayer {
  player_id: PlayerId;
  name: string;
  soul_id: CardId;
  zone: ZoneId;
  position: PackedPosition;
}

export interface ServerAction {
  card_id: CardId;
  soul_id: CardId;
  recipe: number;
  start: number;
  end: number;
  flags: number;
  zone: ZoneId;
  position: PackedPosition;
}

export interface ServerZone {
  zone: ZoneId;
  definition: number;
  // Each row is a 64-bit word; each byte encodes one tile's raw definition id.
  // t0 = r=0, t7 = r=7; within a row, byte q*8 holds tile at (q, r).
  t0: bigint; t1: bigint; t2: bigint; t3: bigint;
  t4: bigint; t5: bigint; t6: bigint; t7: bigint;
}

// ─── Client row types ─────────────────────────────────────────────────────────
// Extends server rows with unpacked coordinates, derived values, and local state.

export interface ClientCard extends ServerCard {
  // Unpacked from zone
  zone_q: number;
  zone_r: number;
  z: number;
  // Unpacked from position
  local_q: number;
  local_r: number;
  world_flag: boolean;
  linked_flag: boolean;
  // Derived
  world_q: number;
  world_r: number;
  // Unpacked from definition
  card_type: number;
  definition_id: number;
  // Local UI state — not server-authoritative
  selected: boolean;
  dragging:  boolean;
  returning: boolean;
  hidden: boolean;
  /**
   * stale: set before a re-sync pass; entries still stale after the pass were
   * deleted on the server and should be removed.
   */
  stale: boolean;
  /**
   * dirty: set whenever the client data changes. Cleared by the renderer after
   * it has processed the change.
   */
  dirty: boolean;
}

export interface ClientZone extends ServerZone {
  // Unpacked from zone id
  zone_q: number;
  zone_r: number;
  z: number;
  // Decoded from definition
  card_type: number;
  category: number;
  // Pre-decoded tile data (avoids re-decoding bigint rows every frame)
  tile_definition_ids: number[][];  // [r][q] → raw byte from zone row (0–255)
  tile_definitions: number[][];     // [r][q] → packed definition for CardDefinitions lookup
  stale: boolean;
  dirty: boolean;
}

// ─── Server tables ────────────────────────────────────────────────────────────
// Written only by SpacetimeDB subscription callbacks (insert / update / delete).

export const server_cards:   Record<CardId,   ServerCard>   = {};
export const server_players: Record<PlayerId, ServerPlayer> = {};
export const server_actions: Record<CardId,   ServerAction> = {};
export const server_zones:   Record<ZoneId,   ServerZone>   = {};

// ─── Client tables ────────────────────────────────────────────────────────────
// Derived from server tables, plus local-only state not yet published.

export const client_cards: Record<CardId, ClientCard> = {};
export const client_zones: Record<ZoneId, ClientZone> = {};

/** Secondary index — kept in sync by upsertClientCard / removeClientCard. */
export const client_cards_by_zone: Record<ZoneId, Set<CardId>> = {};

// ─── Session state ────────────────────────────────────────────────────────────

export let player_id   = 0 as PlayerId;
export let player_name = "";
export let observer_id = 0 as CardId;
/** Soul card the local player is currently viewing from. */
export let viewed_id   = 0 as CardId;

export let selected_card_id  = 0 as CardId;
export let selected_zone     = 0 as ZoneId;
export let selected_position = 0 as PackedPosition;

export function setPlayerId(id: PlayerId):     void { player_id   = id; }
export function setPlayerName(name: string):   void { player_name = name; }
export function setObserverId(id: CardId):     void { observer_id = id; }
export function setViewedId(id: CardId):       void { viewed_id   = id; }

export function setSelectedState(card_id: CardId, zone: ZoneId, position: PackedPosition): void {
  selected_card_id  = card_id;
  selected_zone     = zone;
  selected_position = position;
}

export function clearSelectedState(): void {
  selected_card_id  = 0;
  selected_zone     = 0;
  selected_position = 0;
}

// ─── Zone ID ──────────────────────────────────────────────────────────────────
// Bit layout: [31:20] = zone_q (i12)  [19:8] = zone_r (i12)  [7:0] = z (u8)

export function packZone(zone_q: number, zone_r: number, z: number): ZoneId {
  return (((zone_q & 0xfff) << 20) | ((zone_r & 0xfff) << 8) | (z & 0xff)) >>> 0;
}

export function unpackZone(zone: ZoneId): { zone_q: number; zone_r: number; z: number } {
  const z = zone & 0xff;
  let zone_r = (zone >>> 8)  & 0xfff;
  let zone_q = (zone >>> 20) & 0xfff;

  if (zone_q & 0x800) zone_q -= 0x1000; // sign-extend i12
  if (zone_r & 0x800) zone_r -= 0x1000;

  return { zone_q, zone_r, z };
}

// ─── Position ─────────────────────────────────────────────────────────────────
// Bit layout: [7] = linked_flag  [6] = world_flag  [5:3] = local_q  [2:0] = local_r

export function packPosition(
  local_q: number,
  local_r: number,
  world_flag  = false,
  linked_flag = false,
): PackedPosition {
  return (
    ((local_q & 0x7) << 3)
    | (local_r & 0x7)
    | (world_flag  ? 0x40 : 0)
    | (linked_flag ? 0x80 : 0)
  ) & 0xff;
}

export function unpackPosition(position: PackedPosition): {
  local_q: number;
  local_r: number;
  world_flag: boolean;
  linked_flag: boolean;
} {
  return {
    local_r:     position & 0x7,
    local_q:     (position >>> 3) & 0x7,
    world_flag:  (position & 0x40) !== 0,
    linked_flag: (position & 0x80) !== 0,
  };
}

// ─── Card definition ──────────────────────────────────────────────────────────
// Bit layout: [15:12] = card_type (u4)  [11:0] = definition_id (u12)

export function packDefinition(card_type: number, definition_id: number): number {
  return (((card_type & 0xf) << 12) | (definition_id & 0xfff)) >>> 0;
}

export function decodeCardType(definition: number): number {
  return (definition >>> 12) & 0xf;
}

export function decodeDefinitionId(definition: number): number {
  return definition & 0xfff;
}

// ─── Zone definition ──────────────────────────────────────────────────────────
// Bit layout: [7:4] = card_type (u4)  [3:0] = category (u4)

export function packZoneDefinition(card_type: number, category: number): number {
  return (((card_type & 0xf) << 4) | (category & 0xf)) >>> 0;
}

export function decodeZoneCardType(definition: number): number {
  return (definition >>> 4) & 0xf;
}

export function decodeZoneCategory(definition: number): number {
  return definition & 0xf;
}

/**
 * Convert a raw tile byte (0–255) from a zone row into a packed card definition.
 * The zone's category becomes the high byte of definition_id, giving each zone
 * type its own namespace within the card_type.
 */
export function resolveZoneTileDefinition(zoneDefinition: number, tileDefinitionId: number): number {
  const card_type    = decodeZoneCardType(zoneDefinition);
  const category     = decodeZoneCategory(zoneDefinition);
  const definition_id = ((category & 0xf) << 8) | (tileDefinitionId & 0xff);
  return packDefinition(card_type, definition_id);
}

// ─── Action helpers ───────────────────────────────────────────────────────────

export function isActionVisibleToSoul(action: ServerAction, soul_id: CardId): boolean {
  return action.soul_id === 0 || action.soul_id === soul_id;
}

export function isActionRunning(action: ServerAction): boolean {
  return (action.flags & ACTION_FLAG_STARTED) !== 0
    && (action.flags & ACTION_FLAG_COMPLETED) === 0;
}

export function getActionProgress(action: ServerAction, now_seconds: number): number {
  if ((action.flags & ACTION_FLAG_STARTED)   === 0) return 0;
  if ((action.flags & ACTION_FLAG_COMPLETED) !== 0) return 1;
  const duration = Math.max(1, action.end - action.start);
  return Math.min(1, Math.max(0, (now_seconds - action.start) / duration));
}

// ─── Client builders ──────────────────────────────────────────────────────────

export function buildClientCard(server: ServerCard, previous?: ClientCard): ClientCard {
  const { zone_q, zone_r, z }               = unpackZone(server.zone);
  const { local_q, local_r, world_flag, linked_flag } = unpackPosition(server.position);

  return {
    ...server,
    card_type:    decodeCardType(server.definition),
    definition_id: decodeDefinitionId(server.definition),
    zone_q, zone_r, z,
    local_q, local_r, world_flag, linked_flag,
    world_q: zone_q * ZONE_SIZE + local_q,
    world_r: zone_r * ZONE_SIZE + local_r,
    selected:  previous?.selected  ?? false,
    dragging:  previous?.dragging  ?? false,
    returning: previous?.returning ?? false,
    hidden:    previous?.hidden    ?? false,
    stale: false,
    dirty: true,
  };
}

function decodeZoneRow(row: bigint): number[] {
  const ids: number[] = [];
  for (let q = 0; q < ZONE_SIZE; q++) {
    ids.push(Number((row >> BigInt(q * 8)) & 0xffn));
  }
  return ids;
}

export function buildClientZone(server: ServerZone, _previous?: ClientZone): ClientZone {
  const { zone_q, zone_r, z } = unpackZone(server.zone);
  const card_type = decodeZoneCardType(server.definition);
  const category  = decodeZoneCategory(server.definition);

  const rows = [server.t0, server.t1, server.t2, server.t3,
                server.t4, server.t5, server.t6, server.t7];

  const tile_definition_ids = rows.map(decodeZoneRow);
  const tile_definitions    = tile_definition_ids.map((row) =>
    row.map((id) => resolveZoneTileDefinition(server.definition, id))
  );

  return {
    ...server,
    zone_q, zone_r, z,
    card_type, category,
    tile_definition_ids,
    tile_definitions,
    stale: false,
    dirty: true,
  };
}

// ─── Zone index helpers ───────────────────────────────────────────────────────

function addToZoneIndex(card: ClientCard): void {
  (client_cards_by_zone[card.zone] ??= new Set()).add(card.card_id);
}

function removeFromZoneIndex(zone: ZoneId, card_id: CardId): void {
  const set = client_cards_by_zone[zone];
  if (!set) return;
  set.delete(card_id);
  if (set.size === 0) delete client_cards_by_zone[zone];
}

// ─── Client zone operations ───────────────────────────────────────────────────

export function upsertClientZone(server: ServerZone): void {
  const previous = client_zones[server.zone];
  client_zones[server.zone] = buildClientZone(server, previous);
}

export function removeClientZone(zone_id: ZoneId): void {
  delete client_zones[zone_id];
}

// ─── Client card operations ───────────────────────────────────────────────────

export function upsertClientCard(server: ServerCard): void {
  const previous = client_cards[server.card_id];

  if (previous && previous.zone !== server.zone) {
    removeFromZoneIndex(previous.zone, server.card_id);
  }

  const next = buildClientCard(server, previous);
  client_cards[next.card_id] = next;
  addToZoneIndex(next);
}

export function removeClientCard(card_id: CardId): void {
  const card = client_cards[card_id];
  if (!card) return;
  removeFromZoneIndex(card.zone, card_id);
  delete client_cards[card_id];
}

// ─── Local client mutations ───────────────────────────────────────────────────
// For changes not yet published to the server (e.g. moving cards on a local board).

export function updateClientCardLocation(
  card_id: CardId,
  zone: ZoneId,
  position: PackedPosition,
): void {
  const card = client_cards[card_id];
  if (!card) return;

  removeFromZoneIndex(card.zone, card_id);

  const { zone_q, zone_r, z }               = unpackZone(zone);
  const { local_q, local_r, world_flag, linked_flag } = unpackPosition(position);

  card.zone     = zone;
  card.position = position;
  card.zone_q   = zone_q;
  card.zone_r   = zone_r;
  card.z        = z;
  card.local_q  = local_q;
  card.local_r  = local_r;
  card.world_flag  = world_flag;
  card.linked_flag = linked_flag;
  card.world_q  = zone_q * ZONE_SIZE + local_q;
  card.world_r  = zone_r * ZONE_SIZE + local_r;
  card.dirty    = true;

  addToZoneIndex(card);
}

export function updateClientCardLinkId(card_id: CardId, link_id: CardId): void {
  const card = client_cards[card_id];
  if (!card) return;
  card.link_id = link_id;
  card.dirty   = true;
}

// ─── Stale mark / sweep ───────────────────────────────────────────────────────
// Pattern: markStale → process server updates → delete anything still stale.

export function markClientCardsStale(): void {
  for (const key in client_cards) client_cards[Number(key) as CardId].stale = true;
}

export function markClientZonesStale(): void {
  for (const key in client_zones) client_zones[Number(key) as ZoneId].stale = true;
}

// ─── Bulk sync from server tables ─────────────────────────────────────────────
// Rebuilds client tables from server tables after loading a full snapshot.

export function syncClientCardsFromServer(): void {
  for (const key in server_cards) upsertClientCard(server_cards[Number(key) as CardId]);
  for (const key in client_cards) {
    const id = Number(key) as CardId;
    if (!(id in server_cards)) removeClientCard(id);
  }
}

export function syncClientZonesFromServer(): void {
  for (const key in server_zones) upsertClientZone(server_zones[Number(key) as ZoneId]);
  for (const key in client_zones) {
    const id = Number(key) as ZoneId;
    if (!(id in server_zones)) removeClientZone(id);
  }
}
