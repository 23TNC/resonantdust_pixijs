export type ChangeKind = "insert" | "update" | "delete" | "dying" | "dead";
export type ChangeSource = "server" | "client";

export interface ShadowedChange<T> {
  kind: ChangeKind;
  source: ChangeSource;
  key: number | string;
  oldValue?: T;
  newValue?: T;
}

export type ShadowedListener<T> = (change: ShadowedChange<T>) => void;

export interface ApplyResult {
  key: number | string;
  wasPresent: boolean;
  deferred: boolean;
}

export interface FlushResult {
  inserted: (number | string)[];
  removed: (number | string)[];
}

export type IndexMap<T> = {
  [indexName: string]: (row: T) => number | string;
};

interface IndexState<T> {
  keyOf: (row: T) => number | string;
  forward: Map<number | string, Set<number | string>>;
}

interface PendingEntry<T> {
  kind: "insert" | "update" | "delete" | "dying";
  row: T;
  applyAt: number;
}

const EMPTY_KEY_SET: ReadonlySet<number | string> = new Set();

export class ShadowedStore<T> {
  readonly server = new Map<number | string, T>();
  readonly client = new Map<number | string, T>();
  private readonly receivedAt = new Map<number | string, number>();
  private readonly flushedAt  = new Map<number | string, number>();
  private readonly listeners = new Set<ShadowedListener<T>>();
  private readonly serverWriteListeners = new Set<(row: T) => void>();
  private readonly serverDeleteListeners = new Set<(key: number | string, row: T) => void>();
  private readonly keyListeners = new Map<
    number | string,
    Set<ShadowedListener<T>>
  >();
  private readonly indexes = new Map<string, IndexState<T>>();
  private readonly pending = new Map<number | string, PendingEntry<T>>();

  constructor(
    readonly keyOf: (row: T) => number | string,
    indexes: IndexMap<T> = {},
    readonly delayMs = 0,
    private readonly delayForRow?: (row: T) => number,
    /** Called at flush time just before writing to the client map. Lets callers
     *  re-apply merge logic against the *current* client row (e.g. preserving
     *  locally-driven position that changed after the pending entry was queued). */
    private readonly flushTransform?: (pending: T, current: T | undefined) => T,
  ) {
    for (const [name, fn] of Object.entries(indexes)) {
      this.indexes.set(name, { keyOf: fn, forward: new Map() });
    }
  }

