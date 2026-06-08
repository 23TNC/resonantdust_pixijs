import { debug } from "../../debug";
import { reloadContent } from "../../game/definitions/contentBoot";
import type { CardDefinition, DefinitionManager } from "../../game/definitions/DefinitionManager";
import type { Card, ChatMessage, Player, Region, Soul, SoulPrivate, Zone } from "../spacetime/bindings/types";
// PlayerProfile is canonically the `players` (auth DB) shape now — keyed by
// player_id, no lifecycle fields. The client only reads `playerId` off it.
import type { PlayerProfile } from "../spacetime/bindings/players/types";
import type { ReducerManager } from "../spacetime/ReducerManager";
// Shard reads now route through the gate (relay-first migration): the gate
// fronts the `shard` module, fanning rows back over its own protocol. Drop-in
// for the SDK-backed `SubscriptionManager` — same public surface.
import { GateSubscriptionManager } from "../gate/GateSubscriptionManager";
import {
  applyMicro,
  decodeMacroZone,
  decodeMicro,
  type MacroZone,
  makeMacroZone,
  microIsCard,
  stackBranch,
  stackIndex,
  STACK_STATE_DEFERRED,
} from "./packing";
import { validAtOf, WORLD_LAYER } from "./packing";
import { ValidAtTable, type TableChange, type TableListener } from "./ValidAtTable";
import { AppendTable } from "./AppendTable";
import type { CardManager } from "../../game/cards/CardManager";

/** Decode a server row at the ingestion boundary into the three derived
 *  macro-location forms — the folded packed `macroZone` (`bigint` → `number`,
 *  the location key for equality / keying / SQL), the decoded [`MacroLoc`]
 *  (coords for rendering), and the `surface` band (bits 24-31, for the many
 *  `row.surface` reads). `macro_zone` now encodes surface, so there's no
 *  separate surface column. Every client tier (`ValidAtTable.server` →
 *  `current` → `*Local`) holds all three, so reads never pack or unpack.
 *  Applied to the macro_zone-bearing tables (`cards` / `souls` / `zones`); the
 *  flat `soul_privates` / `player_profiles` carry no `macro_zone`. (Phase 2
 *  extends this to `micro_zone` / `micro_location`.) */
const decodeMacro = <T extends { macroZone: bigint }>(
  row: T,
): Omit<T, "macroZone"> & { macroZone: MacroZone } => ({
  ...row,
  macroZone: decodeMacroZone(row.macroZone),
});

const INVENTORY_LAYER = 1;
/** Bit 4 of `flagsState` — set on soul cards whose `ownerId` is a
 *  `player_id`. Mirrored here so `mirrorCard`'s orphan-slot fallback
 *  can walk the owner chain to find an owning soul without importing
 *  `permissions.ts` (which would create a permissions → GameContext
 *  → DataManager import cycle). Source of truth: `content/cards/flags.json`. */
const FLAG_OWNED_BY_PLAYER = 1 << 24;
/** Bounded walk to mirror `permissions::owningSoul`'s server-side
 *  intent — climb `ownerId` until we land on a soul (card with
 *  `FLAG_OWNED_BY_PLAYER` set). Mirrors the depth cap from
 *  `OWNER_WALK_DEPTH_CAP` in `cards.rs`. */
const OWNER_WALK_DEPTH_CAP = 32;

// Bit masks for the propagating `Card.flags` word. Source of truth:
// `resonantdust_data::flags` (the `flags` section). Mirrored here as
// compile-time constants — DataManager is a hot-path mirror and per-call
// wasm-registry lookups add avoidable overhead. Keep these in sync with the
// registry on any renumber.
//
// Post flags/stock schema split: state bits, placement, and the refcount holds
// ALL live in the single `flags` u32 (see packing.ts). `flagsBk` is now only the
// non-propagating dirty/preserve byte (not read here); `stock` is its own byte.
const FLAG_ACTION_DEAD = 1 << 26;
/** Server *requires* the row's position. Mirror splices on conflict
 *  with the incoming card winning the slot (existing occupant
 *  re-anchors one step up the chain). Overflow past
 *  `MAX_CHAIN_DEPTH` evicts the topmost card via the
 *  inventory→loose→nearby-tile cascade. Paired with
 *  [`FLAG_POS_WANT`] — same splice primitive, opposite winner. */
const FLAG_POS_NEED = 1 << 27;
/** Server *prefers* the row's position. Mirror splices on conflict
 *  with the existing occupant winning the slot (incoming card
 *  stacks above it). Overflow past `MAX_CHAIN_DEPTH` evicts the
 *  topmost card via the inventory→loose→nearby-tile cascade.
 *  Paired with [`FLAG_POS_NEED`] — same splice primitive,
 *  opposite winner. */
const FLAG_POS_WANT = 1 << 28;
// `slot_claim_count` is a u3 refcount at bits 8..=10 of `Card.flags` (the
// exclusive hold, formerly `slot_hold_count`). Mask covers the field's window;
// non-zero means "this card is exclusively held by an in-flight action."
const FLAG_SLOT_HOLD_COUNT_MASK = 0b111 << 8;
// TODO(progress-from-recipe): `progress_style` was cut from the card flag word
// in the flags/stock split. Progress bars are stubbed off until the client
// derives the bar from the driving recipe instead of a per-card field.
const FLAG_PROGRESS_STYLE_SHIFT = 0;
const FLAG_PROGRESS_STYLE_MASK = 0;
const LIFECYCLE_PROGRESS_STYLE = 0;
/** A single progress indicator on a card. Today the `progress` array on
 *  `LocalCard` is populated with at most one entry (the future
 *  completion row with the highest `valid_at`, last-write-wins). The
 *  list shape is forward-looking — when a card has multiple in-flight
 *  events, `mirrorCard` will fill out one entry per future completion
 *  row and the renderer will stack them. */
export interface ProgressInfo {
  /** u3 `progress_style` field from the completion row's `flags`.
   *  Values: 0 = no bar (filtered out before insertion into the list),
   *  1 = ltr / cw, 2 = rtl / ccw, 3..=7 reserved. */
  style: number;
  /** unix-seconds when this progress started — the `valid_at` of the
   *  card's currently-in-effect row (the held / in-flight one). */
  startSecs: number;
  /** unix-seconds when this progress ends — the `valid_at` of the
   *  completion row that carries `progress_style`. */
  endSecs: number;
}

