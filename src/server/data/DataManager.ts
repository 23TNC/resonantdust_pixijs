import type { Card, Player, Zone } from "../spacetime/bindings/types";
import type { ConnectionManager } from "../spacetime/ConnectionManager";
import { SubscriptionManager } from "../spacetime/SubscriptionManager";
import {
  isStackLayout,
  packStackMicroZone,
  unpackMicroZone,
  unpackStackMicroZone,
} from "./packing";
import { idOf, validAtOf } from "./packing";
import { ValidAtTable, type TableChange, type TableListener } from "./ValidAtTable";

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
 *    queued event. */
export type LocalCard = Card & { dead?: 1 | 2; progress?: ProgressInfo[] };

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
 *  this layer. `main.ts` only constructs `ConnectionManager` and hands it
 *  in; `subscribeCards(zoneId)` / etc. are reachable as
 *  `data.subscriptions.<method>`. */
export class DataManager {
  readonly cards = new ValidAtTable<Card>((row) => row.validAt);
  readonly players = new ValidAtTable<Player>((row) => row.validAt);
  readonly zones = new ValidAtTable<Zone>((row) => row.validAt);
  readonly subscriptions: SubscriptionManager;

  /** Local overlays — what game code reads/writes for displayed state.
   *  Mirrors `<table>.current` via subscription. */
  readonly cardsLocal = new Map<number, LocalCard>();
  readonly playersLocal = new Map<number, Player>();
  readonly zonesLocal = new Map<number, Zone>();

  private readonly unsubMirror: Array<() => void> = [];

  /** Listeners on the local cards overlay. Fire on every overlay change —
   *  mirror-driven (server pushes that pass through `mirrorCard`) AND
   *  client-driven (`setLocalCard` / `clearLocalCard`). */
  private readonly cardLocalListeners = new Set<TableListener<Card>>();
  private readonly cardLocalKeyListeners = new Map<number, Set<TableListener<Card>>>();

  constructor(connection: ConnectionManager) {
    this.subscriptions = new SubscriptionManager(connection);

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
    this.subscriptions.registerTableHandlers("zones", {
      onInsert: this.zones.insert,
      onUpdate: this.zones.update,
      onDelete: this.zones.delete,
    });

    // Mirror server tier → local overlay. Server pushes always propagate;
    // `mirrorCard` may keep position fields from the local row in the
    // inventory-loose case (see there).
    this.unsubMirror.push(this.cards.subscribe((c) => this.mirrorCard(c)));
    this.unsubMirror.push(
      this.players.subscribe((c) => this.mirror(this.playersLocal, c)),
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
  subscribeLocalCard(listener: TableListener<Card>): () => void {
    this.cardLocalListeners.add(listener);
    return () => {
      this.cardLocalListeners.delete(listener);
    };
  }

  /** Subscribe to local-cards-overlay changes for a single id. Subscribing
   *  to a not-yet-existing id is fine — the listener fires when the row
   *  arrives. Returns an unsubscribe fn. */
  subscribeLocalCardKey(key: number, listener: TableListener<Card>): () => void {
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

  setLocalZone(id: number, row: Zone): void {
    this.zonesLocal.set(id, row);
  }

  /** Promote every table's `current` view to `now` (absolute seconds). */
  promote(now: number): void {
    this.cards.promote(now);
    this.players.promote(now);
    this.zones.promote(now);
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
    this.zones.dispose();
    this.cardsLocal.clear();
    this.playersLocal.clear();
    this.zonesLocal.clear();
    this.cardLocalListeners.clear();
    this.cardLocalKeyListeners.clear();
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

  /** Card-specific mirror with two preserve cases for inventory cards.
   *  Both require `serverRow.surface === INVENTORY_LAYER` AND
   *  `prev.surface === INVENTORY_LAYER`. The check on `state` and the
   *  layout-specific bit determines which gate fires:
   *
   *  - **Loose preserve** (legacy layout): `state === STACKED_LOOSE` AND
   *    `unpackMicroZone(serverRow.microZone).localQ === 0`. Position is
   *    client-managed; preserve local's `macroZone` / `microZone` /
   *    `microLocation` / `surface`.
   *
   *  - **Stack preserve** (stack layout): `state === STACKED_ON_ROOT`
   *    AND `(serverRow.flags & FLAG_FORCE_POSITION) === 0`. Same
   *    preservation — the server isn't forcing a position so client
   *    wins. The `force_position` bit lives in `flags` (bit 11) and is
   *    set/cleared by the server explicitly; it used to live inside
   *    `microZone` as a bit-2 `force_flag`, freed when `microZone`
   *    bit 2 was repurposed as the chain `direction`.
   *
   *  When the **stack layout** applies AND the `force_position` flag is
   *  set, the server is asserting a specific chain position. We take
   *  server's position as-is AND renumber any *other* client-only
   *  cards in the same `(root_id, direction)` group whose position ≥
   *  the forced one by +1 — they "stack after" the server's confirmed
   *  position. */
  private mirrorCard(change: TableChange<Card>): void {
    const prev = this.cardsLocal.get(change.key);

    if (change.kind === "removed") {
      if (prev === undefined) return;
      this.cardsLocal.delete(change.key);
      this.fireCardLocal({ kind: "removed", key: change.key, oldRow: prev });
      return;
    }

    const serverRow = change.kind === "added" ? change.row : change.newRow;
    const serverState = serverRow.microZone & 0x3;

    // Defensive: state-1 (Slot) requires a present parent row at
    // `microLocation`. The server can't see the client's local overlay
    // — if for any reason the parent isn't here (subscription gap,
    // server bug, deletion race) the slot is an orphan and would
    // never render correctly. Force back to owner-inventory loose
    // (macroZone = ownerId, surface = 1, state = STACKED_LOOSE) so
    // the card is visible and recoverable. Same recovery shape that
    // `CardManager.releaseSlotDescendants` uses on the splice path.
    const orphanSlot =
      serverState === 1 /* STACKED_SLOT */ &&
      serverRow.microLocation !== change.key &&
      !this.cardsLocal.has(serverRow.microLocation);

    const bothInventory =
      prev !== undefined &&
      serverRow.surface === INVENTORY_LAYER &&
      prev.surface === INVENTORY_LAYER;

    let preservePosition = false;
    let serverForcesStackPosition = false;
    if (bothInventory && !orphanSlot) {
      if (serverState === 0 /* STACKED_LOOSE */) {
        // Legacy layout — gate on localQ === 0.
        preservePosition = unpackMicroZone(serverRow.microZone).localQ === 0;
      } else if (isStackLayout(serverState, serverRow.surface)) {
        // Stack layout — gate on the `force_position` flag (bit 11 of
        // `flags`). Used to live in `microZone` bit 2 alongside
        // `position` / `direction`; moved out to `flags` so `microZone`
        // could carry the chain `direction` instead.
        const forced = (serverRow.flags & FLAG_FORCE_POSITION) !== 0;
        preservePosition = !forced;
        serverForcesStackPosition = forced;
      }
      // STACKED_ON_HEX (3) — no special preserve; server is authoritative.
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
    const nextRow: LocalCard = {
      ...baseRow,
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
      if (idOf(packed) !== cardId) continue;
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
  private fireCardLocal(change: TableChange<Card>): void {
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
