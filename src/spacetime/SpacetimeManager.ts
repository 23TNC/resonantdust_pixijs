import type { Identity } from "spacetimedb";
import { DbConnection, type ErrorContext, type SubscriptionHandle } from "./bindings/index";
import { DeathCoordinator } from "@/coordinators/DeathCoordinator";
import { deathState } from "@/model/CardModel";
import type {
  Card   as BoundCard,
  Player as BoundPlayer,
  Action as BoundAction,
  Zone   as BoundZone,
} from "./bindings/types";
import {
  type CardId,
  type PlayerId,
  type ActionId,
  type MacroZone,
  type ServerCard,
  type ServerPlayer,
  type ServerAction,
  type ServerZone,
  server_cards,
  server_players,
  server_actions,
  server_zones,
  client_cards,
  upsertClientCard,
  bindCardChangeNotifier,
  upsertClientPlayer,
  removeClientPlayer,
  upsertClientAction,
  removeClientAction,
  upsertClientZone,
  removeClientZone,
  setViewedId,
  zoneKey,
  packMacroPanel,
  PANEL_LAYER_INVENTORY,
} from "./Data";

type Mode = "simulated" | "connected";

interface SubscriptionEntry {
  handle:  SubscriptionHandle;
  holders: Set<object>;
}

class SpacetimeManager {
  private _mode: Mode = "simulated";
  private _conn: DbConnection | null = null;
  private _cardListeners    = new Map<CardId, Set<() => void>>();
  private _playerListeners  = new Map<string, Set<(player: ServerPlayer) => void>>();
  private _zoneListeners    = new Set<() => void>();
  private _subscriptions    = new Map<string, SubscriptionEntry>();
  private _connectListeners = new Set<() => void>();
  private _viewedSoulId:    number | null = null;
  private _viewedSoulOwner: object | null = null;

  get mode(): Mode { return this._mode; }
  get isConnected(): boolean { return this._conn !== null; }

  // ─── Connection ─────────────────────────────────────────────────────────────

  connect(uri: string, moduleName: string): void {
    if (this._conn) {
      console.warn("SpacetimeManager: already connected");
      return;
    }
    this._mode = "connected";
    DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(moduleName)
      .onConnect((conn: DbConnection, _identity: Identity, _token: string) => {
        this._conn = conn;
        this._registerTableCallbacks(conn);
        this._connectListeners.forEach(fn => fn());
        this._connectListeners.clear();
      })
      .onDisconnect((_ctx: ErrorContext, error?: Error) => {
        if (error) console.error("SpacetimeDB disconnected:", error);
        else       console.log("SpacetimeDB disconnected");
        this._conn = null;
        this._subscriptions.clear();
      })
      .build();
  }

  getConnection(): DbConnection | null { return this._conn; }

  onConnected(fn: () => void): () => void {
    if (this._conn) {
      queueMicrotask(fn);
      return () => {};
    }
    this._connectListeners.add(fn);
    return () => this._connectListeners.delete(fn);
  }

  // ─── Subscription management ─────────────────────────────────────────────────

  subscribe(owner: object, query: string): () => void {
    if (!this._conn) {
      console.warn("SpacetimeManager.subscribe: not connected");
      return () => {};
    }
    let entry = this._subscriptions.get(query);
    if (!entry) {
      const handle = this._conn.subscriptionBuilder().subscribe([query]);
      entry = { handle, holders: new Set() };
      this._subscriptions.set(query, entry);
    }
    entry.holders.add(owner);
    return () => this.releaseSubscription(owner, query);
  }

  releaseSubscription(owner: object, query: string): void {
    this._subscriptions.get(query)?.holders.delete(owner);
  }

  collectSubscriptions(): number {
    let closed = 0;
    for (const [query, entry] of this._subscriptions) {
      if (entry.holders.size === 0) {
        entry.handle.unsubscribe();
        this._subscriptions.delete(query);
        closed++;
      }
    }
    return closed;
  }