/** Local-overlay row: server `Card` plus client-only annotations.
 *  - `dead = 1` — mirror saw `flags & FLAG_ACTION_DEAD`. Triggers the
 *    death animation on the layout side.
 *  - `dead = 2` — layout has finished the death animation and wrote
 *    back. The mirror preserves `2` even on subsequent pushes that
 *    still carry the flag, so we don't replay the animation.
 *  - `progress` — array of in-flight progress indicators sourced from
 *    future-validAt rows in `data.cards.server` whose `progress_style`
 *    bits are non-zero. Populated by `mirrorCard` on every update;
 *    cleared when no eligible future row exists. Today the list is
 *    populated with at most one entry; long-term it'll hold one per
 *    queued event.
 *  - `def` — decoded definition for `packedDefinition`. Populated at
 *    row-write time so consumers don't re-pay the wasm `decode` cost
 *    on every read. `mirrorCard` re-decodes only when `packedDefinition`
 *    actually changed; `setLocalCard` backfills if missing. The
 *    decoded value is `null` for an unknown packed id (matches
 *    `DefinitionManager.decode`'s return contract). */
export type LocalCard = Card & {
  dead?: 1 | 2;
  progress?: ProgressInfo[];
  def?: CardDefinition | null;
};

/** Local data layer with two tiers:
 *
 *  **Server tier** — `ValidAtTable<T>` instances (`cards`, `players`,
 *  `zones`). The server holds many rows per id, each keyed by a packed
 *  u64 `(high32 = id, low32 = valid_at seconds)`. `server` mirrors every
 *  row we believe the server has; `current` holds the row currently valid
 *  for each id, as of the most recent `promote(now)` call. These represent
 *  pure server state — **don't write client mutations here.**
 *
 *  **Local tier** — per-table `Map<id, T>` overlays (`cardsLocal`,
 *  `playersLocal`, `zonesLocal`). Each starts empty and tracks its
 *  matching `ValidAtTable.current` via subscription: `added` / `updated`
 *  events copy the row in, `removed` events delete the key. The overlay
 *  is what game code reads / writes for displayed state.
 *
 *  **Mirror policy** — server is authoritative; mirror events propagate
 *  in full *except* when the cards-specific `mirrorCard` rule fires (see
 *  there). `setLocalCard` simply writes to the overlay and emits a local
 *  event; on the next server push for that key, `mirrorCard` decides
 *  whether to keep position fields or not. There is no all-or-nothing
 *  override flag — server changes never get dropped wholesale.
 *
 *  DataManager owns its own `GateSubscriptionManager` — the gate ingress
 *  for this layer. `subscribeCards(zoneId)` / etc. are reachable as
 *  `data.subscriptions.<method>`. */
export class DataManager {
  readonly cards = new ValidAtTable<Card>(
    (row) => row.validAt,
    (row) => row.cardId,
  );
  readonly players = new ValidAtTable<Player>(
    (row) => row.validAt,
    (row) => row.playerId,
  );
  readonly souls = new ValidAtTable<Soul>(
    (row) => row.validAt,
    (row) => row.cardId,
  );
  readonly zones = new ValidAtTable<Zone>(
    (row) => row.validAt,
    (row) => row.zoneId,
  );
  /** Region spawn-gating rows (presence/availability bitfields), keyed by
   *  `macro_region`. `ValidAtTable` keys `current` by `number`, so we narrow
   *  `macroRegion` via `Number(...)` — safe for world regions (`card_id 0`,
   *  surface 64 → `< 2^53`); container regions (high `card_id` bits) would
   *  overflow, revisit when those exist. No `*Local` overlay: ZoneManager holds
   *  the bits it needs (fed from `regions.subscribe` in `main.ts`). */
  readonly regions = new ValidAtTable<Region>(
    (row) => row.validAt,
    (row) => Number(row.macroRegion),
  );
  /** Flat (non-versioned) world-chat feed. Server inserts append-only;
   *  there is no `current` view to promote — `chatMessages.rows` is
   *  the table itself. See `AppendTable` and `chat.rs`. */
  readonly chatMessages = new AppendTable<ChatMessage>((row) => row.sentAt);
  readonly subscriptions: GateSubscriptionManager;

  /** Local overlays — what game code reads/writes for displayed state.
   *  Mirrors `<table>.current` via subscription. */
  readonly cardsLocal = new Map<number, LocalCard>();
  readonly playersLocal = new Map<number, Player>();
  readonly soulsLocal = new Map<number, Soul>();
  readonly zonesLocal = new Map<number, Zone>();
  /** Per-soul private state, keyed by `card_id`. Flat (no history) —
   *  mirrors the `soul_privates` server table 1:1 from
   *  `subscribeSoulPrivate(soulCardId)`. Each client typically holds
   *  exactly one row (for the active soul). */
  readonly soulPrivatesLocal = new Map<number, SoulPrivate>();
  /** Per-player profile state, keyed by `player_id`. Flat (no
   *  history). Mirrored from `subscribePlayerProfile(playerId)` —
   *  installed once at login, so the client typically holds exactly
   *  one row (for the local player). */
  readonly playerProfilesLocal = new Map<number, PlayerProfile>();

  private readonly unsubMirror: Array<() => void> = [];

  /** Listeners on the local cards overlay. Fire on every overlay change —
   *  mirror-driven (server pushes that pass through `mirrorCard`) AND
   *  client-driven (`setLocalCard` / `clearLocalCard`). */
  private readonly cardLocalListeners = new Set<TableListener<LocalCard>>();
  private readonly cardLocalKeyListeners = new Map<number, Set<TableListener<LocalCard>>>();

  /** Server-time of the previous `promote()` call. Used by
   *  `kickProgressExpiries` to detect progress entries whose `endSecs`
   *  was in the future last frame and is in the past this frame. `null`
   *  on the first promote — that fire seeds the timestamp without
   *  firing kicks, so a fresh subscription's historical-progress
   *  endpoints don't spuriously trigger. */
  private lastProgressCheckMs: number | null = null;

