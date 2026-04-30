/**
 * Synthetic snapshot that stands in for a live SpacetimeDB subscription.
 * Populates server_* tables exactly as real callbacks would, then derives
 * client_* tables via the same upsert path used in production.
 */
import {
  type CardId,
  type PlayerId,
  type ActionId,
  type ServerCard,
  type ServerPlayer,
  type ServerAction,
  type ServerZone,
  CARD_FLAG_STACKED_UP,
  CARD_FLAG_STACKED_DOWN,
  CARD_FLAG_STACKABLE,
  packDefinition,
  packZoneDefinition,
  packMacroWorld,
  packMacroPanel,
  packMicroHex,
  packMicroPixel,
  packMicroStacked,
  server_cards,
  server_players,
  server_actions,
  server_zones,
  client_cards,
  client_players,
  client_actions,
  client_zones,
  macro_location_cards,
  macro_location_players,
  macro_location_actions,
  stacked_up_children,
  stacked_down_children,
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
} from "./Data";

function clearRecord(record: Record<PropertyKey, unknown>): void {
  for (const key in record) delete record[key];
}

/** Reset all tables and load a known-good snapshot for offline development. */
export function bootstrap(): void {
  // ─── Clear all tables ──────────────────────────────────────────────────────
  clearRecord(server_cards);
  clearRecord(server_players);
  clearRecord(server_actions);
  server_zones.clear();

  clearRecord(client_cards);
  clearRecord(client_players);
  clearRecord(client_actions);
  client_zones.clear();

  macro_location_cards.clear();
  macro_location_players.clear();
  macro_location_actions.clear();
  stacked_up_children.clear();
  stacked_down_children.clear();

  // ─── Session ───────────────────────────────────────────────────────────────
  const soul_card_id = 1 as CardId;
  setPlayerId(1 as PlayerId);
  setPlayerName("player1");
  setSoulId(soul_card_id);
  setObserverId(soul_card_id);
  setViewedId(soul_card_id);
  clearSelectedState();

  // ─── Locations ─────────────────────────────────────────────────────────────
  const world_macro = packMacroWorld(0, 0, 1);          // zone (0,0), layer 1
  const panel_macro = packMacroPanel(soul_card_id, 1);  // soul 1's inventory panel, layer 1
  const now_s       = Math.floor(Date.now() / 1000);    // Unix time in seconds at bootstrap

  // ─── Cards ─────────────────────────────────────────────────────────────────
  //
  // Stacking convention:
  //   Parent — CARD_FLAG_STACKABLE, world or panel position via micro
  //   Child  — CARD_FLAG_STACKED_UP or CARD_FLAG_STACKED_DOWN (+ STACKABLE if it can also be a parent)
  //            micro_location = packMicroStacked(parent_card_id)
  //
  // Panel inventory layout (pixel x, y=0):
  //   card 2   card 3   card 4   card 5┐   card 9┐  card 14
  //   x=-180   x=-90    x=0      x=90  │   x=180 │  x=270
  //                               card 6┘   card10┘  ← up-branch (STACKED_UP)
  //                              card 12┐  card 13┐  ← down-branch (STACKED_DOWN)
  //                     (Discipline/bot)┘  (Faculty/top)┘
  const S  = CARD_FLAG_STACKABLE;
  const ST = CARD_FLAG_STACKED_UP   | CARD_FLAG_STACKABLE;
  const SD = CARD_FLAG_STACKED_DOWN | CARD_FLAG_STACKABLE;

  const cards: ServerCard[] = [
    // Soul card (type 5, category 0, def 1) — world hex (0,0)
    { card_id: 1,  macro_location: world_macro, micro_location: packMicroHex(0, 0),      owner_id: 1, flags: S,  packed_definition: packDefinition(5, 0, 1), data: 0n, action_id: 0 },

    // Inventory: standalone cards
    { card_id: 2,  macro_location: panel_macro, micro_location: packMicroPixel(-180, 0), owner_id: 1, flags: S,  packed_definition: packDefinition(1, 0, 1), data: 0n, action_id: 0 },
    { card_id: 3,  macro_location: panel_macro, micro_location: packMicroPixel( -90, 0), owner_id: 1, flags: S,  packed_definition: packDefinition(1, 0, 2), data: 0n, action_id: 0 },
    { card_id: 4,  macro_location: panel_macro, micro_location: packMicroPixel(   0, 0), owner_id: 1, flags: S,  packed_definition: packDefinition(1, 0, 3), data: 0n, action_id: 0 },

    // Inventory: stack (card 5 parent, card 6 child)
    { card_id: 5,  macro_location: panel_macro, micro_location: packMicroPixel(  90, 0), owner_id: 1, flags: S,  packed_definition: packDefinition(2, 0, 1), data: 0n, action_id: 0 },
    { card_id: 6,  macro_location: panel_macro, micro_location: packMicroStacked(5),     owner_id: 1, flags: ST, packed_definition: packDefinition(2, 0, 2), data: 0n, action_id: 0 },

    // World: item card and tile card
    { card_id: 7,  macro_location: world_macro, micro_location: packMicroHex(1, 0),      owner_id: 1, flags: S,  packed_definition: packDefinition(1, 0, 1), data: 0n, action_id: 0 },
    { card_id: 8,  macro_location: world_macro, micro_location: packMicroHex(2, 1),      owner_id: 1, flags: 0,  packed_definition: packDefinition(6, 0, 2), data: 0n, action_id: 0 },

    // Inventory: stack (card 9 parent, card 10 child)
    { card_id: 9,  macro_location: panel_macro, micro_location: packMicroPixel( 180, 0), owner_id: 1, flags: S,  packed_definition: packDefinition(2, 0, 4), data: 0n, action_id: 0 },
    { card_id: 10, macro_location: panel_macro, micro_location: packMicroStacked(9),     owner_id: 1, flags: ST, packed_definition: packDefinition(2, 0, 3), data: 0n, action_id: 0 },

    // Inventory: down-branch children — Discipline (title_on_bottom) on stack 5, Faculty (title_on_top) on stack 9
    { card_id: 12, macro_location: panel_macro, micro_location: packMicroStacked(5),     owner_id: 1, flags: SD, packed_definition: packDefinition(1, 0, 1), data: 0n, action_id: 0 },
    { card_id: 13, macro_location: panel_macro, micro_location: packMicroStacked(9),     owner_id: 1, flags: SD, packed_definition: packDefinition(2, 0, 1), data: 0n, action_id: 0 },

    // Inventory: Revery Soul Reference (type 4 / category 0 / def 1) — card_target points at soul_card_id
    { card_id: 11, macro_location: panel_macro, micro_location: packMicroPixel(   0, 0), owner_id: 1, flags: CARD_FLAG_STACKABLE,  packed_definition: packDefinition(4, 0, 1), data: BigInt(soul_card_id), action_id: 0 },

    // Inventory: Vitality (Faculty / def 5) — fleeting: start=now, end=now+20s
    { card_id: 14, macro_location: panel_macro, micro_location: packMicroPixel( 270, 0), owner_id: 1, flags: S, packed_definition: packDefinition(2, 0, 5), data: BigInt(now_s) | (BigInt(now_s + 5) << 32n), action_id: 0 },
  ];

  // ─── Players ───────────────────────────────────────────────────────────────
  const players: ServerPlayer[] = [
    { player_id: 1, name: "player1", soul_id: 1, macro_location: world_macro, micro_location: packMicroHex(0, 0) },
  ];

  // ─── Actions ───────────────────────────────────────────────────────────────
  const actions: ServerAction[] = [
    // { action_id: 1, card_id: 7, recipe: 1, start: 0, end: 0, flags: 0, owner_id: 1, macro_location: world_macro, micro_location: packMicroHex(1, 0) },
  ];

  // ─── Zones ─────────────────────────────────────────────────────────────────
  const uniform_row   = 0x0101010101010101n;
  const uniform_tiles = { t0: uniform_row, t1: uniform_row, t2: uniform_row, t3: uniform_row,
                          t4: uniform_row, t5: uniform_row, t6: uniform_row, t7: uniform_row };

  const zones: ServerZone[] = [
    { macro_location: packMacroWorld( 0,  0, 1), definition: packZoneDefinition(6, 0), ...uniform_tiles },
    { macro_location: packMacroWorld(-1,  0, 1), definition: packZoneDefinition(6, 0), ...uniform_tiles },
    { macro_location: packMacroWorld( 0, -1, 1), definition: packZoneDefinition(6, 0), ...uniform_tiles },
  ];

  // ─── Populate server tables ────────────────────────────────────────────────
  for (const card   of cards)   server_cards[card.card_id as CardId]       = card;
  for (const player of players) server_players[player.player_id as PlayerId] = player;
  for (const action of actions) server_actions[action.action_id as ActionId] = action;
  for (const zone   of zones)   server_zones.set(zone.macro_location, zone);

  // ─── Derive client tables ──────────────────────────────────────────────────
  for (const zone   of zones)   upsertClientZone(zone);
  for (const card   of cards)   upsertClientCard(card);
  for (const player of players) upsertClientPlayer(player);
  for (const action of actions) upsertClientAction(action);
}
