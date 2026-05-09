import { idOf, validAtOf, type ValidAt } from "./packing";

/** A change to the table's `current` view, fired by `promote(now)`. */
export type TableChange<T> =
  | { kind: "added"; key: number; row: T }
  | { kind: "updated"; key: number; oldRow: T; newRow: T }
  | { kind: "removed"; key: number; oldRow: T };

export type TableListener<T> = (change: TableChange<T>) => void;

/** Local mirror of a SpacetimeDB table whose primary key is a packed u64
 *  `(high32 = id, low32 = valid_at seconds)`. Multiple rows per `id` may
 *  coexist on the server; `promote(now)` selects, for each `id`, the row
 *  whose `valid_at` is the largest one that is `<= now`, and surfaces it
 *  via `current`.
 *
 *  `server` mirrors every row we believe the server has, keyed by the
 *  packed `valid_at`. `current` holds the row that is currently valid for
 *  each `id`. Subscribe to `current` changes via `subscribe` (whole-table)
 *  or `subscribeKey` (single id). Events fire from inside `promote(now)`
 *  based on the diff between the old and new `current` view — server
 *  inserts whose `valid_at` is still in the future do not fire. */
export class ValidAtTable<T> {
  readonly server = new Map<ValidAt, T>();
  readonly current = new Map<number, T>();

  private readonly tableListeners = new Set<TableListener<T>>();
  private readonly keyListeners = new Map<number, Set<TableListener<T>>>();

  /** `keyOf(row)` returns the packed-u64 key for a row. For tables whose
   *  rows already carry the packed key, pass `(r) => r.validAt`. */
  constructor(private readonly keyOf: (row: T) => ValidAt) {}

  insert = (row: T): void => {
    this.server.set(this.keyOf(row), row);
  };

  update = (oldRow: T, newRow: T): void => {
    const oldKey = this.keyOf(oldRow);
    const newKey = this.keyOf(newRow);
    if (oldKey !== newKey) this.server.delete(oldKey);
    this.server.set(newKey, newRow);
  };

  delete = (row: T): void => {
    this.server.delete(this.keyOf(row));
  };

  /** Subscribe to every `current`-view change in this table. Fires per id
   *  whose row was added, updated, or removed during `promote(now)`. The
   *  listener does NOT receive an initial snapshot — read `current`
   *  directly if you need the starting state. Returns an unsubscribe fn. */
  subscribe(listener: TableListener<T>): () => void {
    this.tableListeners.add(listener);
    return () => {
      this.tableListeners.delete(listener);
    };
  }

  /** Subscribe to `current`-view changes for a single id. Subscribing to
   *  an id that doesn't yet exist is fine — the listener fires when an
   *  insert lands and `promote` brings it into `current`. Listeners are
   *  not auto-removed on `removed`; the same listener fires again if a
   *  row with the same id reappears. Returns an unsubscribe fn. */
  subscribeKey(key: number, listener: TableListener<T>): () => void {
    let set = this.keyListeners.get(key);
    if (!set) {
      set = new Set();
      this.keyListeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const s = this.keyListeners.get(key);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.keyListeners.delete(key);
    };
  }

  /** Walk `server` once and promote, for each `id`, the row whose
   *  `valid_at` is the largest one that is `<= now`. Diff against the
   *  prior `current` view, update the map, and fire `added` / `updated`
   *  / `removed` events to subscribers. `now` is in absolute seconds —
   *  pass a buffered now (e.g. wall-clock minus a display buffer) to
   *  align the view to the server's valid_at timeline. */
  promote(now: number): void {
    const best = new Map<number, { row: T; validAt: number }>();
    // Track every id that has ANY row in the server map (regardless of
    // validAt). Used below to suppress spurious `removed` events when the
    // server is mid-replacement: SpacetimeDB's schedule_delete_cards
    // sweeps delete the old row in a separate transaction from the
    // propose_action insert, and the SDK can deliver the resulting
    // onDelete before onInsert. Without this guard, the row's id falls
    // out of `best` between the two events and `removed` fires, causing
    // CardManager to destroy + respawn the Card (and snap to its first
    // setTarget — typically (0,0) for a fresh server row).
    const knownIds = new Set<number>();
    for (const [packed, row] of this.server) {
      const id = idOf(packed);
      knownIds.add(id);
      const validAt = validAtOf(packed);
      if (validAt > now) continue;
      const prev = best.get(id);
      if (prev === undefined || validAt > prev.validAt) {
        best.set(id, { row, validAt });
      }
    }

    for (const [id, { row }] of best) {
      const prev = this.current.get(id);
      if (prev === undefined) {
        this.current.set(id, row);
        this.fire({ kind: "added", key: id, row });
      } else if (prev !== row) {
        this.current.set(id, row);
        this.fire({ kind: "updated", key: id, oldRow: prev, newRow: row });
      }
    }
    for (const id of [...this.current.keys()]) {
      if (!best.has(id)) {
        // If the server map still holds *any* row for this id (even one
        // at a future validAt that hasn't elapsed yet), the card isn't
        // truly removed — it's just shifted to a row we can't promote
        // yet. Keep the existing `current` entry so a subsequent
        // promote produces an `updated` event when the replacement
        // becomes eligible.
        if (knownIds.has(id)) continue;
        const oldRow = this.current.get(id)!;
        this.current.delete(id);
        this.fire({ kind: "removed", key: id, oldRow });
      }
    }
  }

  /** Drop all rows and listeners. Use on HMR / runtime teardown so a
   *  fresh `ValidAtTable` doesn't share state (or stale listeners) with
   *  the torn-down one. */
  dispose(): void {
    this.server.clear();
    this.current.clear();
    this.tableListeners.clear();
    this.keyListeners.clear();
  }

  /** Snapshot listener sets before iterating so a listener that
   *  (un)subscribes during firing doesn't break the loop. Per-listener
   *  try/catch so one bad listener can't stop the others. */
  private fire(change: TableChange<T>): void {
    if (this.tableListeners.size > 0) {
      for (const l of [...this.tableListeners]) {
        try {
          l(change);
        } catch (err) {
          console.error("[ValidAtTable] table listener threw", err);
        }
      }
    }
    const set = this.keyListeners.get(change.key);
    if (set && set.size > 0) {
      for (const l of [...set]) {
        try {
          l(change);
        } catch (err) {
          console.error("[ValidAtTable] key listener threw", err);
        }
      }
    }
  }
}