  /** Listeners on the local souls overlay. Same shape as the cards
   *  variants but keyed on Soul rows. RectCard's resource meter
   *  subscribes per-card-id so it only redraws when the matching
   *  soul row updates. */
  private readonly soulLocalKeyListeners = new Map<number, Set<TableListener<Soul>>>();
  /** Global soul-overlay listeners — fire on every soul change. The
   *  per-key variant is more efficient for "watch one soul" but has
   *  the failure mode that a listener registered for cardId X
   *  receives nothing if mirrorSoul fires with a different
   *  `change.key`. Consumers that just need "any soul changed,
   *  invalidate yourself" (e.g. the resource meter on a soul rect
   *  card) use this global variant for reliability. */
  private readonly soulLocalListeners = new Set<TableListener<Soul>>();
  /** CardManager handle, injected post-construction via
   *  [`setCardManager`] (CardManager depends on DataManager, so the
   *  constructor wiring can't be circular). Used by `mirrorCard`'s
   *  state-1 SLOT branch to invoke `insertIntoSlotChain` /
   *  `evictCard` when an incoming `pos_need` / `pos_want` row
   *  collides with a loaded card. Null in the brief window between
   *  DataManager construction and CardManager wiring, and in unit-
   *  test fixtures that don't bring a CardManager up; the
   *  splice/evict code paths are guarded on this being non-null and
   *  fall through to the legacy "preserve / forced overwrite"
   *  behavior when missing. */
  private cardManager: CardManager | null = null;

  constructor(
    private readonly reducers: ReducerManager,
    private readonly definitions: DefinitionManager,
  ) {
    // Thread the reducer-event timestamp from `SubscriptionManager` into
    // `ReducerManager.noteServerTime` so the client's server-clock
    // estimate gets re-baselined on every reducer commit. `promote()`
    // then reads from `reducers.serverNowMs()` instead of
    // `Date.now()`, aligning `ValidAtTable` promotion to the
    // server's timeline.
    this.subscriptions = new GateSubscriptionManager({
      onReducerEvent: (micros) => this.reducers.noteServerTime(micros),
      // Gate pushed a runtime add/modify: re-fetch + rebuild the content
      // runtimes. `DefinitionManager` drops its caches via `onContentReloaded`;
      // existing instances keep their version's def (lineage), so no re-render is
      // forced — new content shows when new instances decode against it.
      onContentChanged: () => {
        reloadContent().catch((err) =>
          debug.warn(["gate"], `content reload failed: ${String(err)}`, 4),
        );
      },
    });
    // players/player_profiles now flow through the gate too; the clock-sync
    // re-baseline rides the gate's `time` heartbeat via `this.subscriptions`'
    // `onReducerEvent` (wired above), not a players-SDK reducer event.

    this.subscriptions.registerTableHandlers("cards", {
      onInsert: (row) => {
        const r = decodeMacro(row);
        this.cards.insert(r);
        this.kickFutureProgress(r);
      },
      onUpdate: (oldRow, newRow) => {
        const n = decodeMacro(newRow);
        this.cards.update(decodeMacro(oldRow), n);
        this.kickFutureProgress(n);
      },
      onDelete: (row) => this.cards.delete(decodeMacro(row)),
    });
    // Tile-cards live in the regions DB's own `cards` table (promoted world
    // tiles, `card_type = 7`). They share the Card schema and a disjoint
    // id-space (the regions database bit in `card_id`), so we mirror them into
    // the SAME `this.cards` overlay — the recipe matcher's tile lookup and the
    // ZoneTileCache read them like any other card, and a GC demote arrives as a
    // delete that drops the card back to its (now folded-back) zone slot.
    this.subscriptions.registerTableHandlers("tile_cards", {
      onInsert: (row) => {
        const r = decodeMacro(row);
        this.cards.insert(r);
        this.kickFutureProgress(r);
      },
      onUpdate: (oldRow, newRow) => {
        const n = decodeMacro(newRow);
        this.cards.update(decodeMacro(oldRow), n);
        this.kickFutureProgress(n);
      },
      onDelete: (row) => this.cards.delete(decodeMacro(row)),
    });
    this.subscriptions.registerTableHandlers("players", {
      onInsert: this.players.insert,
      onUpdate: this.players.update,
      onDelete: this.players.delete,
    });
    this.subscriptions.registerTableHandlers("souls", {
      onInsert: (row) => this.souls.insert(decodeMacro(row)),
      onUpdate: (oldRow, newRow) =>
        this.souls.update(decodeMacro(oldRow), decodeMacro(newRow)),
      onDelete: (row) => this.souls.delete(decodeMacro(row)),
    });
    // `soul_privates` is flat (no validAt history), so we mirror it
    // directly into `soulPrivatesLocal` instead of routing through a
    // `ValidAtTable`. The server only inserts/updates one row per
    // soul card_id; this client typically holds the row for its
    // active soul (subscribed via `SoulManager`).
    this.subscriptions.registerTableHandlers("soul_privates", {
      onInsert: (row) => {
        this.soulPrivatesLocal.set(row.cardId, row);
      },
      onUpdate: (_oldRow, newRow) => {
        this.soulPrivatesLocal.set(newRow.cardId, newRow);
      },
      onDelete: (row) => {
        this.soulPrivatesLocal.delete(row.cardId);
      },
    });
    // Same flat-row pattern as `soul_privates` above — the server
    // table is keyed by `player_id` and updated in place via
    // delete + insert; we mirror straight into `playerProfilesLocal`.
    this.subscriptions.registerTableHandlers("player_profiles", {
      onInsert: (row) => {
        this.playerProfilesLocal.set(row.playerId, row);
      },
      onUpdate: (_oldRow, newRow) => {
        this.playerProfilesLocal.set(newRow.playerId, newRow);
      },
      onDelete: (row) => {
        this.playerProfilesLocal.delete(row.playerId);
      },
    });
    this.subscriptions.registerTableHandlers("zones", {
      onInsert: (row) => this.zones.insert(decodeMacro(row)),
      onUpdate: (oldRow, newRow) =>
        this.zones.update(decodeMacro(oldRow), decodeMacro(newRow)),
      onDelete: (row) => this.zones.delete(decodeMacro(row)),
    });
    // Regions carry no `macro_zone` (just `macro_region` + bitfields), so they
    // skip `decodeMacro` and store raw.
    this.subscriptions.registerTableHandlers("regions", {
      onInsert: this.regions.insert,
      onUpdate: this.regions.update,
      onDelete: this.regions.delete,
    });
    // Chat now flows through the gate (the `chat_messages` table is fronted by
    // the gate like cards/regions); append-only mirror into `chatMessages`.
    this.subscriptions.registerTableHandlers("chat_messages", {
      onInsert: this.chatMessages.insert,
      onUpdate: this.chatMessages.update,
      onDelete: this.chatMessages.delete,
    });

    // Mirror server tier → local overlay. Server pushes always propagate;
    // `mirrorCard` may keep position fields from the local row in the
    // inventory-loose case (see there).
    this.unsubMirror.push(this.cards.subscribe((c) => this.mirrorCard(c)));
    this.unsubMirror.push(
      this.players.subscribe((c) => this.mirror(this.playersLocal, c)),
    );
    this.unsubMirror.push(
      this.souls.subscribe((c) => this.mirrorSoul(c)),
    );
    this.unsubMirror.push(
      this.zones.subscribe((c) => this.mirror(this.zonesLocal, c)),
    );
  }