  subscribe(listener: ShadowedListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeKey(
    key: number | string,
    listener: ShadowedListener<T>,
  ): () => void {
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

  /** Fires synchronously whenever the server map is written, before any pending
   *  delay. Use this to react to server state immediately regardless of the
   *  store's display delay (e.g. login flows that must not be blocked). */
  subscribeServerWrite(listener: (row: T) => void): () => void {
    this.serverWriteListeners.add(listener);
    return () => { this.serverWriteListeners.delete(listener); };
  }

  /** Fires synchronously the first time a key is removed from the server map
   *  (delete, dying, or markDying). Fires at most once per key — duplicate
   *  server deletes for the same key are silently ignored. Use this to react
   *  to server state immediately, bypassing the client display delay. */
  subscribeServerDelete(listener: (key: number | string, row: T) => void): () => void {
    this.serverDeleteListeners.add(listener);
    return () => { this.serverDeleteListeners.delete(listener); };
  }

  applyServerInsert(row: T): ApplyResult {
    const key = this.keyOf(row);
    const prev = this.client.get(key);
    const wasPresent = prev !== undefined;
    const stored = Object.freeze({ ...row }) as T;
    this.server.set(key, stored);
    this.receivedAt.set(key, Date.now() / 1000);
    for (const l of this.serverWriteListeners) l(stored);

    if (this.delayMs > 0) {
      this.pending.set(key, {
        kind: wasPresent ? "update" : "insert",
        row: stored,
        applyAt: Date.now() + this.computeDelay(stored),
      });
      return { key, wasPresent, deferred: true };
    }

    this.pending.delete(key);
    this.flushedAt.set(key, Date.now() / 1000);
    this.client.set(key, stored);
    this.updateIndexes(prev, stored, key);
    this.emit({
      kind: wasPresent ? "update" : "insert",
      source: "server",
      key,
      oldValue: prev,
      newValue: stored,
    });
    return { key, wasPresent, deferred: false };
  }

  applyServerUpdate(oldRow: T, newRow: T): { key: number | string } {
    const key = this.keyOf(newRow);
    const stored = Object.freeze({ ...newRow }) as T;
    this.server.set(key, stored);
    this.receivedAt.set(key, Date.now() / 1000);
    for (const l of this.serverWriteListeners) l(stored);

    if (this.delayMs > 0) {
      const inClient = this.client.has(key);
      this.pending.set(key, {
        kind: inClient ? "update" : "insert",
        row: stored,
        applyAt: Date.now() + this.computeDelay(stored),
      });
      return { key };
    }

    this.pending.delete(key);
    this.flushedAt.set(key, Date.now() / 1000);
    this.client.set(key, stored);
    this.updateIndexes(oldRow, stored, key);
    this.emit({
      kind: "update",
      source: "server",
      key,
      oldValue: oldRow,
      newValue: stored,
    });
    return { key };
  }

  applyServerDelete(row: T): ApplyResult {
    const key = this.keyOf(row);
    const prev = this.client.get(key);
    const wasPresent = prev !== undefined;
    const serverRow = this.server.get(key);
    this.server.delete(key);
    if (serverRow !== undefined) this.fireServerDelete(key, serverRow);
    // Clear any pending entry (dying animation is driven by the dying-flag UPDATE,
    // not by the reaper DELETE — apply the delete immediately).
    this.pending.delete(key);
    this.client.delete(key);
    if (wasPresent) {
      this.updateIndexes(prev, undefined, key);
      this.emit({ kind: "delete", source: "server", key, oldValue: prev });
    }
    return { key, wasPresent, deferred: false };
  }

  /**
   * Promotes any pending entries whose `applyAt` has passed into the client
   * map and fires their change events. Returns keys that were added to or
   * removed from the client map so DataManager can fire keyset notifications.
   * Safe to call every frame — O(pending.size), which is 0 when delayMs=0.
   */
  flush(now: number): FlushResult {
    if (this.pending.size === 0) return { inserted: [], removed: [] };

    const inserted: (number | string)[] = [];
    const removed: (number | string)[] = [];

    for (const [key, entry] of this.pending) {
      if (now < entry.applyAt) continue;
      this.pending.delete(key);

      if (entry.kind === "delete") {
        const prev = this.client.get(key);
        if (prev !== undefined) {
          this.client.delete(key);
          this.updateIndexes(prev, undefined, key);
          this.emit({ kind: "delete", source: "server", key, oldValue: prev });
          removed.push(key);
        }
      } else if (entry.kind === "dying") {
        const prev = this.client.get(key);
        this.client.set(key, entry.row);
        this.updateIndexes(prev, entry.row, key);
        this.emit({ kind: "dying", source: "server", key, oldValue: prev, newValue: entry.row });
      } else {
        const prev = this.client.get(key);
        const wasPresent = prev !== undefined;
        const row = this.flushTransform ? this.flushTransform(entry.row, prev) : entry.row;
        this.flushedAt.set(key, now / 1000);
        this.client.set(key, row);
        this.updateIndexes(prev, row, key);
        this.emit({
          kind: wasPresent ? "update" : "insert",
          source: "server",
          key,
          oldValue: prev,
          newValue: row,
        });
        if (!wasPresent) inserted.push(key);
      }
    }

    return { inserted, removed };
  }

  /** Returns true if `key` has a queued server change that has not yet been
   *  promoted to the client map. Useful for rejecting player interactions on
   *  data the server has already modified (e.g. a completed action whose delete
   *  is still in the delay window). */
  hasPending(key: number | string): boolean {
    return this.pending.has(key);
  }

  /** Queues a dying transition for `row` to fire after `delayMs`. Until then
   *  the row remains in the client map unchanged. A subsequent server insert
   *  or update for the same key cancels the queued death. */
  queueDying(row: T, delayMs: number): void {
    const key = this.keyOf(row);
    const stored = Object.freeze({ ...row }) as T;
    const wasInServer = this.server.has(key);
    this.server.delete(key);
    if (wasInServer) this.fireServerDelete(key, stored);
    this.pending.set(key, { kind: "dying", row: stored, applyAt: Date.now() + delayMs });
  }

  /**
   * Keeps the row in the client map (so it remains readable) but removes it
   * from the server map and emits `"dying"`. The caller is responsible for
   * setting whatever dead-marker field the row carries before passing it here.
   */
  markDying(row: T): void {
    const key = this.keyOf(row);
    const prev = this.client.get(key);
    const stored = Object.freeze({ ...row }) as T;
    const wasInServer = this.server.has(key);
    this.server.delete(key);
    if (wasInServer) this.fireServerDelete(key, stored);
    this.client.set(key, stored);
    this.updateIndexes(prev, stored, key);
    this.emit({ kind: "dying", source: "server", key, oldValue: prev, newValue: stored });
  }

  /**
   * Removes the row from the client map and emits `"dead"` with the
   * last-known row as `oldValue`. No-op if the key is not present.
   */
  markDead(key: number | string): ApplyResult {
    const prev = this.client.get(key);
    const wasPresent = prev !== undefined;
    if (wasPresent) {
      this.client.delete(key);
      this.updateIndexes(prev, undefined, key);
      this.emit({ kind: "dead", source: "client", key, oldValue: prev });
    }
    return { key, wasPresent, deferred: false };
  }

  setClient(row: T): void {
    const key = this.keyOf(row);
    const prev = this.client.get(key);
    const stored = Object.freeze({ ...row }) as T;
    this.client.set(key, stored);
    this.updateIndexes(prev, stored, key);
    this.emit({
      kind: prev === undefined ? "insert" : "update",
      source: "client",
      key,
      oldValue: prev,
      newValue: stored,
    });
  }

  removeClient(key: number | string): void {
    const prev = this.client.get(key);
    if (prev === undefined) return;
    this.client.delete(key);
    this.updateIndexes(prev, undefined, key);
    this.emit({ kind: "delete", source: "client", key, oldValue: prev });
  }

  byIndex(
    indexName: string,
    indexKey: number | string,
  ): ReadonlySet<number | string> {
    return this.indexes.get(indexName)?.forward.get(indexKey) ?? EMPTY_KEY_SET;
  }

  get(key: number | string): T | undefined {
    return this.client.get(key);
  }

  getReceivedAt(key: number | string): number | undefined {
    return this.receivedAt.get(key);
  }

  getFlushedAt(key: number | string): number | undefined {
    return this.flushedAt.get(key);
  }

  has(key: number | string): boolean {
    return this.client.has(key);
  }

  values(): IterableIterator<T> {
    return this.client.values();
  }

  *delta(): Generator<{ key: number | string; server?: T; client?: T }> {
    const seen = new Set<number | string>();
    for (const [key, c] of this.client) {
      seen.add(key);
      const s = this.server.get(key);
      if (s !== c) yield { key, server: s, client: c };
    }
    for (const [key, s] of this.server) {
      if (!seen.has(key)) yield { key, server: s };
    }
  }

  /** Drop every row from both maps without firing change events or touching listeners. Use sparingly — most callers want `DataManager.clearTable` which fires deletes so subscribers can react. */
  clearRows(): void {
    this.server.clear();
    this.client.clear();
    this.receivedAt.clear();
    this.flushedAt.clear();
    this.pending.clear();
    for (const state of this.indexes.values()) state.forward.clear();
  }

  /** Drop everything: rows, listener sets, and indexes. Used at full teardown. */
  clear(): void {
    this.server.clear();
    this.client.clear();
    this.receivedAt.clear();
    this.flushedAt.clear();
    this.pending.clear();
    this.listeners.clear();
    this.keyListeners.clear();
    this.serverWriteListeners.clear();
    this.serverDeleteListeners.clear();
    for (const state of this.indexes.values()) state.forward.clear();
  }

  private computeDelay(row: T): number {
    return this.delayForRow ? this.delayForRow(row) : this.delayMs;
  }

  private updateIndexes(
    prev: T | undefined,
    next: T | undefined,
    primaryKey: number | string,
  ): void {
    for (const state of this.indexes.values()) {
      const prevIndexKey = prev !== undefined ? state.keyOf(prev) : undefined;
      const nextIndexKey = next !== undefined ? state.keyOf(next) : undefined;
      if (prevIndexKey === nextIndexKey) continue;
      if (prevIndexKey !== undefined) {
        const set = state.forward.get(prevIndexKey);
        if (set) {
          set.delete(primaryKey);
          if (set.size === 0) state.forward.delete(prevIndexKey);
        }
      }
      if (nextIndexKey !== undefined) {
        let set = state.forward.get(nextIndexKey);
        if (!set) {
          set = new Set();
          state.forward.set(nextIndexKey, set);
        }
        set.add(primaryKey);
      }
    }
  }

  private fireServerDelete(key: number | string, row: T): void {
    for (const listener of this.serverDeleteListeners) {
      try {
        listener(key, row);
      } catch (err) {
        console.error("[ShadowedStore] serverDelete listener threw", err);
      }
    }
  }

  private emit(change: ShadowedChange<T>): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        console.error("[ShadowedStore] listener threw", err);
      }
    }
    const keySet = this.keyListeners.get(change.key);
    if (keySet) {
      for (const listener of keySet) {
        try {
          listener(change);
        } catch (err) {
          console.error("[ShadowedStore] key listener threw", err);
        }
      }
    }
  }
}
