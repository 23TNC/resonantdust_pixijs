/**
 * Synthetic snapshot that stands in for a live SpacetimeDB subscription.
 * Populates server_* tables exactly as real callbacks would, then derives
 * client_* tables via the same upsert path used in production.
 *
 * Currently has no remaining importers — the running app uses connected
 * mode.  Kept current with the schema so the simulated path can be revived
 * for offline development without rework.
 */
import {
  type CardId,
  type PlayerId,
  type ActionId,
  type ServerCard,
  type ServerPlayer,
  type ServerAction,
  type ServerZone,
  CARD_FLAG_STACKABLE,
  STACK_STATE_LOOSE,
  STACK_STATE_UP,
  STACK_STATE_DOWN,
  PANEL_LAYER_INVENTORY,
  WORLD_LAYER_GROUND,
  withStackState,
  packDefinition,
  packZoneDefinition,
  packMacroWorld,
  packMacroPanel,
  packMicroZone,
  packMicroPixel,
  packMicroParent,
  zoneKey,
  server_cards,
  server_players,
  server_actions,
  server_zones,
  client_cards,
  client_players,
  client_actions,
  client_zones,
  macro_zone_cards,
  macro_zone_players,
  macro_zone_actions,
  stacked_up_children,
  stacked_down_children,
  attached_to_hex_children,
  setPlayerId,
  setPlayerName,
  setSoulId,
  setObserverId,
  setViewedId,
  clearSelectedState,
  upsertClientCard,
  upsertClientPlayer,
  upsertClientAction,
  upsertClientZone,
  clearPendingUpserts,
} from "./Data";
import { clearAll as clearActionCoordinator } from "@/coordinators/ActionCoordinator";
import { clearAllLocalState } from "@/model/CardModel";
import {
  CARD_TYPE_DISCIPLINE,
  CARD_TYPE_FACULTY,
  CARD_TYPE_REVERY,
  CARD_TYPE_SOUL,
  CARD_TYPE_FLOOR,
} from "@/definitions/CardTypes";

function clearRecord(record: Record<PropertyKey, unknown>): void {
  for (const key in record) delete record[key];
}

