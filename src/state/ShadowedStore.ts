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

/** Runs at fire-time on the row going into the client map. The server map and
 *  `receivedAt` already hold the original. Only invoked for delayed writes —
 *  sync writes (delayMs ≤ 0) bypass the transform. Must not change the row's
 *  primary key. */
export type FireTransform<T> = (row: T, delayMs: number) => T;

export interface ShadowedStoreOptions<T> {
  clientTransform?: FireTransform<T>;
  /** Reads the row's server-stamped lag (in ms). When `applyServer*` is called
   *  with `delayMs > 0`, this lag is subtracted from the effective fire delay
   *  — the server was already that late, so the client display buffer
   *  consumes the lag instead of stacking on top of it. */
  deltaTMs?: (row: T) => number;
  /** Default fire delay for `applyServerInsert` / `applyServerUpdate` /
   *  `applyServerDelete` / `markDying` when the caller doesn't pass one. The
   *  per-call `delayMs` argument overrides this — pass `0` to bypass the
   *  buffer (e.g. teardown / `clearTable`). */
  delayMs?: number;
}

interface IndexState<T> {
  keyOf: (row: T) => number | string;
  forward: Map<number | string, Set<number | string>>;
}

type PendingOp<T> =
  | {
      kind: "insert";
      row: T;
      delayMs: number;
      fireAt: number;
      timer: ReturnType<typeof setTimeout> | null;
      resolve: (r: ApplyResult) => void;
      reject: (e: unknown) => void;
    }
  | {
      kind: "update";
      oldRow: T;
      newRow: T;
      delayMs: number;
      fireAt: number;
      timer: ReturnType<typeof setTimeout> | null;
      resolve: (r: { key: number | string }) => void;
      reject: (e: unknown) => void;
    }
  | {
      kind: "delete";
      row: T;
      fireAt: number;
      timer: ReturnType<typeof setTimeout> | null;
      resolve: (r: ApplyResult) => void;
      reject: (e: unknown) => void;
    }
  | {
      kind: "dying";
      row: T;
      fireAt: number;
      timer: ReturnType<typeof setTimeout> | null;
      resolve: () => void;
      reject: (e: unknown) => void;
    };

const EMPTY_KEY_SET: ReadonlySet<number | string> = new Set();

export class ShadowedStore<T> {
  readonly server = new Map<number | string, T>();
  readonly client = new Map<number | string, T>();
  private readonly receivedAt = new Map<number | string, number>();
  private readonly flushedAt = new Map<number | string, number>();
  private readonly listeners = new Set<ShadowedListener<T>>();
  private readonly keyListeners = new Map<
    number | string,
    Set<ShadowedListener<T>>
  >();
  private readonly indexes = new Map<string, IndexState<T>>();
  private readonly pendingQueues = new Map<number | string, PendingOp<T>[]>();
  private readonly clientTransform: FireTransform<T> | undefined;
  private readonly deltaTMs: ((row: T) => number) | undefined;
  private readonly defaultDelayMs: number;

  constructor(
    readonly keyOf: (row: T) => number | string,
    indexes: IndexMap<T> = {},
    options: ShadowedStoreOptions<T> = {},
  ) {
    for (const [name, fn] of Object.entries(indexes)) {
      this.indexes.set(name, { keyOf: fn, forward: new Map() });
    }
    this.clientTransform = options.clientTransform;
    this.deltaTMs = options.deltaTMs;
    this.defaultDelayMs = options.delayMs ?? 0;
  }

