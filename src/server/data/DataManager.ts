import type { Card, Player, Zone } from "../spacetime/bindings/types";
import type { ConnectionManager } from "../spacetime/ConnectionManager";
import { SubscriptionManager } from "../spacetime/SubscriptionManager";
import { unpackMicroZone } from "./packing";
import { ValidAtTable, type TableChange, type TableListener } from "./ValidAtTable";

const INVENTORY_LAYER = 1;

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
  readonly cardsLocal = new Map<number, Card>();
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
  setLocalCard(id: number, row: Card): void {
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

  /** Card-specific mirror: when the card is loose in inventory on both
   *  sides (`surface === INVENTORY_LAYER` for the incoming server row AND
   *  the existing local row, plus `unpackMicroZone(server.microZone).localQ
   *  === 0`), preserve the local row's position fields (`macroZone`,
   *  `microZone`, `microLocation`, `surface`) and only merge in the server's
   *  non-position fields (`flags`, `packedDefinition`, `ownerId`, etc.).
   *  Position in inventory is client-managed; the rest of the row stays
   *  authoritative on the server. */
  private mirrorCard(change: TableChange<Card>): void {
    const prev = this.cardsLocal.get(change.key);

    if (change.kind === "removed") {
      if (prev === undefined) return;
      this.cardsLocal.delete(change.key);
      this.fireCardLocal({ kind: "removed", key: change.key, oldRow: prev });
      return;
    }

    const serverRow = change.kind === "added" ? change.row : change.newRow;

    const isLooseInInventory =
      prev !== undefined &&
      serverRow.surface === INVENTORY_LAYER &&
      prev.surface === INVENTORY_LAYER &&
      unpackMicroZone(serverRow.microZone).localQ === 0;

    const nextRow: Card = isLooseInInventory && prev !== undefined
      ? {
          ...serverRow,
          macroZone:     prev.macroZone,
          microZone:     prev.microZone,
          microLocation: prev.microLocation,
          surface:       prev.surface,
        }
      : serverRow;

    this.cardsLocal.set(change.key, nextRow);
    if (prev === undefined) {
      this.fireCardLocal({ kind: "added", key: change.key, row: nextRow });
    } else if (prev !== nextRow) {
      this.fireCardLocal({ kind: "updated", key: change.key, oldRow: prev, newRow: nextRow });
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
