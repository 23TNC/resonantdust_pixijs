import type { Card, Player, Zone } from "../spacetime/bindings/types";
import type { ConnectionManager } from "../spacetime/ConnectionManager";
import { SubscriptionManager } from "../spacetime/SubscriptionManager";
import { ValidAtTable, type TableChange } from "./ValidAtTable";

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
 *  **Overrides** — calling `setLocal*(id, row)` writes to the overlay AND
 *  marks the key as overridden, so subsequent server-driven mirror events
 *  for that key are suppressed until `clearLocal*(id)` re-syncs from the
 *  server view. This lets client-side mutations (e.g. drag-drop position)
 *  survive across server pushes without polluting the server tier.
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
   *  Mirrors `<table>.current` until a `setLocal*` call marks a key as
   *  overridden. */
  readonly cardsLocal = new Map<number, Card>();
  readonly playersLocal = new Map<number, Player>();
  readonly zonesLocal = new Map<number, Zone>();

  private readonly cardOverrides = new Set<number>();
  private readonly playerOverrides = new Set<number>();
  private readonly zoneOverrides = new Set<number>();

  private readonly unsubMirror: Array<() => void> = [];

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

    // Mirror server tier → local overlay. Overridden keys stay frozen
    // (server changes for them are dropped on the floor until cleared).
    this.unsubMirror.push(
      this.cards.subscribe((c) => this.mirror(this.cardsLocal, this.cardOverrides, c)),
    );
    this.unsubMirror.push(
      this.players.subscribe((c) => this.mirror(this.playersLocal, this.playerOverrides, c)),
    );
    this.unsubMirror.push(
      this.zones.subscribe((c) => this.mirror(this.zonesLocal, this.zoneOverrides, c)),
    );
  }

  /** Write a row into the local overlay and mark the key as overridden.
   *  Subsequent server-driven mirror events for this key are suppressed
   *  until `clearLocalCard(id)` is called. Use for client-side mutations
   *  (e.g. optimistic position changes) that should survive server pushes. */
  setLocalCard(id: number, row: Card): void {
    this.cardOverrides.add(id);
    this.cardsLocal.set(id, row);
  }

  /** Drop the override for `id`, re-sync the overlay value from the server
   *  view (`cards.current.get(id)`). Use after the server confirms the
   *  client mutation, or to abandon a local change. */
  clearLocalCard(id: number): void {
    this.cardOverrides.delete(id);
    const row = this.cards.current.get(id);
    if (row) this.cardsLocal.set(id, row);
    else this.cardsLocal.delete(id);
  }

  setLocalPlayer(id: number, row: Player): void {
    this.playerOverrides.add(id);
    this.playersLocal.set(id, row);
  }

  clearLocalPlayer(id: number): void {
    this.playerOverrides.delete(id);
    const row = this.players.current.get(id);
    if (row) this.playersLocal.set(id, row);
    else this.playersLocal.delete(id);
  }

  setLocalZone(id: number, row: Zone): void {
    this.zoneOverrides.add(id);
    this.zonesLocal.set(id, row);
  }

  clearLocalZone(id: number): void {
    this.zoneOverrides.delete(id);
    const row = this.zones.current.get(id);
    if (row) this.zonesLocal.set(id, row);
    else this.zonesLocal.delete(id);
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
    this.cardOverrides.clear();
    this.playerOverrides.clear();
    this.zoneOverrides.clear();
  }

  private mirror<T>(
    map: Map<number, T>,
    overrides: Set<number>,
    change: TableChange<T>,
  ): void {
    if (overrides.has(change.key)) return;
    if (change.kind === "removed") {
      map.delete(change.key);
    } else {
      map.set(change.key, change.kind === "added" ? change.row : change.newRow);
    }
  }
}
