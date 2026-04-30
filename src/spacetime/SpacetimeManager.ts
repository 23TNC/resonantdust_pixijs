import type { Identity } from "spacetimedb";
import { DbConnection, type ErrorContext, type SubscriptionHandle } from "./bindings/index";
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
  removeClientCard,
  upsertClientPlayer,
  removeClientPlayer,
  upsertClientAction,
  removeClientAction,
  upsertClientZone,
  removeClientZone,
  setViewedId,
} from "./Data";

type Mode = "simulated" | "connected";

interface SubscriptionEntry {
  handle:  SubscriptionHandle;
  holders: Set<object>;
}

/**
 * Single interface point for all SpacetimeDB operations.
 *
 * In "simulated" mode (default) each method directly applies the table changes
 * that SpacetimeDB subscription callbacks would normally push.
 *
 * In "connected" mode call connect() to establish a WebSocket connection.
 * Table callbacks (insert / update / delete) populate the server_* globals in
 * Data.ts and then call the corresponding upsert/remove helpers to keep the
 * client tables in sync.
 *
 * Subscriptions: call subscribe(owner, sql) to open (or share) a subscription.
 * Multiple owners may hold the same query open simultaneously.  Calling
 * releaseSubscription(owner, query) removes that owner's hold but intentionally
 * leaves the subscription open so rarely-changing data (zones, definitions) is
 * not re-fetched every time the player re-enters an area.  Call
 * collectSubscriptions() to close all zero-holder subscriptions when you need
 * to reclaim bandwidth or memory.
 *
 * Listeners: register a callback keyed by card_id to be notified when that
 * card's state changes (dead=1 on deletion, dead=2 when animation completes).
 * Card widgets use this to start their death animation; CardStack uses it to
 * detect when cleanup is due.
 */
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

  /**
   * Establish a WebSocket connection to a SpacetimeDB instance.
   * Switches the manager to "connected" mode and registers table callbacks so
   * all subscription data is routed into server_* / client_* tables.
   * No-op if already connected.
   */
  connect(uri: string, moduleName: string): void {
    if (this._conn) {
      console.warn("SpacetimeManager: already connected");
      return;
    }
    this._mode = "connected";
    DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(moduleName)
      .onConnect((conn: DbConnection, identity: Identity, _token: string) => {
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

  /** Returns the live DbConnection, or null before connect() resolves or in simulated mode. */
  getConnection(): DbConnection | null { return this._conn; }

  /**
   * Register a callback to fire once the WebSocket connection is established.
   * If already connected, the callback fires synchronously on the next tick.
   * Returns an unregister function.
   */
  onConnected(fn: () => void): () => void {
    if (this._conn) {
      queueMicrotask(fn);
      return () => {};
    }
    this._connectListeners.add(fn);
    return () => this._connectListeners.delete(fn);
  }

  // ─── Subscription management ─────────────────────────────────────────────────

  /**
   * Acquire a hold on a subscription for the given SQL query.
   *
   * If no subscription exists for this query it is opened immediately against
   * the live connection.  If one already exists the owner is added to its
   * holder set without opening a second connection.
   *
   * Returns a release function — identical to calling releaseSubscription(owner, query).
   * No-op (returns a no-op release) in simulated mode or before connect().
   */
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

  /**
   * Remove this owner's hold on a subscription.
   *
   * The subscription itself stays open — data already received remains in the
   * client tables and the server keeps sending updates.  Call
   * collectSubscriptions() when you want to prune zero-holder subscriptions.
   */
  releaseSubscription(owner: object, query: string): void {
    this._subscriptions.get(query)?.holders.delete(owner);
  }

  /**
   * Close and remove every subscription that currently has no holders.
   * Returns the number of subscriptions closed.
   *
   * Call this at natural GC points (zone transitions, low-memory pressure).
   * Subscriptions for rarely-changing data (zones, global definitions) can be
   * excluded by keeping a permanent holder object alive for them.
   */
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

  /** Read-only snapshot of active subscriptions and their holder counts.
   *  Useful for debugging and GC heuristics. */
  getSubscriptionStats(): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    for (const [query, entry] of this._subscriptions) {
      out.set(query, entry.holders.size);
    }
    return out;
  }

  // ─── Zone subscriptions ──────────────────────────────────────────────────────

  /**
   * Subscribe to all rows in zones, cards, players, and actions whose
   * macro_location matches the given value.
   * Returns a release function equivalent to releaseZone(owner, macro_location).
   */
  subscribeZone(owner: object, macro_location: bigint): () => void {
    const loc = macro_location.toString();
    this.subscribe(owner, `SELECT * FROM zones   WHERE macro_location = ${loc}`);
    this.subscribe(owner, `SELECT * FROM cards   WHERE macro_location = ${loc}`);
    this.subscribe(owner, `SELECT * FROM players WHERE macro_location = ${loc}`);
    this.subscribe(owner, `SELECT * FROM actions WHERE macro_location = ${loc}`);
    return () => this.releaseZone(owner, macro_location);
  }

  /** Release this owner's hold on all four macro_location subscriptions for the zone. */
  releaseZone(owner: object, macro_location: bigint): void {
    const loc = macro_location.toString();
    this.releaseSubscription(owner, `SELECT * FROM zones   WHERE macro_location = ${loc}`);
    this.releaseSubscription(owner, `SELECT * FROM cards   WHERE macro_location = ${loc}`);
    this.releaseSubscription(owner, `SELECT * FROM players WHERE macro_location = ${loc}`);
    this.releaseSubscription(owner, `SELECT * FROM actions WHERE macro_location = ${loc}`);
  }

  // ─── Soul subscriptions ──────────────────────────────────────────────────────

  /**
   * Subscribe to all data owned by a soul: players where soul_id = soul_id,
   * cards where owner_id = soul_id, and actions where owner_id = soul_id.
   * Returns a release function equivalent to releaseSoul(owner, soul_id).
   */
  subscribeSoul(owner: object, soul_id: number): () => void {
    const id = soul_id.toString();
    this.subscribe(owner, `SELECT * FROM players WHERE soul_id  = ${id}`);
    this.subscribe(owner, `SELECT * FROM cards   WHERE owner_id = ${id}`);
    this.subscribe(owner, `SELECT * FROM actions WHERE owner_id = ${id}`);
    return () => this.releaseSoul(owner, soul_id);
  }

  /** Release this owner's hold on the three soul-scoped subscriptions. */
  releaseSoul(owner: object, soul_id: number): void {
    const id = soul_id.toString();
    this.releaseSubscription(owner, `SELECT * FROM players WHERE soul_id  = ${id}`);
    this.releaseSubscription(owner, `SELECT * FROM cards   WHERE owner_id = ${id}`);
    this.releaseSubscription(owner, `SELECT * FROM actions WHERE owner_id = ${id}`);
  }

  /** Switch the viewed soul: releases the previous soul subscription and subscribes to the new one. */
  setViewedSoul(owner: object, soul_id: CardId): void {
    if (this._viewedSoulId === soul_id) return;
    if (this._viewedSoulId !== null && this._viewedSoulOwner !== null) {
      this.releaseSoul(this._viewedSoulOwner, this._viewedSoulId);
    }
    this._viewedSoulId    = soul_id;
    this._viewedSoulOwner = owner;
    setViewedId(soul_id);
    this.subscribeSoul(owner, soul_id);
  }

  // ─── Player subscriptions ────────────────────────────────────────────────────

  /**
   * Subscribe to the player row matching player_name.
   * Use this to bootstrap the session: once the player row arrives, read
   * soul_id and call subscribeSoul to pull in all soul-owned data.
   * Returns a release function equivalent to releasePlayer(owner, player_name).
   */
  subscribePlayer(owner: object, player_name: string): () => void {
    const escaped = player_name.replace(/'/g, "''");
    this.subscribe(owner, `SELECT * FROM players WHERE name = '${escaped}'`);
    return () => this.releasePlayer(owner, player_name);
  }

  /** Release this owner's hold on the player-name subscription. */
  releasePlayer(owner: object, player_name: string): void {
    const escaped = player_name.replace(/'/g, "''");
    this.releaseSubscription(owner, `SELECT * FROM players WHERE name = '${escaped}'`);
  }

  // ─── Listener registry ──────────────────────────────────────────────────────

  /** Register a callback fired whenever the named card's state changes.
   *  Returns an unregister function — call it when the listener is no longer needed. */
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

  /** Fire all listeners registered for card_id.  Called by Card when dead
   *  transitions to 2 so CardStack knows to finalize removal. */
  notifyCardListeners(card_id: CardId): void {
    this._cardListeners.get(card_id)?.forEach(fn => fn());
  }

  /** Register a callback fired whenever any zone row is inserted, updated, or
   *  deleted.  Returns an unregister function. */
  registerZoneListener(fn: () => void): () => void {
    this._zoneListeners.add(fn);
    return () => this._zoneListeners.delete(fn);
  }

  /** Register a callback fired whenever a player row with the given name is
   *  inserted or updated.  Returns an unregister function. */
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
   * Delete a card row.
   *
   * Simulated: removes the row from server_cards and marks client_cards[card_id].dead = 1,
   * then fires listeners so Card widgets start their death animation.
   * removeClientCard is deferred until finalizeCardRemoval is called.
   *
   * Connected: calls the deleteCard reducer; the server's onDelete callback
   * will call _beginCardDeath once the row is removed from the subscription.
   */
  deleteCard(card_id: CardId): void {
    if (this._mode === "simulated") {
      this._simDeleteCard(card_id);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._conn?.reducers as any)?.deleteCard({ cardId: card_id });
    }
  }

  /**
   * Called by the card's owner (e.g. CardStack) after dead===2 is detected and
   * the Card widget has been destroyed.  Removes the card from all client tables
   * and indexes and clears its listener set.
   */
  finalizeCardRemoval(card_id: CardId): void {
    removeClientCard(card_id);
    this._cardListeners.delete(card_id);
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
      this._beginCardDeath(server.card_id);
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
      server_zones.set(server.macro_location, server);
      upsertClientZone(server);
      this._zoneListeners.forEach(fn => fn());
      this._invalidateTable('zones');
    });
    conn.db.zones.onUpdate((_ctx, _old, newRow) => {
      const server = adaptZone(newRow);
      server_zones.set(server.macro_location, server);
      upsertClientZone(server);
      this._zoneListeners.forEach(fn => fn());
      this._invalidateTable('zones');
    });
    conn.db.zones.onDelete((_ctx, row) => {
      const loc = row.macroLocation;
      server_zones.delete(loc);
      removeClientZone(loc);
      this._zoneListeners.forEach(fn => fn());
      this._invalidateTable('zones');
    });
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  private _simDeleteCard(card_id: CardId): void {
    const card = client_cards[card_id];
    if (!card || card.dead !== 0) return;
    delete server_cards[card_id];
    this._beginCardDeath(card_id);
  }

  /** Mark card as dying and fire listeners.  Used by both simulated delete
   *  and the connected onDelete callback so the death animation always runs. */
  private _beginCardDeath(card_id: CardId): void {
    const card = client_cards[card_id];
    if (!card || card.dead !== 0) return;
    card.dead = 1;
    this.notifyCardListeners(card_id);
  }
}

// ─── Binding adapters ──────────────────────────────────────────────────────────
// Convert generated camelCase binding types to our snake_case Server* interfaces.
// Kept as module-level functions (not class methods) since they have no `this` dependency.

function adaptCard(row: BoundCard): ServerCard {
  return {
    card_id:           row.cardId,
    macro_location:    row.macroLocation,
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
    player_id:      row.playerId,
    name:           row.name,
    soul_id:        row.soulId,
    macro_location: row.macroLocation,
    micro_location: row.microLocation,
  };
}

function adaptAction(row: BoundAction): ServerAction {
  return {
    action_id:      row.actionId,
    card_id:        row.cardId,
    recipe:         row.recipe,
    end:            row.end,
    owner_id:       row.ownerId,
    macro_location: row.macroLocation,
    micro_location: row.microLocation,
  };
}

function adaptZone(row: BoundZone): ServerZone {
  return {
    macro_location: row.macroLocation,
    definition:     row.definition,
    t0: row.t0, t1: row.t1, t2: row.t2, t3: row.t3,
    t4: row.t4, t5: row.t5, t6: row.t6, t7: row.t7,
  };
}

export const spacetime = new SpacetimeManager();
