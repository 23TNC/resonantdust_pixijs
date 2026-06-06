//! Routes world reads (cards/souls/soul_privates, zones/regions) through the
//! gate instead of per-module SpacetimeDB SDK connections — the gate fans rows
//! from whichever backing shard owns each table.
//!
//! Keeps the `subscribe*` / `unsubscribe*` + `registerTableHandlers` surface the
//! old SDK subscription managers had, so `DataManager` uses it by changing one
//! constructor call. Each `subscribe*` becomes one or
//! more gate `sub {table, filter}` messages; incoming `row` events are coerced
//! per-table and fanned out to the registered handlers, just like the SDK
//! callbacks did.
//!
//! Clock: the gate pushes a `time` heartbeat (its wall clock — the timeline it
//! future-stamps on) every second, which `dispatch` feeds to `onReducerEvent`
//! → `noteServerTime`. That replaces the SDK's reducer-event timestamps as the
//! `serverNowMs()` anchor, so the gate path no longer falls back to `Date.now()`.
//!
//! Gap vs the SDK path (deliberate, for later): no auto-reconnect re-issue yet
//! (the gate connection queues pre-open sends, so initial connect is covered).

import { type ZoneId } from "../data/packing";
import type { Card, Soul, SoulPrivate } from "../spacetime/bindings/shard/types";
import type { Region, Zone } from "../spacetime/bindings/shard/types";
import type { ChatMessage } from "../spacetime/bindings/chat/types";
import type { Player, PlayerProfile } from "../spacetime/bindings/players/types";
import { debug } from "../../debug";
import { sharedGate } from "./GateConnection";
import type { GateMsg, RawRow } from "./protocol";

/** Insert/update/delete callbacks a consumer registers for a table. The gate
 *  fan-out invokes whichever are present per row op. (Formerly defined on the
 *  SDK `SubscriptionBase`; now SDK-free and owned here, the sole subscription
 *  manager.) */
export interface TableHandlers<T> {
  onInsert?: (row: T) => void;
  onUpdate?: (oldRow: T, newRow: T) => void;
  onDelete?: (row: T) => void;
}

type GateTableRowMap = {
  cards: Card;
  souls: Soul;
  soul_privates: SoulPrivate;
  zones: Zone;
  regions: Region;
  // The regions DB's own `cards` table (promoted tile-cards). Schema-identical
  // to a `cards` row; addressed under a distinct logical name so the gate routes
  // it to the regions upstream rather than the cards DB.
  tile_cards: Card;
  // Global world chat (chat DB). Append-only; `sentAt` is the u64 key. Carries
  // genuine string columns (`senderName`, `body`) — see STRING_FIELDS.
  chat_messages: ChatMessage;
  // Players auth DB. `players` is versioned (`validAt` u64 key) and carries a
  // string `name`; `player_profiles` is flat, keyed by `playerId`.
  players: Player;
  player_profiles: PlayerProfile;
};
type GateTable = keyof GateTableRowMap;

/** u64 fields → `bigint`. The wire delivers all *numbers* as strings (so they
 *  survive 64-bit), so a field here becomes `bigint`; a field in
 *  [`STRING_FIELDS`] stays a `string`; everything else becomes `number`. Mirrors
 *  the generated row types. */
const BIGINT_FIELDS: Record<GateTable, ReadonlySet<string>> = {
  cards: new Set(["validAt", "macroZone"]),
  souls: new Set(["validAt", "macroZone"]),
  soul_privates: new Set(["blueprints0"]),
  zones: new Set([
    "validAt", "macroZone",
    "t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7",
    "t8", "t9", "t10", "t11", "t12", "t13", "t14", "t15",
  ]),
  regions: new Set(["validAt", "macroRegion", "zonePresence", "zoneAvailable"]),
  tile_cards: new Set(["validAt", "macroZone"]),
  chat_messages: new Set(["sentAt"]),
  players: new Set(["validAt"]),
  player_profiles: new Set([]),
};

/** Genuine `string` columns — kept verbatim (NOT `Number(...)`'d, which would
 *  yield `NaN`). On the wire a real string and a stringified number are
 *  indistinguishable, so the schema must say which is which. */
const STRING_FIELDS: Partial<Record<GateTable, ReadonlySet<string>>> = {
  chat_messages: new Set(["senderName", "body"]),
  players: new Set(["name"]),
};