  /** Write a row into the local cards overlay and fire the local-cards
   *  listeners (added/updated as appropriate). Server is still
   *  authoritative — the next mirror event will replace this row, except
   *  for the position fields preserved by `mirrorCard`'s inventory-loose
   *  rule. Use for client-driven row writes (e.g. drag-drop on commit). */
  setLocalCard(id: number, row: LocalCard): void {
    const prev = this.cardsLocal.get(id);
    // Backfill the decoded def cache. Callers typically spread from
    // an existing `cardsLocal` row (which already carries `def` from
    // `mirrorCard`), so this branch usually no-ops. The defensive
    // path covers any future caller that constructs a row from
    // scratch or swaps `packedDefinition`.
    if (row.def === undefined || (prev && prev.packedDefinition !== row.packedDefinition)) {
      row = { ...row, def: this.definitions.decode(row.packedDefinition) };
    }
    this.cardsLocal.set(id, row);
    if (prev === undefined) {
      this.fireCardLocal({ kind: "added", key: id, row });
    } else if (prev !== row) {
      this.fireCardLocal({ kind: "updated", key: id, oldRow: prev, newRow: row });
    }
  }

  /** Subscribe to every local-cards-overlay change. Fires for both
   *  mirror-driven server pushes and client-driven `setLocal`/`clearLocal`
   *  calls. Returns an unsubscribe fn. */
  /** Inject the CardManager handle. Called once during boot after
   *  both managers are constructed (CardManager needs DataManager
   *  available at construction). After this fires, `mirrorCard`'s
   *  state-1 splice path becomes active. Idempotent. */
  setCardManager(cards: CardManager): void {
    this.cardManager = cards;
  }

  subscribeLocalCard(listener: TableListener<LocalCard>): () => void {
    this.cardLocalListeners.add(listener);
    return () => {
      this.cardLocalListeners.delete(listener);
    };
  }

  /** Subscribe to local-cards-overlay changes for a single id. Subscribing
   *  to a not-yet-existing id is fine — the listener fires when the row
   *  arrives. Returns an unsubscribe fn. */
  subscribeLocalCardKey(key: number, listener: TableListener<LocalCard>): () => void {
    let set = this.cardLocalKeyListeners.get(key);
    if (!set) {
      set = new Set();
      this.cardLocalKeyListeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const s = this.cardLocalKeyListeners.get(key);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.cardLocalKeyListeners.delete(key);
    };
  }

  setLocalPlayer(id: number, row: Player): void {
    this.playersLocal.set(id, row);
  }

  /** Subscribe to local-souls-overlay changes for a single soul-card
   *  id. Subscribing to a not-yet-existing id is fine — the listener
   *  fires when the row arrives. Returns an unsubscribe fn. */
  /** Subscribe to every local-souls-overlay change. Fires on every
   *  mirrorSoul push regardless of which soul changed. Use for
   *  invalidation triggers where the listener already knows which
   *  soul to read (and only cares "something changed, recheck").
   *  Returns an unsubscribe fn. */
  subscribeLocalSoul(listener: TableListener<Soul>): () => void {
    this.soulLocalListeners.add(listener);
    return () => {
      this.soulLocalListeners.delete(listener);
    };
  }

  subscribeLocalSoulKey(key: number, listener: TableListener<Soul>): () => void {
    let set = this.soulLocalKeyListeners.get(key);
    if (!set) {
      set = new Set();
      this.soulLocalKeyListeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const s = this.soulLocalKeyListeners.get(key);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.soulLocalKeyListeners.delete(key);
    };
  }

  /** Mirror Soul rows into the local overlay and fire per-key
   *  listeners. Unlike `mirrorCard`, souls carry no client-only
   *  annotations — the server is authoritative for every field —
   *  so this is a straight copy-through with the fan-out attached. */
  private mirrorSoul(change: TableChange<Soul>): void {
    if (change.kind === "removed") {
      if (!this.soulsLocal.has(change.key)) return;
      this.soulsLocal.delete(change.key);
      this.fireSoulLocalKey(change);
      return;
    }
    const row = change.kind === "added" ? change.row : change.newRow;
    this.soulsLocal.set(change.key, row);
    this.fireSoulLocalKey(change);
  }

  private fireSoulLocalKey(change: TableChange<Soul>): void {
    if (this.soulLocalListeners.size > 0) {
      for (const l of [...this.soulLocalListeners]) {
        try {
          l(change);
        } catch (err) {
          console.error("[DataManager] souls local listener threw", err);
        }
      }
    }
    const set = this.soulLocalKeyListeners.get(change.key);
    if (!set || set.size === 0) return;
    for (const l of [...set]) {
      try {
        l(change);
      } catch (err) {
        console.error("[DataManager] souls local key listener threw", err);
      }
    }
  }

  setLocalZone(id: number, row: Zone): void {
    this.zonesLocal.set(id, row);
  }

  /** Promote every table's `current` view to the server's estimated
   *  current time (unix milliseconds, float). Reads from
   *  `ReducerManager.serverNowMs()` so promotion aligns with the
   *  server's `valid_at` timeline — before any reducer event has
   *  landed, that falls back to local wall-clock; after the first
   *  reducer commit, every subsequent reducer event re-baselines the
   *  offset so server-stamped future rows promote at the right
   *  moment from the client's perspective. */
  promote(): void {
    const now = this.reducers.serverNowMs();
    this.cards.promote(now);
    this.players.promote(now);
    this.souls.promote(now);
    this.zones.promote(now);
    this.regions.promote(now);
    this.kickProgressExpiries(now);
  }