  /** Compress the requested fire delay by the row's server-stamped lag. The
   *  per-call argument falls back to the store's `defaultDelayMs`; pass an
   *  explicit `0` to bypass the buffer entirely. */
  private fireDelayFor(row: T, delayMs: number | undefined): number {
    const requested = delayMs ?? this.defaultDelayMs;
    if (requested <= 0) return 0;
    if (!this.deltaTMs) return requested;
    return Math.max(0, requested - this.deltaTMs(row));
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

  applyServerInsert(row: T, delayMs?: number): Promise<ApplyResult> {
    const key = this.keyOf(row);
    const stored = Object.freeze({ ...row }) as T;
    this.server.set(key, stored);
    this.receivedAt.set(key, Date.now() / 1000);
    const fireDelay = this.fireDelayFor(stored, delayMs);
    if (fireDelay <= 0) {
      return Promise.resolve(this.commitInsertToClient(stored));
    }
    return new Promise<ApplyResult>((resolve, reject) => {
      this.queuePending(key, {
        kind: "insert",
        row: stored,
        delayMs: fireDelay,
        fireAt: Date.now() + fireDelay,
        timer: null,
        resolve,
        reject,
      });
    });
  }

  applyServerUpdate(
    oldRow: T,
    newRow: T,
    delayMs?: number,
  ): Promise<{ key: number | string }> {
    const key = this.keyOf(newRow);
    const stored = Object.freeze({ ...newRow }) as T;
    this.server.set(key, stored);
    this.receivedAt.set(key, Date.now() / 1000);
    const fireDelay = this.fireDelayFor(stored, delayMs);
    if (fireDelay <= 0) {
      return Promise.resolve(this.commitUpdateToClient(oldRow, stored));
    }
    return new Promise<{ key: number | string }>((resolve, reject) => {
      this.queuePending(key, {
        kind: "update",
        oldRow,
        newRow: stored,
        delayMs: fireDelay,
        fireAt: Date.now() + fireDelay,
        timer: null,
        resolve,
        reject,
      });
    });
  }

  applyServerDelete(row: T, delayMs?: number): Promise<ApplyResult> {
    const key = this.keyOf(row);
    this.server.delete(key);
    const fireDelay = this.fireDelayFor(row, delayMs);
    if (fireDelay <= 0) {
      return Promise.resolve(this.commitDeleteToClient(key));
    }
    return new Promise<ApplyResult>((resolve, reject) => {
      this.queuePending(key, {
        kind: "delete",
        row,
        fireAt: Date.now() + fireDelay,
        timer: null,
        resolve,
        reject,
      });
    });
  }

  private commitInsertToClient(stored: T): ApplyResult {
    const key = this.keyOf(stored);
    const prev = this.client.get(key);
    const wasPresent = prev !== undefined;
    this.client.set(key, stored);
    this.flushedAt.set(key, Date.now() / 1000);
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

  private commitUpdateToClient(
    oldRow: T,
    stored: T,
  ): { key: number | string } {
    const key = this.keyOf(stored);
    this.client.set(key, stored);
    this.flushedAt.set(key, Date.now() / 1000);
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

  private commitDeleteToClient(key: number | string): ApplyResult {
    const prev = this.client.get(key);
    const wasPresent = prev !== undefined;
    if (wasPresent) {
      this.client.delete(key);
      this.updateIndexes(prev, undefined, key);
      this.emit({ kind: "delete", source: "server", key, oldValue: prev });
    }
    return { key, wasPresent };
  }

  /**
   * Keeps the row in the client map (so it remains readable) but removes it
   * from the server map and emits `"dying"`. The caller is responsible for
   * setting whatever dead-marker field the row carries before passing it here.
   * Honors the store's default `delayMs` (and any caller override) so dying
   * transitions ride the same display buffer as regular updates.
   */
  markDying(row: T, delayMs?: number): Promise<void> {
    const fireDelay = this.fireDelayFor(row, delayMs);
    if (fireDelay <= 0) {
      this.commitDyingToClient(row);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.queuePending(this.keyOf(row), {
        kind: "dying",
        row,
        fireAt: Date.now() + fireDelay,
        timer: null,
        resolve,
        reject,
      });
    });
  }

  private commitDyingToClient(row: T): void {
    const key = this.keyOf(row);
    const prev = this.client.get(key);
    const stored = Object.freeze({ ...row }) as T;
    this.server.delete(key);
    this.client.set(key, stored);
    this.flushedAt.set(key, Date.now() / 1000);
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

  /** True if any delayed server write is still queued for `key` (or, when no key is supplied, anywhere in the store). */
  hasPending(key?: number | string): boolean {
    if (key === undefined) return this.pendingQueues.size > 0;
    return this.pendingQueues.has(key);
  }

  /** Force every pending delayed write for `key` (or all keys, if omitted) to commit synchronously. Pending promises resolve as if the timer had fired. */
  flushPending(key?: number | string): void {
    if (key === undefined) {
      for (const k of [...this.pendingQueues.keys()]) this.flushPending(k);
      return;
    }
    const queue = this.pendingQueues.get(key);
    if (!queue) return;
    while (queue.length > 0) {
      const head = queue[0];
      if (head.timer !== null) {
        clearTimeout(head.timer);
        head.timer = null;
      }
      this.firePending(key);
    }
  }

  /** Drop every row from both maps without firing change events or touching listeners. Use sparingly — most callers want `DataManager.clearTable` which fires deletes so subscribers can react. */
  clearRows(): void {
    this.cancelAllPending("ShadowedStore.clearRows");
    this.server.clear();
    this.client.clear();
    this.receivedAt.clear();
    this.flushedAt.clear();
    for (const state of this.indexes.values()) state.forward.clear();
  }

  /** Drop everything: rows, listener sets, and indexes. Used at full teardown. */
  clear(): void {
    this.cancelAllPending("ShadowedStore.clear");
    this.server.clear();
    this.client.clear();
    this.receivedAt.clear();
    this.flushedAt.clear();
    this.listeners.clear();
    this.keyListeners.clear();
    for (const state of this.indexes.values()) state.forward.clear();
  }

  private queuePending(key: number | string, op: PendingOp<T>): void {
    let queue = this.pendingQueues.get(key);
    if (!queue) {
      queue = [];
      this.pendingQueues.set(key, queue);
    }
    queue.push(op);
    if (queue.length === 1) this.armPendingTimer(key);
  }

  private armPendingTimer(key: number | string): void {
    const queue = this.pendingQueues.get(key);
    if (!queue || queue.length === 0) return;
    const head = queue[0];
    const delay = Math.max(0, head.fireAt - Date.now());
    head.timer = setTimeout(() => this.firePending(key), delay);
  }

  private firePending(key: number | string): void {
    const queue = this.pendingQueues.get(key);
    if (!queue || queue.length === 0) return;
    const op = queue.shift()!;
    op.timer = null;
    try {
      switch (op.kind) {
        case "insert":
          op.resolve(
            this.commitInsertToClient(this.transformForClient(op.row, op.delayMs)),
          );
          break;
        case "update":
          op.resolve(
            this.commitUpdateToClient(
              op.oldRow,
              this.transformForClient(op.newRow, op.delayMs),
            ),
          );
          break;
        case "delete":
          op.resolve(this.commitDeleteToClient(this.keyOf(op.row)));
          break;
        case "dying":
          this.commitDyingToClient(op.row);
          op.resolve();
          break;
      }
    } catch (err) {
      op.reject(err);
    }
    if (queue.length === 0) {
      this.pendingQueues.delete(key);
    } else {
      this.armPendingTimer(key);
    }
  }

  private transformForClient(row: T, delayMs: number): T {
    if (!this.clientTransform) return row;
    return Object.freeze({ ...this.clientTransform(row, delayMs) }) as T;
  }

  private cancelAllPending(reason: string): void {
    for (const queue of this.pendingQueues.values()) {
      for (const op of queue) {
        if (op.timer !== null) {
          clearTimeout(op.timer);
          op.timer = null;
        }
        op.reject(new Error(reason));
      }
    }
    this.pendingQueues.clear();
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
