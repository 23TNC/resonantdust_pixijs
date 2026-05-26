import { debug } from "../../debug";
import type { CardDefinition, DefinitionManager } from "../../game/definitions/DefinitionManager";
import type { Card, ChatMessage, Player, PlayerProfile, Soul, SoulPrivate, Zone } from "../spacetime/bindings/types";
import { ChatSubscriptionManager } from "../spacetime/ChatSubscriptionManager";
import type { ConnectionRegistry } from "../spacetime/ConnectionRegistry";
import type { ReducerManager } from "../spacetime/ReducerManager";
import { SubscriptionManager } from "../spacetime/SubscriptionManager";
import {
  isStackLayout,
  packStackMicroZone,
  unpackStackMicroZone,
} from "./packing";
import { validAtOf, WORLD_LAYER } from "./packing";
import { getStackDirection } from "../../game/cards/cardData";
import { ValidAtTable, type TableChange, type TableListener } from "./ValidAtTable";
import { AppendTable } from "./AppendTable";
import type { CardManager } from "../../game/cards/CardManager";

const INVENTORY_LAYER = 1;
/** Bit 4 of `flagsState` — set on soul cards whose `ownerId` is a
 *  `player_id`. Mirrored here so `mirrorCard`'s orphan-slot fallback
 *  can walk the owner chain to find an owning soul without importing
 *  `permissions.ts` (which would create a permissions → GameContext
 *  → DataManager import cycle). Source of truth: `content/cards/flags.json`. */
const FLAG_OWNED_BY_PLAYER = 1 << 4;
/** Bounded walk to mirror `permissions::owningSoul`'s server-side
 *  intent — climb `ownerId` until we land on a soul (card with
 *  `FLAG_OWNED_BY_PLAYER` set). Mirrors the depth cap from
 *  `OWNER_WALK_DEPTH_CAP` in `cards.rs`. */
const OWNER_WALK_DEPTH_CAP = 32;

// Bit masks for `Card.flagsState` / `Card.flagsBk`. Source of truth:
// `content/cards/flags.json`. Mirrored here as compile-time
// constants — DataManager is a hot-path mirror and per-call
// wasm-registry lookups add avoidable overhead. Keep these in sync
// with the registry on any renumber; the canonical query is
// `definitions.cardFlagBitIn(...)` / `cardFlagFieldShape(...)`.
//
// Post unified-hold-counts rework: `slot_hold` is no longer a state
// bit — it's a refcount field in `flags_bk` (`slot_hold_count`).
// Readers asking "is slot-held?" check `(flagsBk & SLOT_HOLD_COUNT_MASK) !== 0`.
const FLAG_ACTION_DEAD = 1 << 0;
/** Server *requires* the row's position. Mirror splices on conflict
 *  with the incoming card winning the slot (existing occupant
 *  re-anchors one step up the chain). Overflow past
 *  `MAX_CHAIN_DEPTH` evicts the topmost card via the
 *  inventory→loose→nearby-tile cascade. Paired with
 *  [`FLAG_POS_WANT`] — same splice primitive, opposite winner. */
const FLAG_POS_NEED = 1 << 1;
const FLAG_LIFECYCLE_PENDING = 1 << 2;
/** Server *prefers* the row's position. Mirror splices on conflict
 *  with the existing occupant winning the slot (incoming card
 *  stacks above it). Overflow past `MAX_CHAIN_DEPTH` evicts the
 *  topmost card via the inventory→loose→nearby-tile cascade.
 *  Paired with [`FLAG_POS_NEED`] — same splice primitive,
 *  opposite winner. */