  getSubscriptionStats(): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    for (const [query, entry] of this._subscriptions) {
      out.set(query, entry.holders.size);
    }
    return out;
  }

  // ─── Zone subscriptions (world layer) ────────────────────────────────────────

  /**
   * Subscribe to all rows in zones, cards, players, and actions whose
   * `(layer, macro_zone)` matches the given world zone.
   *
   * macro_zone is the packed `[zone_q:i16][zone_r:i16]` u32 — a world zone.
   * For panel subscriptions use `subscribePanel` instead.
   */
  subscribeZone(owner: object, layer: number, macro_zone: MacroZone): () => void {
    const mz = (macro_zone >>> 0).toString();
    const ly = layer.toString();
    this.subscribe(owner, `SELECT * FROM zones   WHERE layer = ${ly} AND macro_zone = ${mz}`);
    this.subscribe(owner, `SELECT * FROM cards   WHERE layer = ${ly} AND macro_zone = ${mz}`);
    this.subscribe(owner, `SELECT * FROM players WHERE layer = ${ly} AND macro_zone = ${mz}`);
    this.subscribe(owner, `SELECT * FROM actions WHERE layer = ${ly} AND macro_zone = ${mz}`);
    return () => this.releaseZone(owner, layer, macro_zone);
  }

  releaseZone(owner: object, layer: number, macro_zone: MacroZone): void {
    const mz = (macro_zone >>> 0).toString();
    const ly = layer.toString();
    this.releaseSubscription(owner, `SELECT * FROM zones   WHERE layer = ${ly} AND macro_zone = ${mz}`);
    this.releaseSubscription(owner, `SELECT * FROM cards   WHERE layer = ${ly} AND macro_zone = ${mz}`);
    this.releaseSubscription(owner, `SELECT * FROM players WHERE layer = ${ly} AND macro_zone = ${mz}`);
    this.releaseSubscription(owner, `SELECT * FROM actions WHERE layer = ${ly} AND macro_zone = ${mz}`);
  }

  // ─── Panel subscriptions ─────────────────────────────────────────────────────

  /**
   * Subscribe to all panel cards / actions of `soul_id` (any panel layer they
   * occupy).  Geometry encodes ownership: panel rows have `macro_zone =
   * soul_id`, so a single equality filter pulls the entire panel set.
   */
  subscribePanel(owner: object, soul_id: CardId): () => void {
    const mz = packMacroPanel(soul_id).toString();
    this.subscribe(owner, `SELECT * FROM cards   WHERE macro_zone = ${mz}`);
    this.subscribe(owner, `SELECT * FROM actions WHERE macro_zone = ${mz}`);
    return () => this.releasePanel(owner, soul_id);
  }

  releasePanel(owner: object, soul_id: CardId): void {
    const mz = packMacroPanel(soul_id).toString();
    this.releaseSubscription(owner, `SELECT * FROM cards   WHERE macro_zone = ${mz}`);
    this.releaseSubscription(owner, `SELECT * FROM actions WHERE macro_zone = ${mz}`);
  }

  // ─── Soul subscriptions ──────────────────────────────────────────────────────
  //
  // Kept for now per the schema-redesign discussion: visibility is technically
  // covered by `subscribePanel` plus world-zone subscriptions, but `owner_id`
  // remains useful for trade audits and as cheap insurance against missing-row
  // bugs while the panel/world split shakes out.

  subscribeSoul(owner: object, soul_id: CardId): () => void {
    const id = soul_id.toString();
    this.subscribe(owner, `SELECT * FROM players WHERE soul_id  = ${id}`);
    this.subscribe(owner, `SELECT * FROM cards   WHERE owner_id = ${id}`);
    this.subscribe(owner, `SELECT * FROM actions WHERE owner_id = ${id}`);
    return () => this.releaseSoul(owner, soul_id);
  }

  releaseSoul(owner: object, soul_id: CardId): void {
    const id = soul_id.toString();
    this.releaseSubscription(owner, `SELECT * FROM players WHERE soul_id  = ${id}`);
    this.releaseSubscription(owner, `SELECT * FROM cards   WHERE owner_id = ${id}`);
    this.releaseSubscription(owner, `SELECT * FROM actions WHERE owner_id = ${id}`);
  }

  setViewedSoul(owner: object, soul_id: CardId): void {
    if (this._viewedSoulId === soul_id) return;
    if (this._viewedSoulId !== null && this._viewedSoulOwner !== null) {
      this.releaseSoul(this._viewedSoulOwner, this._viewedSoulId);
      this.releasePanel(this._viewedSoulOwner, this._viewedSoulId);
    }
    this._viewedSoulId    = soul_id;
    this._viewedSoulOwner = owner;
    setViewedId(soul_id);
    this.subscribeSoul(owner, soul_id);
    this.subscribePanel(owner, soul_id);
  }

  // ─── Player subscriptions ────────────────────────────────────────────────────

  subscribePlayer(owner: object, player_name: string): () => void {
    const escaped = player_name.replace(/'/g, "''");
    this.subscribe(owner, `SELECT * FROM players WHERE name = '${escaped}'`);
    return () => this.releasePlayer(owner, player_name);
  }

  releasePlayer(owner: object, player_name: string): void {
    const escaped = player_name.replace(/'/g, "''");
    this.releaseSubscription(owner, `SELECT * FROM players WHERE name = '${escaped}'`);
  }

  // ─── Listener registry ──────────────────────────────────────────────────────

  registerCardListener(card_id: CardId, fn: () => void): () => void {
    let set = this._cardListeners.get(card_id);
    if (!set) { set = new Set(); this._cardListeners.set(card_id, set); }
    set.add(fn);
    return () => {
      const s = this._cardListeners.get(card_id);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this._cardListeners.delete(card_id);
    };
  }

  notifyCardListeners(card_id: CardId): void {
    this._cardListeners.get(card_id)?.forEach(fn => fn());
  }

  clearCardListeners(card_id: CardId): void {
    this._cardListeners.delete(card_id);
  }

  registerZoneListener(fn: () => void): () => void {
    this._zoneListeners.add(fn);
    return () => this._zoneListeners.delete(fn);
  }

  registerPlayerListener(name: string, fn: (player: ServerPlayer) => void): () => void {
    let set = this._playerListeners.get(name);
    if (!set) { set = new Set(); this._playerListeners.set(name, set); }
    set.add(fn);
    return () => {
      const s = this._playerListeners.get(name);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this._playerListeners.delete(name);
    };
  }

  // ─── Card reducers ──────────────────────────────────────────────────────────

  /**
   * Phase 5 sync protocol entry point.  The server's `update_position`
   * reducer applies the move, cancels any actions whose claim windows the
   * move disturbs, then re-runs the matcher on the affected zones to start
   * newly-eligible recipes.
   *
   * Client policy (per the sync table in PHASE_5_SCHEMA_NOTES.md §5):
   *   - Pure cosmetic moves within own panel: do NOT call.
   *   - Moves that cross subscription boundaries (panel↔world, panel↔panel
   *     cross-soul, layer changes touching trade): always call.
   *   - World-side moves while server already sees the card in world: always
   *     call (peers can see it).
   *   - Panel→world local prep without a recipe: do NOT call (commit will
   *     come via a recipe's product placement).
   */
  updatePosition(
    cardId:        CardId,
    layer:         number,
    macroZone:     MacroZone,
    microZone:     number,
    microLocation: number,
    flags:         number,
  ): void {
    if (this._mode === "connected") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._conn?.reducers as any)?.updatePosition({ cardId, layer, macroZone, microZone, microLocation, flags });
    }
  }

  /** Batched variant of `updatePosition` — atomically applies many position
   *  changes (e.g. all the cards in a stack-merge) and runs the matcher
   *  once per affected zone. */
  updatePositions(
    cardIds:        CardId[],
    layers:         number[],
    macroZones:     MacroZone[],
    microZones:     number[],
    microLocations: number[],
    flags:          number[],
  ): void {
    if (this._mode === "connected") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._conn?.reducers as any)?.updatePositions({ cardIds, layers, macroZones, microZones, microLocations, flags });
    }
  }

  deleteCard(card_id: CardId): void {
    if (this._mode === "simulated") {
      this._simDeleteCard(card_id);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._conn?.reducers as any)?.deleteCard({ cardId: card_id });
    }
  }

  // ─── Table callbacks ────────────────────────────────────────────────────────

  private _extractTable(query: string): string {
    return /FROM\s+(\w+)/i.exec(query)?.[1]?.toLowerCase() ?? '';
  }

  private _invalidateTable(table: string): void {
    for (const [query, entry] of this._subscriptions) {
      if (this._extractTable(query) !== table) continue;
      for (const holder of entry.holders) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (holder as any).invalidateLayout?.();
      }
    }
  }

  private _registerTableCallbacks(conn: DbConnection): void {
    // ── Cards ──────────────────────────────────────────────────────────────
    conn.db.cards.onInsert((_ctx, row) => {
      const server = adaptCard(row);
      server_cards[server.card_id] = server;
      upsertClientCard(server);
      this._invalidateTable('cards');
    });
    conn.db.cards.onUpdate((_ctx, _old, newRow) => {
      const server = adaptCard(newRow);
      server_cards[server.card_id] = server;
      upsertClientCard(server);
      this._invalidateTable('cards');
    });
    conn.db.cards.onDelete((_ctx, row) => {
      const server = adaptCard(row);
      delete server_cards[server.card_id];
      DeathCoordinator.beginDeath(server.card_id);
    });

    // ── Players ────────────────────────────────────────────────────────────
    conn.db.players.onInsert((_ctx, row) => {
      const server = adaptPlayer(row);
      server_players[server.player_id] = server;
      upsertClientPlayer(server);
      this._playerListeners.get(server.name)?.forEach(fn => fn(server));
      this._invalidateTable('players');
    });
    conn.db.players.onUpdate((_ctx, _old, newRow) => {
      const server = adaptPlayer(newRow);
      server_players[server.player_id] = server;
      upsertClientPlayer(server);
      this._playerListeners.get(server.name)?.forEach(fn => fn(server));
      this._invalidateTable('players');
    });
    conn.db.players.onDelete((_ctx, row) => {
      const pid = row.playerId as PlayerId;
      delete server_players[pid];
      removeClientPlayer(pid);
      this._invalidateTable('players');
    });

    // ── Actions ────────────────────────────────────────────────────────────
    conn.db.actions.onInsert((_ctx, row) => {
      const server = adaptAction(row);
      server_actions[server.action_id] = server;
      upsertClientAction(server);
      this._invalidateTable('actions');
      this.notifyCardListeners(server.card_id);
    });
    conn.db.actions.onUpdate((_ctx, _old, newRow) => {
      const server = adaptAction(newRow);
      server_actions[server.action_id] = server;
      upsertClientAction(server);
      this._invalidateTable('actions');
      this.notifyCardListeners(server.card_id);
    });
    conn.db.actions.onDelete((_ctx, row) => {
      const aid = Number(row.actionId) as ActionId;
      const card_id = server_actions[aid]?.card_id;
      delete server_actions[aid];
      removeClientAction(aid);
      this._invalidateTable('actions');
      if (card_id !== undefined) this.notifyCardListeners(card_id);
    });

    // ── Zones ──────────────────────────────────────────────────────────────
    conn.db.zones.onInsert((_ctx, row) => {
      const server = adaptZone(row);
      server_zones.set(zoneKey(server.layer, server.macro_zone), server);
      upsertClientZone(server);
      this._zoneListeners.forEach(fn => fn());
      this._invalidateTable('zones');
    });
    conn.db.zones.onUpdate((_ctx, _old, newRow) => {
      const server = adaptZone(newRow);
      server_zones.set(zoneKey(server.layer, server.macro_zone), server);
      upsertClientZone(server);
      this._zoneListeners.forEach(fn => fn());
      this._invalidateTable('zones');
    });
    conn.db.zones.onDelete((_ctx, row) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = row as any;
      const layer      = r.layer as number;
      const macro_zone = r.macroZone as number;
      server_zones.delete(zoneKey(layer, macro_zone));
      removeClientZone(layer, macro_zone);
      this._zoneListeners.forEach(fn => fn());
      this._invalidateTable('zones');
    });
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  private _simDeleteCard(card_id: CardId): void {
    if (!client_cards[card_id]) return;
    if (deathState(card_id) !== 0) return;
    delete server_cards[card_id];
    DeathCoordinator.beginDeath(card_id);
  }
}

