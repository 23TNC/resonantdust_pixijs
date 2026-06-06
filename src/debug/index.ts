/**
 * Lightweight debug logger. Each entry is [tag, minLevel]: a message prints
 * when it shares at least one tag with the config AND its level >= that tag's
 * minLevel. Level 0 prints everything; higher values suppress lower-priority
 * messages.
 *
 * Edit `config` here to toggle subsystems.
 */
const config: readonly (readonly [string, number])[] = [
  ["actions",     5],
  ["spacetime",   3],
  // Gateway client tracing, tiered by altitude:
  //   4 — high-level lifecycle (connect/close/init) + all warnings & errors.
  //       Infrequent; the monitoring floor.
  //   3 — top-level gate I/O: a logical subscribe, a frame sent/received,
  //       `applied`, call_ok/call_err. One line per transaction.
  //   2 — steps within those: handler registration, already-active skips.
  //   1 — per-row flood: row op, fanOut, raw wire payloads. Useful for deep
  //       debugging, useless for monitoring.
  // Default `3` = readable transaction-level view. Drop to `1` to trace every
  // row; raise to `4` for lifecycle-only; `5` silences everything.
  ["gate",        3],
  ["zone",        5],
  ["vite",        5],
  ["definitions", 5],
  ["layout",      5],
  ["cards",       5],
  ["splice",      5],
  ["drag",        0],
  ["chat",        5],
  ["objects",     5],
  // PixiJS warnings funneled in via `installPixiWarnInterceptor`.
  // Priority `1` silences expected chatter (`getCardArt`'s lazy-
  // load path always logs a Pixi "asset not found" warn for the
  // first frame after a card mounts, before the load resolves —
  // it's not actionable). Drop to `0` if you're chasing a Pixi
  // bug and want every warn to surface.
  ["pixi",        1],
] as const;

function shouldPrint(tags: string[], level: number): boolean {
  for (const [tag, priority] of config) {
    if (level >= priority && tags.includes(tag)) return true;
  }
  return false;
}

/** localStorage key backing `debug.showInfo` so the toggle survives
 *  reloads / HMR — flip it on, reload to reproduce, it stays on. */
const SHOW_INFO_KEY = "debug.showInfo";

function loadShowInfo(): boolean {
  try {
    return localStorage.getItem(SHOW_INFO_KEY) === "1";
  } catch {
    return false; // storage unavailable (private mode, etc.) — default off
  }
}

/** Listeners fired whenever `showInfo` flips — so overlays gated on it (e.g.
 *  `LayoutWorld`'s debug rings) can repaint immediately rather than waiting for
 *  the next relayout. */
const showInfoListeners = new Set<() => void>();

export const debug = {
  /** Global on-screen-debug switch. Flipped from the Debug panel's
   *  "Debug info" toggle; read by feature code (`if (debug.showInfo)
   *  …`) to gate rendering of debug overlays / readouts. Persisted to
   *  localStorage. Plain mutable field — readers see the live value
   *  through the shared `debug` object reference. */
  showInfo: loadShowInfo(),

  /** Flip `showInfo`, persist, notify listeners, and return the new value. */
  toggleInfo(): boolean {
    this.showInfo = !this.showInfo;
    try {
      localStorage.setItem(SHOW_INFO_KEY, this.showInfo ? "1" : "0");
    } catch {
      // storage unavailable — keep the in-memory toggle working anyway
    }
    for (const cb of showInfoListeners) cb();
    return this.showInfo;
  },

  /** Subscribe to `showInfo` flips. Returns an unsubscribe fn. */
  onShowInfoChange(cb: () => void): () => void {
    showInfoListeners.add(cb);
    return () => showInfoListeners.delete(cb);
  },

  log(tags: string[], message: string, level = 0): void {
    if (shouldPrint(tags, level)) console.debug(`[L${level}] ${message}`);
  },
  warn(tags: string[], message: string, level = 0): void {
    if (shouldPrint(tags, level)) console.warn(`[L${level}] ${message}`);
  },
};

/** PixiJS funnels every internal warning through
 *  `console.warn("PixiJS Warning: ", ...args)` (see
 *  `pixi.js/utils/logging/warn`). There's no Pixi-side hook for a
 *  custom logger, so we monkey-patch `console.warn` once at startup
 *  and reroute anything that starts with the `"PixiJS Warning: "`
 *  marker through `debug.warn(["pixi"], …)`. Toggle the `"pixi"`
 *  tag's priority in `config` above to gate visibility. Anything
 *  that isn't a Pixi warning passes through unchanged.
 *
 *  Idempotent — calling twice is a no-op so test harnesses (or a
 *  future HMR reload) don't stack interceptors. */
const PIXI_WARN_PREFIX = "PixiJS Warning:";
let pixiWarnInterceptorInstalled = false;

export function installPixiWarnInterceptor(): void {
  if (pixiWarnInterceptorInstalled) return;
  pixiWarnInterceptorInstalled = true;
  const original = console.warn.bind(console);
  console.warn = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === "string" && first.startsWith(PIXI_WARN_PREFIX)) {
      // Pixi calls with `("PixiJS Warning: ", ...rest)`, so the
      // marker arrives as its own arg and the real payload is the
      // rest. Stringify everything for the tag system; debug.warn
      // takes a single message line.
      const body = args.slice(1).map(stringifyArg).join(" ").trim();
      debug.warn(["pixi"], `[pixi] ${body}`);
      return;
    }
    original(...args);
  };
}

function stringifyArg(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try { return JSON.stringify(v); }
  catch { return String(v); }
}
