// pixijs/src/spacetime/data.ts

export type CardId = number;
export type PlayerId = number;
export type ZoneId = number;
export type PackedPosition = number;

export interface ServerCard {
  card_id: CardId;
  definition: number;
  soul_id: CardId;
  link_id: CardId;
  flags: number;
  zone: ZoneId;
  position: PackedPosition;
}

export interface ClientCard extends ServerCard {
  card_type: number;
  definition_id: number;
  stale: boolean;
  dirty: boolean;
  selected: boolean;
  dragging: boolean;
  hidden: boolean;

  zone_q: number;
  zone_r: number;
  z: number;
  local_q: number;
  local_r: number;
  world_flag: boolean;
  linked_flag: boolean;
  world_q: number;
  world_r: number;
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
  t0: bigint;
  t1: bigint;
  t2: bigint;
  t3: bigint;
  t4: bigint;
  t5: bigint;
  t6: bigint;
  t7: bigint;
}

export type ZoneTileDefinitionIds = number[][];
export type ZoneTileDefinitions = number[][];

export interface ClientZone extends ServerZone {
  zone_q: number;
  zone_r: number;
  z: number;
  card_type: number;
  category: number;
  tile_definition_ids: ZoneTileDefinitionIds;
  tile_definitions: ZoneTileDefinitions;
  stale: boolean;
  dirty: boolean;
}

export const server_cards: Record<CardId, ServerCard> = {};
export const server_players: Record<PlayerId, ServerPlayer> = {};
export const server_actions: Record<CardId, ServerAction> = {};
export const server_zones: Record<ZoneId, ServerZone> = {};

export const client_zones: Record<ZoneId, ClientZone> = {};

export const ACTION_FLAG_STARTED = 1 << 0;
export const ACTION_FLAG_COMPLETED = 1 << 1;

export function isActionVisibleToSoul(action: ServerAction, soul_id: CardId): boolean {
  return action.soul_id === 0 || action.soul_id === soul_id;
}

export function isActionRunning(action: ServerAction): boolean {
  return (action.flags & ACTION_FLAG_STARTED) !== 0 && (action.flags & ACTION_FLAG_COMPLETED) === 0;
}

export function getActionProgress(action: ServerAction, now_seconds: number): number {
  if ((action.flags & ACTION_FLAG_STARTED) === 0) return 0;
  if ((action.flags & ACTION_FLAG_COMPLETED) !== 0) return 1;

  const duration = Math.max(1, action.end - action.start);
  return Math.min(1, Math.max(0, (now_seconds - action.start) / duration));
}

export const client_cards: Record<CardId, ClientCard> = {};
export const client_cards_by_zone: Record<ZoneId, Set<CardId>> = {};

export let player_id = 0;
export let player_name = "";
export let observer_id = 0;
export let viewed_id = 0;
export let selected_card_id = 0;
export let selected_zone = 0;
export let selected_position = 0;

export function setPlayerId(id: number): void {
  player_id = id;
}

export function setPlayerName(name: string): void {
  player_name = name;
}

export function setViewedId(id: number): void {
  viewed_id = id;
}

export function setObserverId(id: number): void {
  observer_id = id;
}

export function setSelectedCardId(id: number): void {
  selected_card_id = id;
}

export function setSelectedZone(zone: number): void {
  selected_zone = zone;
}

export function setSelectedPosition(position: number): void {
  selected_position = position;
}

export function setSelectedState(card_id: number, zone: number, position: number): void {
  selected_card_id = card_id;
  selected_zone = zone;
  selected_position = position;
}

export function clearSelectedState(): void {
  selected_card_id = 0;
  selected_zone = 0;
  selected_position = 0;
}

export function decodeCardType(definition: number): number {
  return (definition >>> 12) & 0x000f;
}

export function decodeDefinitionId(definition: number): number {
  return definition & 0x0fff;
}

export function packDefinition(card_type: number, definition_id: number): number {
  return (((card_type & 0x0f) << 12) | (definition_id & 0x0fff)) >>> 0;
}

export function decodeZoneCardType(definition: number): number {
  return (definition >>> 4) & 0x0f;
}

export function decodeZoneCategory(definition: number): number {
  return definition & 0x0f;
}

export function packZoneDefinition(card_type: number, category: number): number {
  return (((card_type & 0x0f) << 4) | (category & 0x0f)) >>> 0;
}

export function resolveZoneTileDefinition(zoneDefinition: number, tileDefinitionId: number): number {
  const card_type = decodeZoneCardType(zoneDefinition);
  const category = decodeZoneCategory(zoneDefinition);
  const definition_id = ((category & 0x0f) << 8) | (tileDefinitionId & 0xff);

  return packDefinition(card_type, definition_id);
}

export function packZone(zone_q: number, zone_r: number, z: number): number {
  const q = zone_q & 0xfff;
  const r = zone_r & 0xfff;

  return ((q << 20) | (r << 8) | (z & 0xff)) >>> 0;
}

export function unpackZone(zone: number): { zone_q: number; zone_r: number; z: number } {
  const z = zone & 0xff;
  let zone_r = (zone >>> 8) & 0xfff;
  let zone_q = (zone >>> 20) & 0xfff;

  if (zone_q & 0x800) zone_q -= 0x1000;
  if (zone_r & 0x800) zone_r -= 0x1000;

  return { zone_q, zone_r, z };
}

export function unpackPosition(position: number): {
  local_q: number;
  local_r: number;
  world_flag: boolean;
  linked_flag: boolean;
} {
  const local_r = position & 0x7;
  const local_q = (position >>> 3) & 0x7;
  const world_flag = ((position >>> 6) & 0x1) !== 0;
  const linked_flag = ((position >>> 7) & 0x1) !== 0;

  return { local_q, local_r, world_flag, linked_flag };
}

