/** A single entry in the local log feed. `timestamp` is the local
 *  `Date.now()` at push time — purely for ordering / rendering. */
export interface LogEntry {
  text: string;
  timestamp: number;
}

export type LogListener = () => void;

/** Ring-buffer cap. 200 entries is plenty for "what happened around me
 *  recently" without paying a memory cost. Older entries are evicted
 *  in `push()` once the cap is exceeded. */
const MAX_ENTRIES = 200;

/**
 * Scene-scoped, client-only feed of flavor-text events ("{actor} cut
 * down {root}", etc.). Unlike `chat_messages`, nothing here is
 * server-backed — game systems (CardManager, recipe completion paths,
 * future ActionManager re-add) call `push()` as observable things
 * happen, and the chat panel's `logs` tab renders the buffer.
 *
 * Lifecycle mirrors `cards` / `actions` on `GameContext`: created in
 * `GameScene.onEnter`, cleared in `onExit`. Listeners are dropped on
 * `dispose()`.
 */
export class LogManager {
  private readonly entries: LogEntry[] = [];
  private readonly listeners = new Set<LogListener>();

  /** Append a new entry. Evicts the oldest entry when the buffer is
   *  full so memory stays bounded. Fires every listener after the
   *  buffer update so the renderer can pick up the change in one pass. */
  push(text: string): void {
    this.entries.push({ text, timestamp: Date.now() });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
    this.fire();
  }

  /** Snapshot of every entry in order, oldest → newest. The renderer
   *  walks this each time `subscribe`'s listener fires. */
  getAll(): readonly LogEntry[] {
    return this.entries;
  }

  /** Subscribe to push events. Listener fires with no payload — read
   *  `getAll()` for the fresh snapshot. Returns an unsubscribe fn. */
  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Drop every entry and listener. Use on scene exit / HMR teardown
   *  so a fresh `LogManager` doesn't share state (or stale listeners)
   *  with the torn-down one. */
  dispose(): void {
    this.entries.length = 0;
    this.listeners.clear();
  }

  /** Snapshot listeners before iterating so a listener that
   *  (un)subscribes during firing doesn't break the loop. Per-listener
   *  try/catch so one bad listener can't stop the others. */
  private fire(): void {
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      try {
        listener();
      } catch (err) {
        console.error("[LogManager] listener threw", err);
      }
    }
  }
}