// ─── Binding adapters ──────────────────────────────────────────────────────────
//
// Convert generated camelCase binding types to our snake_case Server* interfaces.
// The bound row shapes here match what `spacetime generate --lang typescript`
// produces against the Phase 5 server schema (layer, macroZone, microZone,
// microLocation, etc.).

function adaptCard(row: BoundCard): ServerCard {
  return {
    card_id:           row.cardId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    layer:             (row as any).layer,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    macro_zone:        (row as any).macroZone,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    micro_zone:        (row as any).microZone,
    micro_location:    row.microLocation,
    owner_id:          row.ownerId,
    flags:             row.flags,
    packed_definition: row.packedDefinition,
    data:              row.data,
    action_id:         Number(row.actionId),
  };
}

function adaptPlayer(row: BoundPlayer): ServerPlayer {
  return {
    player_id:  row.playerId,
    name:       row.name,
    soul_id:    row.soulId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    layer:      (row as any).layer,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    macro_zone: (row as any).macroZone,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    micro_zone: (row as any).microZone,
  };
}

function adaptAction(row: BoundAction): ServerAction {
  return {
    action_id:    row.actionId,
    card_id:      row.cardId,
    recipe:       row.recipe,
    end:          row.end,
    owner_id:     row.ownerId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    layer:        (row as any).layer,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    macro_zone:   (row as any).macroZone,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    micro_zone:   (row as any).microZone,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    participants: (row as any).participants,
  };
}

function adaptZone(row: BoundZone): ServerZone {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    layer:      (row as any).layer,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    macro_zone: (row as any).macroZone,
    definition: row.definition,
    t0: row.t0, t1: row.t1, t2: row.t2, t3: row.t3,
    t4: row.t4, t5: row.t5, t6: row.t6, t7: row.t7,
  };
}

export const spacetime = new SpacetimeManager();

bindCardChangeNotifier(id => spacetime.notifyCardListeners(id));

// Export legacy import name to not break callers; the panel-layer constant is
// useful enough to surface here for reducers building macro_zones.
export { PANEL_LAYER_INVENTORY };
