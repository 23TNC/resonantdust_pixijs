/** A change to an `AppendTable`'s view. Mirrors `ValidAtTable`'s
 *  shape so consumers can reuse the same handler patterns. There is
 *  no `updated` variant for append-only tables — chat is never edited
 *  server-side — but the SDK can still emit `onUpdate` callbacks (e.g.
 *  for tables that *are* updated). We surface those as `removed`+`added`
 *  pairs at the SDK boundary; the consumer-facing event stays binary. */
export type AppendTableChange<T> =
  | { kind: "added"; key: bigint; row: T }
  | { kind: "removed"; key: bigint; oldRow: T };

export type AppendTableListener<T> = (change: AppendTableChange<T>) => void;

/** Local mirror of a SpacetimeDB *flat* (non-versioned) table — append-
 *  only rows keyed by a single u64. Designed for `chat_messages` where
 *  the primary key (`sent_at`) is already a packed `[time | seq]`
 *  timestamp that sorts chronologically. Unlike `ValidAtTable`, there's
 *  no version-history machinery: `current` is the table itself.
 *
 *  Keys are `bigint` to match the SpacetimeDB SDK's u64 typing. Use
 *  `sorted()` for chronological iteration; the underlying `Map`
 *  preserves insertion order but messages may arrive out-of-order on
 *  initial subscription. */
export class AppendTable<T> {
  /** All rows, keyed by their packed-u64 primary key. */
  readonly rows = new Map<bigint, T>();

  private readonly tableListeners = new Set<AppendTableListener<T>>();

  /** `keyOf(row)` returns the row's u64 primary key. */
  constructor(private readonly keyOf: (row: T) => bigint) {}

  insert = (row: T): void => {
    const key = this.keyOf(row);
    if (this.rows.has(key)) return;
    this.rows.set(key, row);
    this.fire({ kind: "added", key, row });
  };

  /** Treat the SDK's `onUpdate` as a remove+add pair. Chat messages
   *  are never updated in practice, but keeping the handler defined
   *  is forward-friendly. */
  update = (oldRow: T, newRow: T): void => {
    const oldKey = this.keyOf(oldRow);
    const newKey = this.keyOf(newRow);
    if (this.rows.has(oldKey)) {
      this.rows.delete(oldKey);
      this.fire({ kind: "removed", key: oldKey, oldRow });
    }
    if (!this.rows.has(newKey)) {
      this.rows.set(newKey, newRow);
      this.fire({ kind: "added", key: newKey, row: newRow });
    }
  };

  delete = (row: T): void => {
    const key = this.keyOf(row);
    const existing = this.rows.get(key);
    if (existing === undefined) return;
    this.rows.delete(key);
    this.fire({ kind: "removed", key, oldRow: existing });
  };

  /** Subscribe to every insert / delete. Does NOT replay current rows
   *  — call `sorted()` (or iterate `rows`) for the starting snapshot.
   *  Returns an unsubscribe fn. */
  subscribe(listener: AppendTableListener<T>): () => void {
    this.tableListeners.add(listener);
    return () => {
      this.tableListeners.delete(listener);
    };
  }

  /** Rows in ascending PK order — for `chat_messages` this is
   *  chronological since `sent_at` is `[time_ms | seq]`. O(n log n)
   *  per call; cache the result if you call it on every render. */
  sorted(): T[] {
    return [...this.rows.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, row]) => row);
  }

  dispose(): void {
    this.rows.clear();
    this.tableListeners.clear();
  }

  /** Snapshot listeners before iterating so a listener that
   *  (un)subscribes during firing doesn't break the loop. Per-listener
   *  try/catch so one bad listener can't stop the others. */
  private fire(change: AppendTableChange<T>): void {
    const snapshot = [...this.tableListeners];
    for (const listener of snapshot) {
      try {
        listener(change);
      } catch (err) {
        console.error("[AppendTable] listener threw", err);
      }
    }
  }
}
