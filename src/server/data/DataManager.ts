import { debug } from "../../debug";
import type { CardDefinition, DefinitionManager } from "../../game/definitions/DefinitionManager";
import type { Card, ChatMessage, Player, Soul, Zone } from "../spacetime/bindings/types";
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
import { ValidAtTable, type TableChange, type TableListener } from "./ValidAtTable";
import { AppendTable } from "./AppendTable";

const INVENTORY_LAYER = 1;
const FLAG_ACTION_DEAD = 1 << 7;
// `progress_style` is the u3 field at bits 8..=10 of `Card.flags`. See
// `content/cards/flags.json`. Set on the actor's completion row by
// `action_completion`; the client reads it to render a progress bar
// during the in-flight window.
const FLAG_PROGRESS_STYLE_SHIFT = 8;
const FLAG_PROGRESS_STYLE_MASK = 0b111;
// `force_position` (bit 11): server is asserting this row's
// microZone / microLocation verbatim. Used to live as a `force_flag`
// bit inside `microZone` itself; moved to `flags` to free the bit for
// chain `direction`. See `content/cards/flags.json`.
const FLAG_FORCE_POSITION = 1 << 11;
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

  private readonly unsubMirror: Array<() => void> = [];

  /** Listeners on the local cards overlay. Fire on every overlay change —
   *  mirror-driven (server pushes that pass through `mirrorCard`) AND
   *  client-driven (`setLocalCard` / `clearLocalCard`). */
  private readonly cardLocalListeners = new Set<TableListener<LocalCard>>();
  private readonly cardLocalKeyListeners = new Map<number, Set<TableListener<LocalCard>>>();

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
   *  `FLAG_FORCE_POSITION` is the server's universal opt-out.**
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
   *    writes). Honor `FLAG_FORCE_POSITION` — without it, the row is
   *    a pure flags update and the local chain (as arranged by
   *    `setCardPosition`) stands. With it set, server's spatial
   *    lands verbatim.
   *
   *  - **Stack preserve** (state-2 OnRoot, inventory): same
   *    `force_position` gate. The flag used to live in `microZone`
   *    bit 2 alongside `position` / `direction`; moved out to
   *    `flags` so `microZone` could carry the chain `direction`
   *    instead.
   *
   *  When the **stack layout** applies AND the `force_position` flag is
   *  set, the server is asserting a specific chain position. We take
   *  server's position as-is AND renumber any *other* client-only
   *  cards in the same `(root_id, direction)` group whose position ≥
   *  the forced one by +1 — they "stack after" the server's confirmed
   *  position. */
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
          3,
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
        `[spacetime] card row removed t=${nowSecs} id=${change.key} prev=${prev ? `flags=0x${prev.flags.toString(16)} microZone=0x${prev.microZone.toString(16)} microLocation=${prev.microLocation} macroZone=${prev.macroZone} surface=${prev.surface}` : "absent"}`,
        2,
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
      `[spacetime] card row ${change.kind} t=${nowSecs} id=${change.key} validAt=${validAtOf(serverRow.validAt)} state=${serverState} flags=0x${serverRow.flags.toString(16)} microZone=0x${serverRow.microZone.toString(16)} microLocation=${serverRow.microLocation} macroZone=${serverRow.macroZone} surface=${serverRow.surface}`,
      2,
    );

    // Defensive: state-1 (Slot) requires a present parent row at
    // `microLocation`. The server can't see the client's local overlay
    // — if for any reason the parent isn't here (subscription gap,
    // server bug, deletion race) the slot is an orphan and would
    // never render correctly. Force back to owner-inventory loose
    // (macroZone = ownerId, surface = 1, state = STACKED_LOOSE) so
    // the card is visible and recoverable. Same recovery shape that
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
        // Loose inventory cards are entirely client-positioned —
        // drag-drop, splice transplants, etc. The server never asserts
        // a meaningful position for them, so always keep the local
        // overlay's spatial fields over whatever the serverRow carries.
        preservePosition = true;
      } else if (serverState === 1 /* STACKED_SLOT */) {
        // State-1 chain members carry `microLocation = predecessor`
        // and `microZone = direction`. The client owns the chain
        // locally (via `setCardPosition`); the server only writes
        // these fields when it's asserting chain shape (e.g.
        // `propose_action`'s slot[1..] writes). Treat
        // `FLAG_FORCE_POSITION` as the universal "server overrides
        // client" signal — without it, the row is just a flag update
        // and the local chain stays as the player arranged it. With
        // it set, the server's microLocation / microZone /
        // macroZone / surface land verbatim.
        const forced = (serverRow.flags & FLAG_FORCE_POSITION) !== 0;
        preservePosition = !forced;
      } else if (isStackLayout(serverState, serverRow.surface)) {
        // State-2 OnRoot on inventory — same `force_position` gate.
        // The flag used to live in `microZone` bit 2 alongside
        // `position` / `direction`; moved out to `flags` so `microZone`
        // could carry the chain `direction` instead.
        const forced = (serverRow.flags & FLAG_FORCE_POSITION) !== 0;
        preservePosition = !forced;
        serverForcesStackPosition = forced;
      }
      // STACKED_ON_HEX (3) — no special preserve; server is authoritative
      // on world-tile placement. Splice handles client-side transplants
      // when the dying card's animation completes.
    }

    const baseRow: Card = orphanSlot
      ? {
          ...serverRow,
          macroZone:     serverRow.ownerId,
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
    const progress = this.scanProgress(change.key, baseRow);
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
   *  with the `force_position` flag set lands so client cards "stack after" the server's
   *  confirmed position. Saturates at position 31 (any card pushed past
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