export function packPosition(
  local_q: number,
  local_r: number,
  world_flag = false,
  linked_flag = false,
): number {
  return (
    ((local_q & 0x7) << 3)
    | (local_r & 0x7)
    | (world_flag ? 0x40 : 0)
    | (linked_flag ? 0x80 : 0)
  ) & 0xff;
}

function addClientCardToZone(card: ClientCard): void {
  if (!client_cards_by_zone[card.zone]) {
    client_cards_by_zone[card.zone] = new Set<CardId>();
  }

  client_cards_by_zone[card.zone].add(card.card_id);
}

function removeClientCardFromZone(zone: ZoneId, card_id: CardId): void {
  const zone_cards = client_cards_by_zone[zone];
  if (!zone_cards) return;

  zone_cards.delete(card_id);

  if (zone_cards.size === 0) {
    delete client_cards_by_zone[zone];
  }
}

export function buildClientCard(server: ServerCard, previous?: ClientCard): ClientCard {
  const { zone_q, zone_r, z } = unpackZone(server.zone);
  const { local_q, local_r, world_flag, linked_flag } = unpackPosition(server.position);

  const card_type = decodeCardType(server.definition);
  const definition_id = decodeDefinitionId(server.definition);
  return {
    ...server,
    card_type,
    definition_id,
    stale: false,
    dirty: true,
    selected: previous?.selected ?? false,
    dragging: previous?.dragging ?? false,
    hidden: previous?.hidden ?? false,

    zone_q,
    zone_r,
    z,
    local_q,
    local_r,
    world_flag,
    linked_flag,
    world_q: zone_q * 8 + local_q,
    world_r: zone_r * 8 + local_r,
  };
}

function getZoneRows(zone: ServerZone): bigint[] {
  return [zone.t0, zone.t1, zone.t2, zone.t3, zone.t4, zone.t5, zone.t6, zone.t7];
}

export function unpackZoneTileDefinitionIds(zone: ServerZone): ZoneTileDefinitionIds {
  return getZoneRows(zone).map((row) => {
    const tile_definition_ids: number[] = [];

    for (let local_q = 0; local_q < 8; local_q += 1) {
      tile_definition_ids.push(Number((row >> BigInt(local_q * 8)) & 0xffn));
    }

    return tile_definition_ids;
  });
}

export function buildClientZone(server: ServerZone, previous?: ClientZone): ClientZone {
  const { zone_q, zone_r, z } = unpackZone(server.zone);
  const card_type = decodeZoneCardType(server.definition);
  const category = decodeZoneCategory(server.definition);
  const tile_definition_ids = unpackZoneTileDefinitionIds(server);
  const tile_definitions = tile_definition_ids.map((row) => (
    row.map((tile_definition_id) => resolveZoneTileDefinition(server.definition, tile_definition_id))
  ));

  return {
    ...server,
    zone_q,
    zone_r,
    z,
    card_type,
    category,
    tile_definition_ids,
    tile_definitions,
    stale: false,
    dirty: previous ? true : true,
  };
}

export function markClientZonesStale(): void {
  for (const key in client_zones) {
    client_zones[Number(key)].stale = true;
  }
}

export function upsertClientZone(server: ServerZone): void {
  const previous = client_zones[server.zone];
  client_zones[server.zone] = buildClientZone(server, previous);
}

export function removeClientZone(zone: ZoneId): void {
  delete client_zones[zone];
}

export function syncClientZonesFromServer(): void {
  for (const key in server_zones) {
    upsertClientZone(server_zones[Number(key)]);
  }

  for (const key in client_zones) {
    const zone = Number(key);
    if (!(zone in server_zones)) {
      removeClientZone(zone);
    }
  }
}

export function markClientCardsStale(): void {
  for (const key in client_cards) {
    client_cards[Number(key)].stale = true;
  }
}

export function upsertClientCard(server: ServerCard): void {
  const previous = client_cards[server.card_id];
  const next = buildClientCard(server, previous);

  if (previous && previous.zone !== next.zone) {
    removeClientCardFromZone(previous.zone, server.card_id);
  }

  client_cards[server.card_id] = next;
  addClientCardToZone(next);
}

export function updateClientCardLocation(card_id: CardId, zone: ZoneId, position: PackedPosition): void {
  const card = client_cards[card_id];
  if (!card) {
    return;
  }

  removeClientCardFromZone(card.zone, card_id);

  const { zone_q, zone_r, z } = unpackZone(zone);
  const { local_q, local_r, world_flag, linked_flag } = unpackPosition(position);

  card.zone = zone;
  card.position = position;
  card.zone_q = zone_q;
  card.zone_r = zone_r;
  card.z = z;
  card.local_q = local_q;
  card.local_r = local_r;
  card.world_flag = world_flag;
  card.linked_flag = linked_flag;
  card.world_q = zone_q * 8 + local_q;
  card.world_r = zone_r * 8 + local_r;
  card.dirty = true;

  addClientCardToZone(card);
}

export function updateClientCardLinkId(card_id: CardId, link_id: CardId): void {
  const card = client_cards[card_id];
  if (!card) {
    return;
  }

  card.link_id = link_id;
  card.dirty = true;
}

export function removeClientCard(card_id: CardId): void {
  const previous = client_cards[card_id];
  if (!previous) return;

  removeClientCardFromZone(previous.zone, card_id);
  delete client_cards[card_id];
}

export function syncClientCardsFromServer(): void {
  for (const key in server_cards) {
    upsertClientCard(server_cards[Number(key)]);
  }

  for (const key in client_cards) {
    const card_id = Number(key);
    if (!(card_id in server_cards)) {
      removeClientCard(card_id);
    }
  }
}