  /** Re-fire `updated` events for cards whose progress endpoint just
   *  crossed `now`. Generalizes the "card changed → recheck recipe
   *  triggers" pattern to time-based transitions that have no
   *  associated server row promote:
   *
   *  - **Synthetic magnetic-expiry progress** ([`mirrorCard`]) ends at
   *    `installValidAt + lifecycleDurationMs`. No server row promotes
   *    at that moment, so without this kick, the
   *    [`LifecycleResolutionManager`] never wakes up to fire the
   *    failure recipe.
   *  - **Action-completion progress** ends when the completion row
   *    itself promotes — that promote fires its own `updated` event
   *    already, so the re-fire here is redundant but harmless.
   *
   *  Comparison: each progress's `endSecs` is checked against the
   *  `(lastProgressCheckMs, now]` half-open interval. First call after
   *  a session start seeds `lastProgressCheckMs` without firing — a
   *  re-subscribe could otherwise replay every historical endpoint at
   *  once. */
  private kickProgressExpiries(nowMs: number): void {
    const last = this.lastProgressCheckMs;
    this.lastProgressCheckMs = nowMs;
    if (last === null) return;
    if (nowMs <= last) return;
    for (const [id, row] of this.cardsLocal) {
      if (row.progress === undefined) continue;
      let kick = false;
      for (const p of row.progress) {
        if (p.endSecs > last && p.endSecs <= nowMs) {
          kick = true;
          break;
        }
      }
      if (kick) {
        this.fireCardLocal({ kind: "updated", key: id, oldRow: row, newRow: row });
      }
    }
  }

  /** Tear down: drop mirror subscriptions, dispose the SubscriptionManager
   *  (drops its connection listener and clears the subscription registry),
   *  every table (clears rows + listener sets), and the local overlays. */
  dispose(): void {
    for (const unsub of this.unsubMirror) unsub();
    this.unsubMirror.length = 0;
    this.subscriptions.dispose();
    this.cards.dispose();
    this.players.dispose();
    this.souls.dispose();
    this.zones.dispose();
    this.regions.dispose();
    this.cardsLocal.clear();
    this.playersLocal.clear();
    this.soulsLocal.clear();
    this.zonesLocal.clear();
    this.cardLocalListeners.clear();
    this.cardLocalKeyListeners.clear();
    this.soulLocalKeyListeners.clear();
    this.soulLocalListeners.clear();
  }

  private mirror<T>(
    map: Map<number, T>,
    change: TableChange<T>,
  ): void {
    if (change.kind === "removed") {
      map.delete(change.key);
    } else {
      map.set(change.key, change.kind === "added" ? change.row : change.newRow);
    }
  }

  /** Card-specific mirror with three preserve cases, all keyed on the
   *  same principle: **the client owns visual position by default;
   *  `FLAG_POS_NEED` / `FLAG_POS_WANT` are the server's opt-out
   *  (required-position and advisory-position respectively).**
   *
   *  - **Loose preserve**: `state === STACKED_LOOSE`. Position is
   *    fully client-managed (drag-drop, splice transplants, etc.) —
   *    the server never asserts a meaningful position for a loose
   *    card, so we unconditionally preserve local's `macroZone` /
   *    `microZone` / `microLocation` / `surface`.
   *
   *  - **Slot preserve**: `state === STACKED_SLOT`. The server writes
   *    `microLocation = predecessor` + `microZone = direction` when
   *    asserting chain shape (e.g. `propose_action`'s slot[1..]
   *    writes). Honor `FLAG_POS_NEED` / `FLAG_POS_WANT` — without
   *    either set, the row is a pure flags update and the local
   *    chain (as arranged by `setCardPosition`) stands. With one set,
   *    server's spatial lands verbatim (subject to the splice +
   *    eviction primitives — see Phase 3+).
   *
   *  - **Stack preserve** (state-2 OnRoot, inventory): same
   *    `pos_need` / `pos_want` gate. The placement-assertion bits
   *    used to live in `microZone` bit 2 alongside `position` /
   *    `direction`; moved out to `flags` so `microZone` could carry
   *    the chain `direction` instead.
   *
   *  When the **stack layout** applies AND `pos_need` or `pos_want`
   *  is set, the server is asserting a specific chain position. We
   *  take server's position as-is AND renumber any *other*
   *  client-only cards in the same `(root_id, direction)` group
   *  whose position ≥ the forced one by +1 — they "stack after" the
   *  server's confirmed position. */
  /** Walk `startOwnerId` up the `ownerId` chain in `cardsLocal` until a
   *  `card_type == soul` card is found, returning its `card_id`. `null`
   *  when the walk terminates without one (chain reaches the world via
   *  `ownerId === 0`, hits a missing parent due to a subscription gap, or
   *  trips `OWNER_WALK_DEPTH_CAP`).
   *
   *  Mirrors `permissions::owningSoul`'s walk but is duplicated here to
   *  avoid a `permissions.ts → GameContext → DataManager → permissions.ts`
   *  import cycle. Both read the same overlay so they agree. Souls are
   *  identified by card_type, NOT `is_owned_by_player` — that flag marks
   *  only the player-boundary `player_soul`, while the inventory bucket we
   *  want is the nearest *rendered* soul (e.g. a `human` two hops below
   *  the player_soul).
   *
   *  Used by `mirrorCard`'s orphan-slot fallback to figure out which
   *  soul's inventory an orphaned chain card should land in. */
  private findOwningSoulId(startOwnerId: number): number | null {
    let cur = startOwnerId;
    for (let i = 0; i < OWNER_WALK_DEPTH_CAP; i++) {
      if (cur === 0) return null;
      const row = this.cardsLocal.get(cur);
      if (!row) return null;
      if (this.definitions.isCardType(row.packedDefinition, "soul")) return cur;
      if (row.ownerId === 0) return null;
      cur = row.ownerId;
    }
    return null;
  }

