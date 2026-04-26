/**
 * Synthetic snapshot that stands in for a live SpacetimeDB subscription.
 * Populate server_* tables exactly as the real callbacks would, then derive
 * client_* tables via the same upsert path used in production.
 */
import {
  type CardId,
  type PlayerId,
  type ServerCard,
  type ServerPlayer,
  type ServerZone,
  server_cards,
  server_players,
  server_zones,
  client_cards,
  client_zones,
  client_cards_by_zone,
  packDefinition,
  packPosition,
  packZone,
  packZoneDefinition,
  CARD_FLAG_STACKED,
  setObserverId,
  setViewedId,
  clearSelectedState,
  upsertClientCard,
  upsertClientZone,
} from "./Data";

// Readable aliases for flag arguments in packPosition.
const WORLD   = true;
const LOCAL   = false;
const LINKED  = true;
const UNLINKED = false;

function clearTable(table: Record<number, unknown>): void {
  for (const key in table) delete table[Number(key)];
}

function clearZoneIndex(): void {
  for (const key in client_cards_by_zone) delete client_cards_by_zone[Number(key)];
}

/** Reset all tables and load a known-good snapshot for offline development. */
export function bootstrap(): void {
  clearTable(server_cards);
  clearTable(server_players);
  clearTable(server_zones);
  clearTable(client_cards);
  clearTable(client_zones);
  clearZoneIndex();

  setViewedId(1);
  setObserverId(1);

  // ─── Zone IDs ──────────────────────────────────────────────────────────────
  const world_zone = packZone(0, 0, 1);

  // ─── Cards ─────────────────────────────────────────────────────────────────
  //
  // Stack convention:
  //   Root card    — linked_flag = LINKED,   link_id = next card_id, zone/pos = real position
  //   Stacked card — flags = CARD_FLAG_STACKED, link_id = 0
  //
  // Exception — card_type 6 (world tile):
  //   link_id may point to another world tile (e.g. dungeon entrance/exit pair)
  //   but linked_flag is always UNLINKED so no visual stack is rendered.
  //   Both tiles point to each other (A→B and B→A); the cycle is intentional
  //   and safe because linked_flag is false — CardStack never follows these links.
  //
  // Inventory LOCAL positioning:
  //   zone_q / zone_r are used as pixel x / y (center-origin within the panel).
  //   local_q / local_r are unused by the inventory and set to 0, 0.
  //   Five stacks placed in a row at 90 px intervals (stack width = 80 px → 10 px gap).
  //
  //   card 2  card 3  card 4  card 5┐ card 9┐
  //    x=-180  x=-90   x=0    x=90  │  x=180│
  //                            card 6┘  card10┘
  const cards: ServerCard[] = [
    { card_id: 1,  definition: packDefinition(5, 1), soul_id: 0, link_id: 0,  flags: 0,                 zone: world_zone,           position: packPosition(0, 0, WORLD, UNLINKED) },
    { card_id: 2,  definition: packDefinition(1, 1), soul_id: 1, link_id: 0,  flags: 0,                 zone: packZone(-180, 0, 1), position: packPosition(0, 0, LOCAL, UNLINKED) },
    { card_id: 3,  definition: packDefinition(1, 2), soul_id: 1, link_id: 0,  flags: 0,                 zone: packZone( -90, 0, 1), position: packPosition(0, 0, LOCAL, UNLINKED) },
    { card_id: 4,  definition: packDefinition(1, 3), soul_id: 1, link_id: 0,  flags: 0,                 zone: packZone(   0, 0, 1), position: packPosition(0, 0, LOCAL, UNLINKED) },
    { card_id: 5,  definition: packDefinition(2, 1), soul_id: 1, link_id: 6,  flags: 0,                 zone: packZone(  90, 0, 1), position: packPosition(0, 0, LOCAL, LINKED)   },
    { card_id: 6,  definition: packDefinition(2, 1), soul_id: 1, link_id: 0,  flags: CARD_FLAG_STACKED, zone: packZone(  90, 0, 1), position: packPosition(0, 0, LOCAL, UNLINKED) },
    { card_id: 7,  definition: packDefinition(1, 1), soul_id: 1, link_id: 0,  flags: 0,                 zone: world_zone,           position: packPosition(1, 0, WORLD, UNLINKED) },
    { card_id: 8,  definition: packDefinition(6, 2), soul_id: 1, link_id: 0,  flags: 0,                 zone: world_zone,           position: packPosition(2, 1, WORLD, UNLINKED) },
    { card_id: 9,  definition: packDefinition(2, 2), soul_id: 1, link_id: 10, flags: 0,                 zone: packZone( 180, 0, 1), position: packPosition(0, 0, LOCAL, LINKED)   },
    { card_id: 10, definition: packDefinition(2, 3), soul_id: 1, link_id: 0,  flags: CARD_FLAG_STACKED, zone: packZone( 180, 0, 1), position: packPosition(0, 0, LOCAL, UNLINKED) },
  ];

  // ─── Players ───────────────────────────────────────────────────────────────
  const players: ServerPlayer[] = [
    { player_id: 1, name: "player1", soul_id: 1, zone: world_zone, position: packPosition(0, 0, WORLD, UNLINKED) },
  ];

  // ─── Zones ─────────────────────────────────────────────────────────────────
  // t0–t7: each row is 8 bytes, one per tile column. 0x01 = tile definition id 1.
  const uniformTileRow = 0x0101010101010101n;
  const uniformTileData = {
    t0: uniformTileRow, t1: uniformTileRow, t2: uniformTileRow, t3: uniformTileRow,
    t4: uniformTileRow, t5: uniformTileRow, t6: uniformTileRow, t7: uniformTileRow,
  };

  const zones: ServerZone[] = [
    { zone: packZone( 0,  0, 1), definition: packZoneDefinition(6, 0), ...uniformTileData },
    { zone: packZone(-1,  0, 1), definition: packZoneDefinition(6, 0), ...uniformTileData },
    { zone: packZone( 0, -1, 1), definition: packZoneDefinition(6, 0), ...uniformTileData },
  ];

  // ─── Populate server tables ────────────────────────────────────────────────
  for (const card   of cards)   server_cards[card.card_id     as CardId]     = card;
  for (const player of players) server_players[player.player_id as PlayerId] = player;
  for (const zone   of zones)   server_zones[zone.zone]                      = zone;

  // ─── Derive client tables ──────────────────────────────────────────────────
  for (const zone of zones) upsertClientZone(zone);
  for (const card of cards) upsertClientCard(card);

  clearSelectedState();
}