const FLAG_POS_WANT = 1 << 12;
// `progress_style` is the u3 field at bits 5..=7 of `Card.flagsState`.
// Set on the actor's completion row by `action_completion::commit`;
// the client reads it to render a progress bar during the in-flight
// window.
const FLAG_PROGRESS_STYLE_SHIFT = 5;
const FLAG_PROGRESS_STYLE_MASK = 0b111;
// `slot_hold_count` is a u3 refcount at bits 13..=15 of `Card.flagsBk`.
// Mask covers the field's window; non-zero value means "this card is
// exclusively held by an in-flight action."
const FLAG_SLOT_HOLD_COUNT_MASK = 0b111 << 13;
// `progress_style` value used for the synthetic magnetic-expiry bar.
// `ltr` matches the cw render the success recipes already declare,
// so the visual is consistent across the magnetic phase and the
// subsequent action commit.
const LIFECYCLE_PROGRESS_STYLE = 1;
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
 *  DataManager owns its own `SubscriptionManager` — the SDK ingress for
 *  this layer. `main.ts` constructs `ConnectionRegistry` and hands it
 *  in; `subscribeCards(zoneId)` / etc. are reachable as
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
  /** Flat (non-versioned) world-chat feed. Server inserts append-only;
   *  there is no `current` view to promote — `chatMessages.rows` is
   *  the table itself. See `AppendTable` and `chat.rs`. */
  readonly chatMessages = new AppendTable<ChatMessage>((row) => row.sentAt);
  readonly subscriptions: SubscriptionManager;
  readonly chatSubscriptions: ChatSubscriptionManager;

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
   *  one row (for the local player). Sourced by
   *  `getPlayerBlueprintCapacity` for the dna-panel title bar and
   *  the player-scope drag drop pre-check. */
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
    registry: ConnectionRegistry,
    private readonly reducers: ReducerManager,
    private readonly definitions: DefinitionManager,
  ) {
    // Thread the reducer-event timestamp from `SubscriptionManager` into
    // `ReducerManager.noteServerTime` so the client's server-clock
    // estimate gets re-baselined on every reducer commit. `promote()`
    // then reads from `reducers.serverNowMs()` instead of
    // `Date.now()`, aligning `ValidAtTable` promotion to the
    // server's timeline.
    this.subscriptions = new SubscriptionManager(registry.shard, {
      onReducerEvent: (micros) => this.reducers.noteServerTime(micros),
    });
    this.chatSubscriptions = new ChatSubscriptionManager(registry.chat);

    this.subscriptions.registerTableHandlers("cards", {
      onInsert: this.cards.insert,
      onUpdate: this.cards.update,
      onDelete: this.cards.delete,
    });
    this.subscriptions.registerTableHandlers("players", {
      onInsert: this.players.insert,
      onUpdate: this.players.update,
      onDelete: this.players.delete,
    });
    this.subscriptions.registerTableHandlers("souls", {
      onInsert: this.souls.insert,
      onUpdate: this.souls.update,
      onDelete: this.souls.delete,
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
      onInsert: this.zones.insert,
      onUpdate: this.zones.update,
      onDelete: this.zones.delete,
    });
    this.chatSubscriptions.registerTableHandlers("chat_messages", {
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
    // Track visible mini_zone anchor cards and subscribe to each
    // anchor's `(surface=63, macro_zone=card_id)` channel so the
    // mini_zone's Zone row + cards on its tiles come into the
    // server-tier mirror automatically. Watches the cards table on
    // every server push: anchors entering the visible-world
    // subscription set get a mini_zone subscription installed;
    // anchors leaving (card removed, type changed, moved off
    // WORLD_LAYER) get unsubscribed. The set is keyed on card_id;
    // an anchor still in the set across multiple promote events
    // stays subscribed without churn.
    this.unsubMirror.push(this.cards.subscribe((c) => this.trackMiniZoneAnchor(c)));
  }

  /** card_ids of anchor cards we currently hold a mini_zone
   *  subscription for. Adds when an anchor enters the visible
   *  world chunks; removes when it leaves. Maintained by
   *  `trackMiniZoneAnchor`. */
  private readonly subscribedMiniZones = new Set<number>();

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
    this.chatSubscriptions.dispose();
    this.cards.dispose();
    this.players.dispose();
    this.souls.dispose();
    this.zones.dispose();
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
  /** Watch the cards mirror for `mini_zone`-type anchor cards
   *  entering / leaving the visible-world subscription set.
   *
   *  Membership rule: a card is a "visible mini_zone anchor" iff
   *  it's present in `cards.server` at `surface = WORLD_LAYER`
   *  with a `card_type == mini_zone` definition. (Membership in
   *  `cards.server` is what the world-zone subscription drives —
   *  rows arrive when a chunk is subscribed and depart when it's
   *  released.)
   *
   *  On membership change we install / drop the
   *  `(surface=63, macro_zone=card_id)` subscription that fetches
   *  the mini_zone's Zone tile bytes plus any cards on its tiles.
   *
   *  Known v1 limitation: this fires on every cards-table push for
   *  every card, not just anchors — cheap (one card-type decode)
   *  but not free. A more efficient design would maintain a
   *  per-card-type index in `ValidAtTable`. Defer until profiling
   *  warrants it.
   */
  /** Walk `startOwnerId` up the `ownerId` chain in `cardsLocal`
   *  until a card carrying `FLAG_OWNED_BY_PLAYER` (i.e. a soul) is
   *  found. Returns the soul's `card_id`, or `null` when the walk
   *  terminates without finding one (chain reaches the world via
   *  `ownerId === 0`, hits a missing parent due to a subscription
   *  gap, or trips `OWNER_WALK_DEPTH_CAP`).
   *
   *  Mirrors `permissions::owningSoul`'s server-side walk shape but
   *  is duplicated here to avoid a `permissions.ts → GameContext →
   *  DataManager → permissions.ts` import cycle. Both walks read the
   *  same overlay so they agree.
   *
   *  Used by `mirrorCard`'s orphan-slot fallback to figure out which
   *  soul's inventory an orphaned chain card should land in.
   *  Previously the fallback assumed `ownerId == soul.cardId`
   *  (the pre-Phase-5 inventory-bucket pun); now ownership is
   *  independent of position so the walk is necessary. */
  private findOwningSoulId(startOwnerId: number): number | null {
    let cur = startOwnerId;
    for (let i = 0; i < OWNER_WALK_DEPTH_CAP; i++) {
      if (cur === 0) return null;
      const row = this.cardsLocal.get(cur);
      if (!row) return null;
      if ((row.flagsState & FLAG_OWNED_BY_PLAYER) !== 0) return cur;
      if (row.ownerId === 0) return null;
      cur = row.ownerId;
    }
    return null;
  }

  private trackMiniZoneAnchor(change: TableChange<Card>): void {
    const cardId = change.key;
    const isAnchorNow =
      change.kind !== "removed"
      && (change.kind === "added" ? change.row : change.newRow).surface === WORLD_LAYER
      && this.definitions.isCardType(
        (change.kind === "added" ? change.row : change.newRow).packedDefinition,
        "mini_zone",
      );
    const wasAnchor = this.subscribedMiniZones.has(cardId);

    if (isAnchorNow && !wasAnchor) {
      this.subscribedMiniZones.add(cardId);
      void this.subscriptions.subscribeMiniZone(cardId).catch((err) => {
        // Subscription install can fail (disconnect, malformed query).
        // Drop the tracking entry so a later retry can re-install.
        this.subscribedMiniZones.delete(cardId);
        debug.log(
          ["spacetime"],
          `[spacetime] subscribeMiniZone(${cardId}) failed: ${err instanceof Error ? err.message : String(err)}`,
          4,
        );
      });
    } else if (!isAnchorNow && wasAnchor) {
      this.subscribedMiniZones.delete(cardId);
      this.subscriptions.unsubscribeMiniZone(cardId);
    }
  }

  private mirrorCard(change: TableChange<Card>): void {
    const prev = this.cardsLocal.get(change.key);

    const nowSecs = (Date.now() / 1000).toFixed(3);

    if (change.kind === "removed") {
      debug.log(
        ["spacetime"],
        `[spacetime] card row removed t=${nowSecs} id=${change.key} prev=${prev ? `flagsState=0x${prev.flagsState.toString(16)} flagsBk=0x${prev.flagsBk.toString(16)} microZone=0x${prev.microZone.toString(16)} microLocation=${prev.microLocation} macroZone=${prev.macroZone} surface=${prev.surface}` : "absent"}`,
        0,
      );
      if (prev === undefined) return;
      this.cardsLocal.delete(change.key);
      this.fireCardLocal({ kind: "removed", key: change.key, oldRow: prev });
      return;
    }

    const serverRow = change.kind === "added" ? change.row : change.newRow;
    const serverState = serverRow.microZone & 0x3;
    debug.log(
      ["spacetime"],
      `[spacetime] card row ${change.kind} t=${nowSecs} id=${change.key} validAt=${validAtOf(serverRow.validAt)} state=${serverState} flagsState=0x${serverRow.flagsState.toString(16)} flagsBk=0x${serverRow.flagsBk.toString(16)} microZone=0x${serverRow.microZone.toString(16)} microLocation=${serverRow.microLocation} macroZone=${serverRow.macroZone} surface=${serverRow.surface}`,
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
    if (prev === undefined && (serverRow.flagsState & FLAG_ACTION_DEAD) !== 0) {
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
    if (serverState === 3 /* STACKED_DEFERRED */ && this.cardManager !== null) {
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
    // bucket) is resolved by walking the owner chain to find a card
    // with FLAG_OWNED_BY_PLAYER — see `findOwningSoulId` below — since
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
      serverState === 1 /* STACKED_SLOT */ &&
      serverRow.microLocation !== change.key &&
      !this.cardsLocal.has(serverRow.microLocation);

    let preservePosition = false;
    let serverForcesStackPosition = false;
    if (!orphanSlot) {
      if (serverState === 0 /* STACKED_LOOSE */) {
        // Position-ownership for LOOSE cards splits on surface:
        //
        //   - INVENTORY (`surface < WORLD_LAYER`): client owns. Drag-
        //     drop and splice transplants write the position purely
        //     locally; the server's view (which only knows the
        //     inventory bucket, not the pixel xy) shouldn't clobber.
        //   - WORLD (`surface >= WORLD_LAYER`): server owns. World-
        //     loose cards (souls, dropped items on tiles) carry their
        //     hex address in `macroZone + microZone`, and the server
        //     authoritatively writes those — e.g. `move_soul`'s
        //     per-step writes update the soul's tile. Preserving the
        //     local row here would silently drop those moves and
        //     leave the client's view permanently stuck at the
        //     pre-move position.
        preservePosition = serverRow.surface < WORLD_LAYER;
      } else if (serverState === 1 /* STACKED_SLOT */) {
        // State-1 chain members carry `microLocation = predecessor`
        // and `microZone = direction`. The client owns the chain
        // locally (via `setCardPosition`); the server only writes
        // these fields when it's asserting chain shape (e.g.
        // `propose_action`'s slot[1..] writes). `FLAG_POS_NEED` /
        // `FLAG_POS_WANT` are the two placement-assertion bits:
        // - Neither set → row is a flag-only update; the local
        //   chain stays as the player arranged it.
        // - `pos_need` → server *requires* this slot; mirror
        //   splices on conflict with the incoming card winning.
        // - `pos_want` → server *prefers* this slot; mirror
        //   splices on conflict with the existing occupant winning.
        // The splice itself (and any chain-overflow eviction it
        // triggers) is staged after the preserve / baseRow gate
        // below — we just compute the `forced` boolean here so the
        // existing baseRow plumbing keeps working in the no-conflict
        // path.
        const forced = (serverRow.flagsState & (FLAG_POS_NEED | FLAG_POS_WANT)) !== 0;
        preservePosition = !forced;
      } else if (isStackLayout(serverState, serverRow.surface)) {
        // State-2 OnRoot on inventory — same placement-assertion
        // gate as the state-1 branch above.
        const forced = (serverRow.flagsState & (FLAG_POS_NEED | FLAG_POS_WANT)) !== 0;
        preservePosition = !forced;
        serverForcesStackPosition = forced;
      }
      // STACKED_DEFERRED (3) — handled by the dedicated state-3
      // branch added in Phase 5 (below); resolution happens via
      // `CardManager.appendAtChainLeaf`. We don't fall through to
      // the preserve / forced-overwrite logic above for state 3
      // because deferred rows have no concrete position to preserve
      // or assert — they declare an intent that resolves at read
      // time.
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

    let baseRow: Card = orphanSlot
      ? {
          ...serverRow,
          macroZone:     orphanInventoryBucket,
          surface:       INVENTORY_LAYER,
          microLocation: 0, // encodeLooseXY(0, 0) === 0
          microZone:     serverRow.microZone & ~0x3, // state → STACKED_LOOSE
        }
      : preservePosition && prev !== undefined
      ? {
          ...serverRow,
          macroZone:     prev.macroZone,
          microZone:     prev.microZone,
          microLocation: prev.microLocation,
          surface:       prev.surface,
        }
      : serverRow;

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
      serverState === 1 /* STACKED_SLOT */ &&
      (serverRow.flagsState & (FLAG_POS_NEED | FLAG_POS_WANT)) !== 0 &&
      this.cardManager !== null
    ) {
      const direction = getStackDirection(serverRow.microZone);
      const occupant = this.cardManager.findSlotOccupant(serverRow.microLocation, direction);
      if (occupant && occupant.cardId !== change.key) {
        // `pos_need` outranks `pos_want` when both bits are set —
        // need's "incoming wins" semantic is the stricter assertion.
        const nAbove =
          (serverRow.flagsState & FLAG_POS_NEED) === 0 &&
          (serverRow.flagsState & FLAG_POS_WANT) !== 0;
        const result = this.cardManager.insertIntoSlotChain(serverRow, occupant, nAbove);
        baseRow = result.incomingRow;
        spliceOverflow = result.overflowTop;
      }
    }
    // Preserve `dead: 2` once the layout has finished its animation —
    // otherwise a subsequent server push with the flag still set would
    // regress us to `1` and replay the animation.
    const flagDead = (serverRow.flagsState & FLAG_ACTION_DEAD) !== 0;
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
    if (progress && prev?.progress) {
      for (const p of progress) {
        const carried = prev.progress.find(
          (pp) => pp.endSecs === p.endSecs && pp.style === p.style,
        );
        if (carried) p.startSecs = carried.startSecs;
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
    // Synthetic magnetic-expiry progress. A magnetic anchor in its
    // pending phase (magnetic flag set, no `slot_hold` claiming it
    // for an in-flight recipe) has no server-side completion row to
    // count down against — the expiry is computed from
    // `def.lifecycleDurationMs` and the install row's `validAt`. Build
    // a progress entry so the player can see how long until
    // `LifecycleResolutionManager` flips to the failure path. As soon
    // as a propose_action stitches the anchor as root (`slot_hold`
    // set) OR `scanProgress` finds a real completion row, this
    // branch is skipped and the action-completion progress takes over
    // naturally. Cleared at death too (no point counting down).
    if (
      progress === undefined &&
      def !== null &&
      def.lifecycleDurationMs &&
      (baseRow.flagsState & FLAG_LIFECYCLE_PENDING) !== 0 &&
      (baseRow.flagsBk & FLAG_SLOT_HOLD_COUNT_MASK) === 0 &&
      !flagDead
    ) {
      // Install row = earliest validAt for this card_id. Older rows
      // can be GC'd, but the install row carries the magnetic flag
      // and is force-position, so it sticks around until the card
      // dies or transitions out of the magnetic phase. Walk the
      // server tier to find it — small per-card row count makes this
      // cheap.
      let installValidAt = validAtOf(baseRow.validAt);
      for (const [packed, row] of this.cards.server) {
        if (row.cardId !== change.key) continue;
        const v = validAtOf(packed);
        if (v < installValidAt) installValidAt = v;
      }
      progress = [
        {
          style: LIFECYCLE_PROGRESS_STYLE,
          startSecs: installValidAt,
          endSecs: installValidAt + def.lifecycleDurationMs,
        },
      ];
      // Same continuity carry as above — if the previous local row
      // already had this synthetic entry, hold onto its startSecs so
      // re-promotes don't flicker the bar back to 0.
      if (prev?.progress) {
        const carried = prev.progress.find(
          (pp) => pp.endSecs === progress![0]!.endSecs && pp.style === progress![0]!.style,
        );
        if (carried) progress[0]!.startSecs = carried.startSecs;
      }
    }
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
      const style = (row.flagsState >>> FLAG_PROGRESS_STYLE_SHIFT) & FLAG_PROGRESS_STYLE_MASK;
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
    const forcedState = forced.microZone & 0x3;
    if (!isStackLayout(forcedState, forced.surface)) return;
    const { position: forcedPos, direction: forcedDir } = unpackStackMicroZone(forced.microZone);
    const forcedRoot = forced.microLocation;
    if (forcedPos === 0) return;

    const bumps: { id: number; oldRow: LocalCard; newRow: LocalCard }[] = [];
    for (const [id, row] of this.cardsLocal) {
      if (id === forcedId) continue;
      if ((row.microZone & 0x3) !== forcedState) continue;
      if (!isStackLayout(forcedState, row.surface)) continue;
      if (row.microLocation !== forcedRoot) continue;
      const { position, direction } = unpackStackMicroZone(row.microZone);
      // Only bump cards in the SAME direction — top and bottom chains
      // have independent position spaces under the same root.
      if (direction !== forcedDir) continue;
      if (position < forcedPos) continue;
      const newPos = Math.min(position + 1, 31);
      if (newPos === position) continue;
      const newMz = packStackMicroZone(newPos, direction, forcedState);
      const newRow: LocalCard = { ...row, microZone: newMz };
      bumps.push({ id, oldRow: row, newRow });
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