  private mirrorCard(change: TableChange<Card>): void {
    const prev = this.cardsLocal.get(change.key);

    const nowSecs = (Date.now() / 1000).toFixed(3);

    if (change.kind === "removed") {
      debug.log(
        ["spacetime"],
        `[spacetime] card row removed t=${nowSecs} id=${change.key} prev=${prev ? `flagsState=0x${prev.flags.toString(16)} flagsBk=0x${prev.flags.toString(16)} microLocation=${prev.microLocation} macroZone=${prev.macroZone.packed} surface=${prev.macroZone.surface}` : "absent"}`,
        0,
      );
      if (prev === undefined) return;
      this.cardsLocal.delete(change.key);
      this.fireCardLocal({ kind: "removed", key: change.key, oldRow: prev });
      return;
    }

    const serverRow = change.kind === "added" ? change.row : change.newRow;
    // Flat-root placement of the incoming row: loose vs stacked-member vs
    // deferred (a stacked member in the deferred branch).
    const serverMicro = decodeMicro(serverRow.microLocation, serverRow.flags);
    const isStackedMember =
      serverMicro.kind === "stacked" && serverMicro.branch !== STACK_STATE_DEFERRED;
    const isDeferred =
      serverMicro.kind === "stacked" && serverMicro.branch === STACK_STATE_DEFERRED;
    debug.log(
      ["spacetime"],
      `[spacetime] card row ${change.kind} t=${nowSecs} id=${change.key} validAt=${validAtOf(serverRow.validAt)} isCard=${microIsCard(serverRow.flags)} flagsState=0x${serverRow.flags.toString(16)} flagsBk=0x${serverRow.flags.toString(16)} microLocation=${serverRow.microLocation} macroZone=${serverRow.macroZone.packed} surface=${serverRow.macroZone.surface}`,
      0,
    );

    // Skip already-dead first-arrival rows. When the client re-
    // subscribes (login, zone change), the SDK replays every row in
    // scope, including historical card_ids whose latest row is dead
    // (awaiting the periodic GC sweep). Without this gate we'd write
    // a `dead: 1` row into `cardsLocal` and fire "added" → CardManager
    // spawns a sprite → Card.ts plays the death animation → splice
    // bookkeeping fires. All of that for a card the player should
    // never see. Bail before any of it: don't write the row, don't
    // fire the event. If a fresh row for the same id arrives later
    // it'll come in as "added" again and we'll handle it correctly.
    if (prev === undefined && (serverRow.flags & FLAG_ACTION_DEAD) !== 0) {
      return;
    }

    // State-3 STACKED_DEFERRED short-circuit. Deferred rows declare
    // an intent (host_id in microLocation + fallback q/r in
    // microZone) that gets resolved client-side at this mirror moment
    // — the cascade in `CardManager.appendAtChainLeaf` walks the
    // host's chain, picks a leaf, and writes a concrete state-1/2
    // row to `cardsLocal` via `setLocalCard`. The rest of mirrorCard
    // (preserve gates, splice path, baseRow construction) is meant
    // for state-0/1/2 rows where the server-asserted position is
    // already concrete; for state-3 the cascade is the authoritative
    // writer and we bail here. Falls back to the preserve path when
    // no CardManager is wired yet (boot window before
    // `setCardManager` runs) so the row at least lands somewhere.
    if (isDeferred && this.cardManager !== null) {
      this.cardManager.appendAtChainLeaf(serverRow);
      // The cascade writes via `setLocalCard` which fires per-key
      // listeners but not the global add/update listener that
      // mirrorCard would have fired. Fire one now so downstream
      // observers (Card.onDataChange, inventory layout, recipe
      // matcher) see the new resolved row. Read back from
      // `cardsLocal` because the cascade may have rewritten more
      // than just `change.key` worth of fields (q/r, surface, etc.).
      const resolved = this.cardsLocal.get(change.key);
      if (resolved) {
        if (prev === undefined) {
          this.fireCardLocal({ kind: "added", key: change.key, row: resolved });
        } else if (prev !== resolved) {
          this.fireCardLocal({ kind: "updated", key: change.key, oldRow: prev, newRow: resolved });
        }
      }
      return;
    }

    // Defensive: state-1 (Slot) requires a present parent row at
    // `microLocation`. The server can't see the client's local overlay
    // — if for any reason the parent isn't here (subscription gap,
    // server bug, deletion race) the slot is an orphan and would
    // never render correctly. Force back to owner-inventory loose
    // (macroZone = owning soul, surface = 1, state = STACKED_LOOSE)
    // so the card is visible and recoverable. The macroZone (inventory
    // bucket) is resolved by walking the owner chain to the nearest
    // `card_type == soul` — see `findOwningSoulId` below — since
    // post ownership/position split `ownerId` may point at another
    // rect rather than directly at the soul. Same recovery shape that
    // `CardManager.releaseSlotDescendants` uses on the splice path.
    //
    // **Gated on `prev === undefined`** — when the client already has
    // a local row for this card, that overlay is the source of truth
    // for the card's visual position (e.g. a splice transplanted the
    // card to a real xy moments earlier). The orphan-fallback would
    // clobber that with `microLocation: 0` → snap to inventory's
    // top-left. The state-1 preserve gate below handles "server sent
    // a stale chain reference, client owns position" correctly when
    // prev exists, so we let it through. The (0, 0) fallback is
    // strictly for the no-local-row case (initial sub / never-seen
    // card whose first push is an orphan slot).
    const orphanSlot =
      prev === undefined &&
      isStackedMember &&
      serverRow.microLocation !== change.key &&
      !this.cardsLocal.has(serverRow.microLocation);

    let preservePosition = false;
    let serverForcesStackPosition = false;
    if (!orphanSlot) {
      if (serverMicro.kind === "loose") {
        // Loose position is client-local by default (drag/splice transplants the
        // server view shouldn't clobber); the server only wins when it asserts a
        // forced placement via `pos_need` / `pos_want`. (There is no longer a
        // loose "kind" to split position-ownership on — snap is render-only.)
        const forced = (serverRow.flags & (FLAG_POS_NEED | FLAG_POS_WANT)) !== 0;
        preservePosition = !forced;
      } else {
        // Stacked member (deferred already short-circuited above). The client
        // owns the chain locally unless the server asserts `pos_need` /
        // `pos_want` (a forced placement, resolved by the splice path below).
        const forced = (serverRow.flags & (FLAG_POS_NEED | FLAG_POS_WANT)) !== 0;
        preservePosition = !forced;
        serverForcesStackPosition = forced;
      }
    }

    // Orphan-slot fallback target: walk the orphaned card's `ownerId`
    // chain to find an owning soul (a card with FLAG_OWNED_BY_PLAYER).
    // Under the legacy "`ownerId` doubles as the inventory bucket"
    // model this was a one-hop read; post ownership/position split,
    // `ownerId` is just ownership and may point at another rect
    // before reaching the soul. Falls back to `serverRow.ownerId`
    // directly when the walk can't find a soul (truly orphaned chain
    // with no player-owned ancestor).
    const orphanInventoryBucket = orphanSlot
      ? this.findOwningSoulId(serverRow.ownerId) ?? serverRow.ownerId
      : 0;

    let baseRow: Card;
    if (orphanSlot) {
      // Orphaned member (root not loaded) → loose-rect at cell (0,0) in the
      // owning soul's inventory bucket so it's visible + recoverable.
      const placed = applyMicro(
        { kind: "loose", localQ: 0, localR: 0, x: 0, y: 0 },
        serverRow.flags,
      );
      baseRow = {
        ...serverRow,
        macroZone: makeMacroZone(orphanInventoryBucket, INVENTORY_LAYER, 0, 0),
        microLocation: placed.microLocation,
        flags: placed.flags,
      };
    } else if (preservePosition && prev !== undefined) {
      // Keep the local placement (cell/offset or root/branch/index) over the
      // server's, but adopt the server's other flags (holds, dirty markers).
      const placed = applyMicro(decodeMicro(prev.microLocation, prev.flags), serverRow.flags);
      baseRow = {
        ...serverRow,
        macroZone: prev.macroZone,
        microLocation: placed.microLocation,
        flags: placed.flags,
      };
    } else {
      baseRow = serverRow;
    }

    // State-1 SLOT splice for `pos_need` / `pos_want` conflicts.
    // `baseRow` above captures the no-conflict outcome (server
    // verbatim when forced, preserved-local otherwise). When the
    // server is asserting a state-1 position AND that slot is
    // currently held by a *different* loaded card, splice the chain
    // to resolve the collision: `pos_need` makes incoming win the
    // slot (existing occupant re-anchors above); `pos_want` makes
    // incoming stack above the occupant. Chain growth past
    // `MAX_CHAIN_DEPTH` evicts the topmost card via the
    // inventory→loose→nearby-tile cascade in `evictCard`.
    //
    // The splice writes the *partner* card directly via
    // `setLocalCard`; the incoming row it returns folds back into
    // `baseRow` so the single authoritative `cardsLocal.set` below
    // remains the one write for `change.key`.
    let spliceOverflow: Card | null = null;
    if (
      !orphanSlot &&
      serverMicro.kind === "stacked" &&
      serverMicro.branch !== STACK_STATE_DEFERRED &&
      (serverRow.flags & (FLAG_POS_NEED | FLAG_POS_WANT)) !== 0 &&
      this.cardManager !== null
    ) {
      // A different local card already occupies the forced (root, branch, index)
      // slot? Splice to resolve the collision.
      const occupant = this.cardManager.findMemberAt(
        serverMicro.root,
        serverMicro.branch,
        serverMicro.index,
        change.key,
      );
      if (occupant && occupant.cardId !== change.key) {
        // `pos_need` outranks `pos_want` when both bits are set —
        // need's "incoming wins" semantic is the stricter assertion.
        const nAbove =
          (serverRow.flags & FLAG_POS_NEED) === 0 &&
          (serverRow.flags & FLAG_POS_WANT) !== 0;
        const result = this.cardManager.insertIntoSlotChain(serverRow, occupant, nAbove);
        baseRow = result.incomingRow;
        spliceOverflow = result.overflowTop;
      }
    }
    // Preserve `dead: 2` once the layout has finished its animation —
    // otherwise a subsequent server push with the flag still set would
    // regress us to `1` and replay the animation.
    const flagDead = (serverRow.flags & FLAG_ACTION_DEAD) !== 0;
    const dead: 1 | 2 | undefined = flagDead
      ? (prev?.dead === 2 ? 2 : 1)
      : undefined;
    // Scan the server tier for any future-validAt row of this card_id
    // whose `progress_style` bits are non-zero — those are completion
    // rows announcing an in-flight event for the client to render. With
    // last-write-wins, pick the row with the highest `validAt` (the
    // latest written, in time). The list shape on `LocalCard.progress`
    // is forward-looking: a later iteration can return all matching
    // rows for stacked indicators.
    let progress = this.scanProgress(change.key, baseRow);
    // Continuity carry: when an intermediate row promotes for a card
    // that's already mid-action (e.g. a magnetic commit's
    // release+set_start row landing at `commit_at` between the
    // initial pull row at `T` and the death row at `T + delay +
    // inner.duration`), `scanProgress` re-anchors `startSecs` to the
    // current row's `validAt` — which makes the rendered progress
    // bar visibly reset. If the previous local row was already
    // tracking a progress entry pointing at the same future event
    // (same `endSecs` + `style`), keep that entry's `startSecs` so
    // the bar's fraction grows monotonically across row transitions.
    if (progress) {
      const now = this.reducers.serverNowMs();
      for (const p of progress) {
        const carried = prev?.progress?.find(
          (pp) => pp.endSecs === p.endSecs && pp.style === p.style,
        );
        if (carried) {
          // Continuity: keep the original anchor so the fraction grows
          // monotonically across intermediate row promotions (no reset/flicker).
          p.startSecs = carried.startSecs;
        } else if (p.startSecs < now && now < p.endSecs) {
          // First appearance: anchor `startSecs` to the observation time so the
          // bar starts EMPTY and still completes exactly at `endSecs`. The row's
          // own `startSecs` (the bound card's `now_ms` hold-row validAt) predates
          // observation by the client's buffered-clock offset (~clientDelay, sec
          // scale) + round-trip, which otherwise rendered the bar pre-filled by
          // `(now-start)/dur`. Lifecycle/magnetic bars are built below with their
          // own carry and are intentionally NOT re-anchored (a card observed
          // mid-decay should show its true partial progress).
          debug.log(
            ["cards"],
            `[progress] card ${change.key} new bar raw start=${p.startSecs} end=${p.endSecs} now=${Math.round(now)} rawFrac=${((now - p.startSecs) / (p.endSecs - p.startSecs)).toFixed(3)} → anchored to now`,
            5,
          );
          p.startSecs = now;
        }
      }
    }
    // Reuse the cached def when `packedDefinition` is unchanged
    // from the previous local row — the wasm `decode` call shows up
    // in the profile when consumers walk `cardsLocal` (e.g. the
    // soul-card corpus meter). `packedDefinition` is a card's *type*,
    // not its state, so it virtually never changes for a live card.
    const def =
      prev !== undefined &&
      prev.packedDefinition === baseRow.packedDefinition &&
      prev.def !== undefined
        ? prev.def
        : this.definitions.decode(baseRow.packedDefinition);
    // TODO(magnetic-relocate): the synthetic magnetic-expiry progress bar was
    // removed here — its `magnetic` lifecycle-pending flag and `progress_style`
    // were both cut from the card flag word in the flags/stock split. Reinstate
    // (deriving style from the recipe / lifecycle def) when lifecycle returns
    // gate-side.
    const nextRow: LocalCard = {
      ...baseRow,
      def,
      ...(dead !== undefined ? { dead } : {}),
      ...(progress !== undefined ? { progress } : {}),
    };

    this.cardsLocal.set(change.key, nextRow);
    if (serverForcesStackPosition) {
      this.renumberAfterForcedStackPosition(change.key, nextRow);
    }
    if (prev === undefined) {
      this.fireCardLocal({ kind: "added", key: change.key, row: nextRow });
    } else if (prev !== nextRow) {
      this.fireCardLocal({ kind: "updated", key: change.key, oldRow: prev, newRow: nextRow });
    }
    // Phase 4 eviction. Runs *after* the splice's partner writes
    // and after the incoming card's `cardsLocal.set` above, so the
    // chain is fully spliced before the topmost card is re-homed.
    // `evictCard` rewrites the overflow row via `setLocalCard` which
    // fires its own listeners; iteration order matters because the
    // receiving inventory's `clampToSurface` will see the new arrival
    // on its next layout pass.
    if (spliceOverflow !== null) {
      // spliceOverflow !== null implies the splice block above ran,
      // which required `cardManager !== null` — but TS can't reason
      // across the gap so we keep the optional-chain. No-op when
      // missing (no harm; the chain is still spliced, just over-tall).
      this.cardManager?.evictCard(spliceOverflow);
    }
  }