/** Reset all tables and load a known-good snapshot for offline development. */
export function bootstrap(): void {
  clearRecord(server_cards);
  clearRecord(server_players);
  clearRecord(server_actions);
  server_zones.clear();

  clearRecord(client_cards);
  clearRecord(client_players);
  clearRecord(client_actions);
  client_zones.clear();

  macro_zone_cards.clear();
  macro_zone_players.clear();
  macro_zone_actions.clear();
  stacked_up_children.clear();
  stacked_down_children.clear();
  attached_to_hex_children.clear();
  clearPendingUpserts();
  clearAllLocalState();
  clearActionCoordinator();

  const soul_card_id = 1 as CardId;
  setPlayerId(1 as PlayerId);
  setPlayerName("player1");
  setSoulId(soul_card_id);
  setObserverId(soul_card_id);
  setViewedId(soul_card_id);
  clearSelectedState();

  const world_macro = packMacroWorld(0, 0);             // zone (0, 0)
  const panel_macro = packMacroPanel(soul_card_id);     // soul 1's inventory
  const now_s       = Math.floor(Date.now() / 1000);

  // Stacking convention: STACK_STATE bits in flags select micro_location interp.
  //   loose:    micro_location = packed pixel coords (panel) or zero+micro_zone (world)
  //   stack_*:  micro_location = parent_card_id, layer/macro_zone/micro_zone mirror parent
  const S  = withStackState(CARD_FLAG_STACKABLE, STACK_STATE_LOOSE);
  const ST = withStackState(CARD_FLAG_STACKABLE, STACK_STATE_UP);
  const SD = withStackState(CARD_FLAG_STACKABLE, STACK_STATE_DOWN);

  const cards: ServerCard[] = [
    // Soul card — world hex (0,0)
    { card_id: 1,  layer: WORLD_LAYER_GROUND,    macro_zone: world_macro, micro_zone: packMicroZone(0, 0), micro_location: packMicroPixel(0, 0),    owner_id: 1, flags: S,  packed_definition: packDefinition(CARD_TYPE_SOUL, 0, 1),       data: 0n, action_id: 0 },

    // Inventory: standalone Discipline cards
    { card_id: 2,  layer: PANEL_LAYER_INVENTORY, macro_zone: panel_macro, micro_zone: 0,                  micro_location: packMicroPixel(-180, 0), owner_id: 1, flags: S,  packed_definition: packDefinition(CARD_TYPE_DISCIPLINE, 0, 1), data: 0n, action_id: 0 },
    { card_id: 3,  layer: PANEL_LAYER_INVENTORY, macro_zone: panel_macro, micro_zone: 0,                  micro_location: packMicroPixel( -90, 0), owner_id: 1, flags: S,  packed_definition: packDefinition(CARD_TYPE_DISCIPLINE, 0, 2), data: 0n, action_id: 0 },
    { card_id: 4,  layer: PANEL_LAYER_INVENTORY, macro_zone: panel_macro, micro_zone: 0,                  micro_location: packMicroPixel(   0, 0), owner_id: 1, flags: S,  packed_definition: packDefinition(CARD_TYPE_DISCIPLINE, 0, 3), data: 0n, action_id: 0 },

    // Inventory: Faculty stack (card 5 parent, card 6 up-child)
    { card_id: 5,  layer: PANEL_LAYER_INVENTORY, macro_zone: panel_macro, micro_zone: 0,                  micro_location: packMicroPixel(  90, 0), owner_id: 1, flags: S,  packed_definition: packDefinition(CARD_TYPE_FACULTY, 0, 1),    data: 0n, action_id: 0 },
    { card_id: 6,  layer: PANEL_LAYER_INVENTORY, macro_zone: panel_macro, micro_zone: 0,                  micro_location: packMicroParent(5),      owner_id: 1, flags: ST, packed_definition: packDefinition(CARD_TYPE_FACULTY, 0, 2),    data: 0n, action_id: 0 },

    // World: Discipline placeholder + Floor card
    { card_id: 7,  layer: WORLD_LAYER_GROUND,    macro_zone: world_macro, micro_zone: packMicroZone(1, 0), micro_location: packMicroPixel(0, 0),    owner_id: 1, flags: S,  packed_definition: packDefinition(CARD_TYPE_DISCIPLINE, 0, 1), data: 0n, action_id: 0 },
    { card_id: 8,  layer: WORLD_LAYER_GROUND,    macro_zone: world_macro, micro_zone: packMicroZone(2, 1), micro_location: packMicroPixel(0, 0),    owner_id: 1, flags: 0,  packed_definition: packDefinition(CARD_TYPE_FLOOR, 0, 2),       data: 0n, action_id: 0 },

    // Inventory: Faculty stack (card 9 parent, card 10 up-child)
    { card_id: 9,  layer: PANEL_LAYER_INVENTORY, macro_zone: panel_macro, micro_zone: 0,                  micro_location: packMicroPixel( 180, 0), owner_id: 1, flags: S,  packed_definition: packDefinition(CARD_TYPE_FACULTY, 0, 4),    data: 0n, action_id: 0 },
    { card_id: 10, layer: PANEL_LAYER_INVENTORY, macro_zone: panel_macro, micro_zone: 0,                  micro_location: packMicroParent(9),      owner_id: 1, flags: ST, packed_definition: packDefinition(CARD_TYPE_FACULTY, 0, 3),    data: 0n, action_id: 0 },

    // Inventory: down-branch children
    { card_id: 12, layer: PANEL_LAYER_INVENTORY, macro_zone: panel_macro, micro_zone: 0,                  micro_location: packMicroParent(5),      owner_id: 1, flags: SD, packed_definition: packDefinition(CARD_TYPE_DISCIPLINE, 0, 1), data: 0n, action_id: 0 },
    { card_id: 13, layer: PANEL_LAYER_INVENTORY, macro_zone: panel_macro, micro_zone: 0,                  micro_location: packMicroParent(9),      owner_id: 1, flags: SD, packed_definition: packDefinition(CARD_TYPE_FACULTY, 0, 1),    data: 0n, action_id: 0 },

    // Inventory: Revery Soul Reference (def 1) — data points at soul_card_id
    { card_id: 11, layer: PANEL_LAYER_INVENTORY, macro_zone: panel_macro, micro_zone: 0,                  micro_location: packMicroPixel(   0, 0), owner_id: 1, flags: S,  packed_definition: packDefinition(CARD_TYPE_REVERY, 0, 1),     data: BigInt(soul_card_id), action_id: 0 },

    // Inventory: Vitality (Faculty / def 5) — fleeting: data encodes start/end
    { card_id: 14, layer: PANEL_LAYER_INVENTORY, macro_zone: panel_macro, micro_zone: 0,                  micro_location: packMicroPixel( 270, 0), owner_id: 1, flags: S,  packed_definition: packDefinition(CARD_TYPE_FACULTY, 0, 5),    data: BigInt(now_s) | (BigInt(now_s + 5) << 32n), action_id: 0 },
  ];

  const players: ServerPlayer[] = [
    { player_id: 1, name: "player1", soul_id: 1, layer: WORLD_LAYER_GROUND, macro_zone: world_macro, micro_zone: packMicroZone(0, 0) },
  ];

  const actions: ServerAction[] = [];

  const uniform_row   = 0x0101010101010101n;
  const uniform_tiles = { t0: uniform_row, t1: uniform_row, t2: uniform_row, t3: uniform_row,
                          t4: uniform_row, t5: uniform_row, t6: uniform_row, t7: uniform_row };

  const zones: ServerZone[] = [
    { layer: WORLD_LAYER_GROUND, macro_zone: packMacroWorld( 0,  0), definition: packZoneDefinition(CARD_TYPE_FLOOR, 0), ...uniform_tiles },
    { layer: WORLD_LAYER_GROUND, macro_zone: packMacroWorld(-1,  0), definition: packZoneDefinition(CARD_TYPE_FLOOR, 0), ...uniform_tiles },
    { layer: WORLD_LAYER_GROUND, macro_zone: packMacroWorld( 0, -1), definition: packZoneDefinition(CARD_TYPE_FLOOR, 0), ...uniform_tiles },
  ];

  for (const card   of cards)   server_cards[card.card_id as CardId]       = card;
  for (const player of players) server_players[player.player_id as PlayerId] = player;
  for (const action of actions) server_actions[action.action_id as ActionId] = action;
  for (const zone   of zones)   server_zones.set(zoneKey(zone.layer, zone.macro_zone), zone);

  for (const zone   of zones)   upsertClientZone(zone);
  for (const card   of cards)   upsertClientCard(card);
  for (const player of players) upsertClientPlayer(player);
  for (const action of actions) upsertClientAction(action);
}
