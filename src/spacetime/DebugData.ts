// pixijs/src/spacetime/debug_data.ts

import {
  type CardId,
  type PlayerId,
  type ServerCard,
  type ServerPlayer,
  type ServerAction,
  type ServerZone,
  server_cards,
  server_players,
  server_actions,
  server_zones,
  client_cards,
  client_cards_by_zone,
  setViewedId,
  setObserverId,
  clearSelectedState,
  upsertClientCard,
  upsertClientZone,
  packDefinition,
  packPosition,
  packZone,
  packZoneDefinition,
} from "./Data";

function clearRecord<T>(record: Record<number, T>): void {
  for (const key in record) {
    delete record[Number(key)];
  }
}

function clearZoneIndex(): void {
  for (const key in client_cards_by_zone) {
    delete client_cards_by_zone[Number(key)];
  }
}

const WORLD = true;
const LOCAL = false;
const LINKED = true;
const UNLINKED = false;

export function bootstrap(): void {
  clearRecord(server_cards);
  clearRecord(server_players);
  clearRecord(server_actions);
  clearRecord(server_zones);
  clearRecord(client_cards);
  clearZoneIndex();

  setViewedId(1);
  setObserverId(1);

  const world_zone = packZone(0, 0, 1);
  const inventory_zone = packZone(0, 0, 1);

  const cards: ServerCard[] = [
    {
      card_id: 1,
      definition: packDefinition(5, 1),
      soul_id: 0,
      link_id: 0,
      flags: 0,
      zone: world_zone,
      position: packPosition(0, 0, WORLD, UNLINKED),
    },
    {
      card_id: 2,
      definition: packDefinition(1, 1),
      soul_id: 1,
      link_id: 0,
      flags: 0,
      zone: inventory_zone,
      position: packPosition(0, 0, LOCAL, UNLINKED),
    },
    {
      card_id: 3,
      definition: packDefinition(1, 2),
      soul_id: 1,
      link_id: 0,
      flags: 0,
      zone: inventory_zone,
      position: packPosition(1, 0, LOCAL, UNLINKED),
    },
    {
      card_id: 4,
      definition: packDefinition(1, 3),
      soul_id: 1,
      link_id: 0,
      flags: 0,
      zone: inventory_zone,
      position: packPosition(2, 0, LOCAL, UNLINKED),
    },
    {
      card_id: 5,
      definition: packDefinition(2, 1),
      soul_id: 1,
      link_id: 6,
      flags: 0,
      zone: inventory_zone,
      position: packPosition(0, 1, LOCAL, LINKED),
    },
    {
      card_id: 6,
      definition: packDefinition(2, 1),
      soul_id: 1,
      link_id: 0,
      flags: 0,
      zone: inventory_zone,
      position: packPosition(0, 1, LOCAL, UNLINKED),
    },
    {
      card_id: 7,
      definition: packDefinition(1, 1),
      soul_id: 1,
      link_id: 0,
      flags: 0,
      zone: world_zone,
      position: packPosition(1, 0, WORLD, UNLINKED),
    },
    {
      card_id: 8,
      definition: packDefinition(6, 2),
      soul_id: 1,
      link_id: 0,
      flags: 0,
      zone: world_zone,
      position: packPosition(2, 1, WORLD, UNLINKED),
    },
    {
      card_id: 9,
      definition: packDefinition(2, 2),
      soul_id: 1,
      link_id: 10,
      flags: 0,
      zone: inventory_zone,
      position: packPosition(1, 1, LOCAL, LINKED),
    },
    {
      card_id: 10,
      definition: packDefinition(2, 3),
      soul_id: 1,
      link_id: 0,
      flags: 0,
      zone: inventory_zone,
      position: packPosition(1, 1, LOCAL, UNLINKED),
    },
  ];

  const players: ServerPlayer[] = [
    {
      player_id: 1,
      name: "player1",
      soul_id: 1,
      zone: world_zone,
      position: packPosition(0, 0, WORLD, UNLINKED),
    },
  ];

  const actions: ServerAction[] = [];

  const zones: ServerZone[] = [
    {
      zone: packZone(0, 0, 1),
      definition: packZoneDefinition(6, 0),
      t0: 72340172838076673n,
      t1: 72340172838076673n,
      t2: 72340172838076673n,
      t3: 72340172838076673n,
      t4: 72340172838076673n,
      t5: 72340172838076673n,
      t6: 72340172838076673n,
      t7: 72340172838076673n,
    },
    {
      zone: packZone(-1, 0, 1),
      definition: packZoneDefinition(6, 0),
      t0: 72340172838076673n,
      t1: 72340172838076673n,
      t2: 72340172838076673n,
      t3: 72340172838076673n,
      t4: 72340172838076673n,
      t5: 72340172838076673n,
      t6: 72340172838076673n,
      t7: 72340172838076673n,
    },
    {
      zone: packZone(0, -1, 1),
      definition: packZoneDefinition(6, 0),
      t0: 72340172838076673n,
      t1: 72340172838076673n,
      t2: 72340172838076673n,
      t3: 72340172838076673n,
      t4: 72340172838076673n,
      t5: 72340172838076673n,
      t6: 72340172838076673n,
      t7: 72340172838076673n,
    },
  ];

  for (const card of cards) {
    server_cards[card.card_id as CardId] = card;
  }

  for (const player of players) {
    server_players[player.player_id as PlayerId] = player;
  }

  for (const action of actions) {
    server_actions[action.card_id as CardId] = action;
  }

  for (const zone of zones) {
    upsertClientZone(zone);
  }

  for (const key in server_cards) {
    const card_id = Number(key) as CardId;
    upsertClientCard(server_cards[card_id]);
  }

  clearSelectedState();
}