  /** Re-mirror a card when a future-stamped completion row carrying
   *  `progress_style` arrives, so its progress bar actually starts.
   *
   *  An action's effects land as two separate writes: the in-flight **hold**
   *  row (stamped at `now`) and, many reducer-calls later, the **completion**
   *  row (stamped at `completion_ms`, carrying `progress_style`). The hold row
   *  promotes immediately and runs [`scanProgress`] — but the completion row
   *  isn't in `cards.server` yet, so no bar is found. When the completion row
   *  finally arrives it is future-stamped, so [`ValidAtTable.promote`] does NOT
   *  fire (the card's *current* row is unchanged) and [`mirrorCard`] never
   *  re-runs → the bar never starts. (Short actions whose two writes land in
   *  the same frame dodge this by luck; longer / cross-DB ones don't.)
   *
   *  Fix: on a future progress-bearing row, re-mirror the card's current row so
   *  `scanProgress` re-scans `server` — which now includes this row. No-op when
   *  the card has no current row yet (its own promote will scan) or when the row
   *  isn't a future completion row. Uses the same `validAtOf <= serverNow`
   *  cutoff `promote` uses, so "future" is judged on the identical timeline. */
  private kickFutureProgress(row: Card): void {
    const style =
      (row.flags >>> FLAG_PROGRESS_STYLE_SHIFT) & FLAG_PROGRESS_STYLE_MASK;
    if (style === 0) return;
    if (validAtOf(row.validAt) <= this.reducers.serverNowMs()) return;
    const current = this.cards.current.get(row.cardId);
    if (current === undefined) return;
    this.mirrorCard({ kind: "updated", key: row.cardId, oldRow: current, newRow: current });
  }

