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
}

export type IndexMap<T> = {
  [indexName: string]: (row: T) => number | string;
};

interface IndexState<T> {
  keyOf: (row: T) => number | string;
  forward: Map<number | string, Set<number | string>>;
}

const EMPTY_KEY_SET: ReadonlySet<number | string> = new Set();

export class ShadowedStore<T> {
  readonly server = new Map<number | string, T>();
  readonly client = new Map<number | string, T>();
  private readonly receivedAt = new Map<number | string, number>();
  private readonly listeners = new Set<ShadowedListener<T>>();
  private readonly keyListeners = new Map<
    number | string,
    Set<ShadowedListener<T>>
  >();
  private readonly indexes = new Map<string, IndexState<T>>();

  constructor(
    readonly keyOf: (row: T) => number | string,
    indexes: IndexMap<T> = {},
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

  applyServerInsert(row: T): ApplyResult {
    const key = this.keyOf(row);
    const prev = this.client.get(key);
    const wasPresent = prev !== undefined;
    const stored = Object.freeze({ ...row }) as T;
    this.server.set(key, stored);
    this.client.set(key, stored);
    this.receivedAt.set(key, Date.now() / 1000);
    this.updateIndexes(prev, stored, key);
    this.emit({
      kind: wasPresent ? "update" : "insert",
      source: "server",
      key,
      oldValue: prev,
      newValue: stored,
    });
    return { key, wasPresent };
  }

  applyServerUpdate(oldRow: T, newRow: T): { key: number | string } {
    const key = this.keyOf(newRow);
    const stored = Object.freeze({ ...newRow }) as T;
    this.server.set(key, stored);
    this.client.set(key, stored);
    this.receivedAt.set(key, Date.now() / 1000);
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
    this.server.delete(key);
    this.client.delete(key);
    if (wasPresent) {
      this.updateIndexes(prev, undefined, key);
      this.emit({ kind: "delete", source: "server", key, oldValue: prev });
    }
    return { key, wasPresent };
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
    this.server.delete(key);
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
    return { key, wasPresent };
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
    for (const state of this.indexes.values()) state.forward.clear();
  }

  /** Drop everything: rows, listener sets, and indexes. Used at full teardown. */
  clear(): void {
    this.server.clear();
    this.client.clear();
    this.receivedAt.clear();
    this.listeners.clear();
    this.keyListeners.clear();
    for (const state of this.indexes.values()) state.forward.clear();
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