function coerce<K extends GateTable>(table: K, raw: RawRow): GateTableRowMap[K] {
  const big = BIGINT_FIELDS[table];
  const str = STRING_FIELDS[table];
  const out: Record<string, unknown> = {};
  for (const k in raw) {
    if (big.has(k)) out[k] = BigInt(raw[k] as string);
    else if (str?.has(k)) out[k] = raw[k];
    else out[k] = Number(raw[k]);
  }
  // `out` is built dynamically from wire columns; the field-by-field coercion
  // above produces the row shape, but TS can't see that, so hop through unknown.
  return out as unknown as GateTableRowMap[K];
}

/** One installed subscription — its scope and the gate sids it owns. */
interface GateSub {
  scopeKey: string;
  parts: { table: GateTable; sid: number }[];
}

interface SubDef {
  table: GateTable;
  filter?: string;
}

/** Safety net for `install`'s applied-wait. The gate sends one `applied` per
 *  sid once a subscription's initial rows have been delivered; we resolve the
 *  install promise on that. But a protocol-level `error` carries no sid (it
 *  can't be correlated back to a waiting sid) and a dropped socket sends
 *  nothing — so without a fallback an awaiter could hang. After this long we
 *  resolve anyway (with a warning) so callers proceed degraded rather than
 *  stall. The happy path resolves in well under a second. */
const APPLIED_TIMEOUT_MS = 10_000;

export class GateSubscriptionManager {
  private readonly conn = sharedGate();
  private readonly handlers = new Map<GateTable, Set<TableHandlers<unknown>>>();
  private readonly subs = new Map<string, GateSub>();
  private readonly sidTable = new Map<number, GateTable>();
  /** Resolvers for in-flight `install` calls awaiting their parts' `applied`
   *  messages, keyed by sid. Resolved by `dispatch` on `applied`, by
   *  `removeByName` if the sub is torn down first, or by the timeout. */
  private readonly pendingApplied = new Map<number, () => void>();
  /** Kept for API parity; the gate read path delivers no reducer events. */
  protected readonly onReducerEvent?: (microsSinceUnixEpoch: bigint) => void;
  /** Fired when the gate broadcasts a `content_changed` push (runtime
   *  add/modify content). The handler re-fetches `/content` and rebuilds. */
  protected readonly onContentChanged?: (version: string) => void;

  constructor(options?: {
    onReducerEvent?: (microsSinceUnixEpoch: bigint) => void;
    onContentChanged?: (version: string) => void;
  }) {
    this.onReducerEvent = options?.onReducerEvent;
    this.onContentChanged = options?.onContentChanged;
    this.conn.setDispatch((msg) => this.dispatch(msg));
    debug.log(["gate"], "GateSubscriptionManager init (connect deferred to first use)", 4);
  }

  /** Register insert/update/delete handlers for a table; returns an
   *  unregister fn. */
  registerTableHandlers<K extends GateTable>(
    table: K,
    handlers: TableHandlers<GateTableRowMap[K]>,
  ): () => void {
    let set = this.handlers.get(table);
    if (!set) {
      set = new Set();
      this.handlers.set(table, set);
    }
    set.add(handlers as TableHandlers<unknown>);
    debug.log(["gate"], `registered handler for "${String(table)}" (${set.size} total)`, 2);
    return () => {
      set!.delete(handlers as TableHandlers<unknown>);
    };
  }

  dispose(): void {
    for (const sub of this.subs.values()) {
      for (const part of sub.parts) this.conn.unsubscribe(part.sid);
    }
    this.subs.clear();
    this.sidTable.clear();
    this.handlers.clear();
    // Resolve any outstanding install waiters so disposal can't strand them.
    for (const resolve of [...this.pendingApplied.values()]) resolve();
    // Don't close the shared connection here — ReducerManager uses it too. It
    // closes on page unload (and HMR full-reloads this module anyway).
  }

  // ---- install / remove -------------------------------------------------

  private install(name: string, scopeKey: string, defs: SubDef[]): Promise<void> {
    const existing = this.subs.get(name);
    if (existing && existing.scopeKey === scopeKey) {
      debug.log(["gate"], `sub "${name}" already active (scope=${scopeKey}), skipping`, 2);
      return Promise.resolve();
    }
    if (existing) this.removeByName(name);

    this.conn.ensureConnected();
    const parts = defs.map((def) => {
      const sid = this.conn.allocId();
      this.sidTable.set(sid, def.table);
      this.conn.subscribe(sid, def.table, def.filter);
      return { table: def.table, sid };
    });
    this.subs.set(name, { scopeKey, parts });
    debug.log(
      ["gate"],
      `subscribe "${name}" scope=${scopeKey} → ${parts
        .map((p) => `${p.table}#${p.sid}`)
        .join(", ")}`,
      3,
    );
    // Resolve only once every part's initial rows have been delivered (the
    // gate's `applied` per sid). Awaiters — notably `MainScene.ensureSoul` —
    // depend on this: the rows must be in the `cards` server tier before they
    // count what they own, or the count reads empty and they act on it (the
    // "always spawns a soul on login" bug). Fire-and-forget callers (`void
    // subscribe*`) ignore the promise and are unaffected.
    return Promise.all(parts.map((p) => this.waitApplied(p.sid))).then(() => {});
  }