  /** Build the `progress` array for a card by scanning the server tier
   *  for future-validAt rows of this `cardId` whose `progress_style`
   *  bits are non-zero. Today picks the single row with the highest
   *  `validAt` (last-write-wins by time) and returns a one-element
   *  array; returns `undefined` if no eligible row exists so the
   *  field is omitted from the local row entirely.
   *
   *  `currentRow` is the row that's about to land in `cardsLocal` —
   *  its `validAt` is the `startSecs` for any progress entry (the
   *  in-flight row's start; the future row's `validAt` is `endSecs`).
   *
   *  When stacked indicators land, this function will return the full
   *  list (one entry per eligible future row, ordered however the
   *  renderer wants) and the caller's logic doesn't change. */
  private scanProgress(
    cardId: number,
    currentRow: Card,
  ): ProgressInfo[] | undefined {
    const startSecs = validAtOf(currentRow.validAt);
    let bestValidAt = -1;
    let bestStyle = 0;
    for (const [packed, row] of this.cards.server) {
      if (row.cardId !== cardId) continue;
      const validAt = validAtOf(packed);
      if (validAt <= startSecs) continue;
      const style = (row.flags >>> FLAG_PROGRESS_STYLE_SHIFT) & FLAG_PROGRESS_STYLE_MASK;
      if (style === 0) continue;
      if (validAt > bestValidAt) {
        bestValidAt = validAt;
        bestStyle = style;
      }
    }
    if (bestValidAt < 0) return undefined;
    return [{ style: bestStyle, startSecs, endSecs: bestValidAt }];
  }

  /** Bump every other client-only card in `forced`'s chain group whose
   *  position ≥ the forced position by +1. Called after a server row
   *  with `pos_need` or `pos_want` set lands so client cards "stack
   *  after" the server's confirmed position. Saturates at position 31
   *  (any card pushed past
   *  31 stays at 31 — gap-tolerant rendering still draws everything; a
   *  later cleanup pass can compact). Each bump fires `fireCardLocal`
   *  so downstream listeners (Card.onDataChange) tween. */
  private renumberAfterForcedStackPosition(forcedId: number, forced: LocalCard): void {
    if (!microIsCard(forced.flags)) return;
    const forcedBranch = stackBranch(forced.flags);
    const forcedIdx = stackIndex(forced.flags);
    const forcedRoot = forced.microLocation;

    const bumps: { id: number; oldRow: LocalCard; newRow: LocalCard }[] = [];
    for (const [id, row] of this.cardsLocal) {
      if (id === forcedId) continue;
      if (!microIsCard(row.flags)) continue;
      if (row.microLocation !== forcedRoot) continue;
      // Only bump the same branch — top / bottom / hex have independent
      // index spaces under the same root.
      if (stackBranch(row.flags) !== forcedBranch) continue;
      const idx = stackIndex(row.flags);
      if (idx < forcedIdx) continue;
      const newIdx = Math.min(idx + 1, 15);
      if (newIdx === idx) continue;
      const placed = applyMicro(
        { kind: "stacked", root: forcedRoot, branch: forcedBranch, index: newIdx },
        row.flags,
      );
      bumps.push({ id, oldRow: row, newRow: { ...row, microLocation: placed.microLocation, flags: placed.flags } });
    }
    for (const { id, oldRow, newRow } of bumps) {
      this.cardsLocal.set(id, newRow);
      this.fireCardLocal({ kind: "updated", key: id, oldRow, newRow });
    }
  }

  /** Snapshot listener sets before iterating so a listener that
   *  (un)subscribes during firing doesn't break the loop. Per-listener
   *  try/catch so one bad listener can't stop the others. */
  private fireCardLocal(change: TableChange<LocalCard>): void {
    if (this.cardLocalListeners.size > 0) {
      for (const l of [...this.cardLocalListeners]) {
        try {
          l(change);
        } catch (err) {
          console.error("[DataManager] cards local listener threw", err);
        }
      }
    }
    const set = this.cardLocalKeyListeners.get(change.key);
    if (set && set.size > 0) {
      for (const l of [...set]) {
        try {
          l(change);
        } catch (err) {
          console.error("[DataManager] cards local key listener threw", err);
        }
      }
    }
  }
}