  /** Promise that resolves when sid's `applied` arrives (or the safety
   *  timeout / a teardown fires). Idempotent: the resolver self-deletes from
   *  `pendingApplied` so `applied`, timeout, and `removeByName` can't
   *  double-resolve or leak. */
  private waitApplied(sid: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApplied.delete(sid)) {
          debug.warn(["gate"], `sub sid=${sid} not applied within ${APPLIED_TIMEOUT_MS}ms; proceeding`, 4);
          resolve();
        }
      }, APPLIED_TIMEOUT_MS);
      this.pendingApplied.set(sid, () => {
        clearTimeout(timer);
        this.pendingApplied.delete(sid);
        resolve();
      });
    });
  }

  private removeByName(name: string): void {
    const sub = this.subs.get(name);
    if (!sub) return;
    for (const part of sub.parts) {
      this.conn.unsubscribe(part.sid);
      this.sidTable.delete(part.sid);
      // Torn down before `applied` landed — resolve the waiter so an install
      // promise for a since-removed sub can't hang.
      this.pendingApplied.get(part.sid)?.();
    }
    this.subs.delete(name);
  }

  private dispatch(msg: GateMsg): void {
    switch (msg.t) {
      case "row": {
        // Routed by **table**, not sid. The gate registers row callbacks once
        // per table and tags rows with a sentinel sid, so the client fans by the
        // table name the message carries. `sidTable` remains only for `applied`
        // correlation / unsub bookkeeping, not row routing. (Tolerant of the old
        // gate too: it sent the real table on every row.)
        if (!Object.prototype.hasOwnProperty.call(BIGINT_FIELDS, msg.table)) {
          debug.warn(["gate"], `row ${msg.op} for unknown table ${msg.table}`, 4);
          return;
        }
        const table = msg.table as GateTable;
        debug.log(["gate"], `row ${msg.op} ${table}`, 1);
        const row = coerce(table, msg.row);
        if (msg.op === "insert") {
          this.fanOut(table, (h) => h.onInsert?.(row));
        } else if (msg.op === "delete") {
          this.fanOut(table, (h) => h.onDelete?.(row));
        } else {
          const old = coerce(table, msg.old ?? msg.row);
          this.fanOut(table, (h) => h.onUpdate?.(old, row));
        }
        return;
      }
      case "applied":
        // Logged at the connection's recv chokepoint (`← applied sid=N`).
        this.pendingApplied.get(msg.sid)?.();
        return;
      case "time":
        // The gate's server-clock heartbeat — feed the clock discipline so
        // `serverNowMs()` tracks the gate's future-stamp timeline. This is the
        // gate-path replacement for the SDK's reducer-event timestamps.
        this.onReducerEvent?.(BigInt(msg.server_micros));
        return;
      case "error":
        debug.warn(["gate"], msg.error, 4);
        return;
      case "content_changed":
        debug.log(["gate"], `content_changed → version ${msg.version}`, 3);
        this.onContentChanged?.(msg.version);
        return;
    }
  }

  private fanOut(table: GateTable, fn: (h: TableHandlers<unknown>) => void): void {
    const set = this.handlers.get(table);
    if (!set || set.size === 0) {
      debug.warn(["gate"], `no handlers registered for "${table}" — row dropped`, 4);
      return;
    }
    debug.log(["gate"], `fanOut ${table} → ${set.size} handler(s)`, 1);
    for (const h of set) {
      try {
        fn(h);
      } catch (err) {
        console.error(`[gate] ${table} handler threw`, err);
      }
    }
  }

  // ---- subscribe helpers (mirror SubscriptionManager) -------------------

  subscribeCards(zoneId: ZoneId): Promise<void> {
    return this.install(`cards:${zoneId}`, `zone:${zoneId}`, [
      { table: "cards", filter: `macro_zone = ${zoneId}` },
    ]);
  }
  unsubscribeCards(zoneId: ZoneId): void {
    this.removeByName(`cards:${zoneId}`);
  }

  subscribeOwnedCards(ownerId: number): Promise<void> {
    return this.install(`cards:owner:${ownerId}`, `owner:${ownerId}`, [
      { table: "cards", filter: `owner_id = ${ownerId}` },
    ]);
  }
  unsubscribeOwnedCards(ownerId: number): void {
    this.removeByName(`cards:owner:${ownerId}`);
  }

  subscribeWorldZone(key: ZoneId): Promise<void> {
    return this.install(`zones:${key}`, `macroZone:full:${key}`, [
      { table: "zones", filter: `macro_zone = ${key}` },
      { table: "cards", filter: `macro_zone = ${key}` },
      { table: "souls", filter: `macro_zone = ${key}` },
      // Tile-cards (regions DB) promoted on this zone's hexes — same channel as
      // the zone itself so a viewport that sees the zone sees its live tiles.
      { table: "tile_cards", filter: `macro_zone = ${key}` },
    ]);
  }

  subscribeWorldZoneSkeleton(key: ZoneId): Promise<void> {
    return this.install(`zones:${key}`, `macroZone:skeleton:${key}`, [
      { table: "zones", filter: `macro_zone = ${key}` },
    ]);
  }

  unsubscribeWorldZone(key: ZoneId): void {
    this.removeByName(`zones:${key}`);
  }

  subscribeRegion(macroRegion: bigint): Promise<void> {
    return this.install(`region:${macroRegion}`, `region:${macroRegion}`, [
      { table: "regions", filter: `macro_region = ${macroRegion}` },
    ]);
  }
  unsubscribeRegion(macroRegion: bigint): void {
    this.removeByName(`region:${macroRegion}`);
  }

  /** Subscribe to the global chat feed with a `sent_at` cutoff — only rows whose
   *  `sent_at > threshold` (packed u64) flow through. Re-subscribing with a new
   *  threshold replaces the prior window (single `"chat"` scope). */
  subscribeChat(threshold: bigint): Promise<void> {
    return this.install("chat", `since:${threshold.toString()}`, [
      { table: "chat_messages", filter: `sent_at > ${threshold.toString()}` },
    ]);
  }
  unsubscribeChat(): void {
    this.removeByName("chat");
  }

  /** Subscribe to the caller's player row by name (the login lookup). The gate
   *  reads the resulting `player_id` off this same row to establish the session. */
  subscribePlayerByName(name: string): Promise<void> {
    const escaped = name.replace(/'/g, "''");
    return this.install(`player:${name}`, `player:${name}`, [
      { table: "players", filter: `name = '${escaped}'` },
    ]);
  }
  unsubscribePlayerByName(name: string): void {
    this.removeByName(`player:${name}`);
  }

  /** Subscribe to the caller's own `player_profiles` row. */
  subscribePlayerProfile(playerId: number): Promise<void> {
    return this.install(`player_profile:${playerId}`, `player_profile:${playerId}`, [
      { table: "player_profiles", filter: `player_id = ${playerId}` },
    ]);
  }
  unsubscribePlayerProfile(playerId: number): void {
    this.removeByName(`player_profile:${playerId}`);
  }

  subscribeCard(cardId: number): Promise<void> {
    return this.install(`card:${cardId}`, `card:${cardId}`, [
      { table: "cards", filter: `card_id = ${cardId}` },
    ]);
  }
  unsubscribeCard(cardId: number): void {
    this.removeByName(`card:${cardId}`);
  }

  subscribeSoul(cardId: number): Promise<void> {
    return this.install(`soul:${cardId}`, `soul:${cardId}`, [
      { table: "souls", filter: `card_id = ${cardId}` },
    ]);
  }
  unsubscribeSoul(cardId: number): void {
    this.removeByName(`soul:${cardId}`);
  }

  subscribeSoulPrivate(cardId: number): Promise<void> {
    return this.install(`soul_private:${cardId}`, `soul_private:${cardId}`, [
      { table: "soul_privates", filter: `card_id = ${cardId}` },
    ]);
  }
  unsubscribeSoulPrivate(cardId: number): void {
    this.removeByName(`soul_private:${cardId}`);
  }
}

// This module owns a live WebSocket + subscription state, which HMR can't
// meaningfully hot-swap — a partial update orphans the old connection and
// spins up a fresh manager with no subscriptions (the "conn id=2 doesn't
// resolve the same" symptom). Decline HMR so an edit here forces a full page
// reload, giving dev a single clean connection every time.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot?.invalidate("gate connection module changed — full reload");
  });
}
