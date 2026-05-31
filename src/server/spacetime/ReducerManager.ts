import { debug } from "../../debug";
import { sharedGate } from "../gate/GateConnection";

/** Recursively shape a reducer's named args for SpacetimeDB's HTTP `/call`:
 *  camelCase keys → snake_case, and `bigint` → `number` (u64 args must be JSON
 *  numbers; dev values — `clientTimeMs`, low-card_id `macroZone` — fit under
 *  2^53). Carries the gate-relayed write payload. */
function toCallArgs(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(toCallArgs);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = toCallArgs(v);
    }
    return out;
  }
  return value;
}

/**
 * Owns reducer calls. Each reducer is a thin wrapper that awaits the
 * connection and forwards to the SDK's typed reducers. Centralising them
 * here keeps the SDK boundary in one file and gives us a single place to
 * add cross-cutting concerns (logging, retry, telemetry).
 *
 * Also owns the client's notion of **server time**. Every reducer
 * SpacetimeDB processes delivers an `EventContext` to its onInsert /
 * onUpdate / onDelete callbacks; the context's `event.value.timestamp`
 * is the server's wall-clock at the moment the reducer ran. The
 * `SubscriptionManager` forwards that timestamp to `noteServerTime`,
 * which records the (server-micros, local-millis) pair. Callers that
 * need to ask "what does the server think now is?" call
 * `serverNowMs()`, which interpolates from the last capture forward
 * using the local monotonic delta — so even between updates the
 * estimate stays current. Used by `DataManager.promote()` to align
 * `ValidAtTable` promotion to the server's timeline instead of
 * `Date.now()`, eliminating the artificial "future-row" delay when
 * the client clock drifts behind the server's.
 *
 * Two robustness measures stack on top of the raw capture:
 *
 *   1. **Sliding-window offset selection.** A single capture pair is
 *      polluted by client-side JS event-loop jitter — when the runtime
 *      is busy (frame stalls, GC), the SDK callback fires noticeably
 *      after the bytes arrived, so the client-time read at callback
 *      fire lags the true receive moment and the captured offset reads
 *      artificially low. We keep the last `SAMPLE_WINDOW` captures and
 *      pick the one with the **largest** `serverMicros − localPerfMs`
 *      offset — the freshest, least-queued measurement. Selection was
 *      historically against `Date.now()`, but under hosts whose
 *      wall-clock steps mid-window (WSL2 hypervisor time-sync,
 *      NTP-adjusted laptops on suspend/resume) that biased the anchor
 *      toward whichever moment `Date.now()` was furthest behind
 *      reality, inflating the resulting estimate by that step.
 *      `performance.now()` is monotonic and never steps, so the
 *      ordering is stable regardless of host clock instability.
 *
 *   2. **Adaptive client delay (`clientDelay`).** Backward lag applied
 *      to every `serverNowMs()` output so the client stays safely
 *      behind true server. Sized at `2 * runningDelay` and clamped to
 *      `[CLIENT_DELAY_MIN_MS, CLIENT_DELAY_MAX_MS]`, where
 *      `runningDelay` tracks the EWMA of recent spike magnitudes.
 *      Grows on observed turbulence, decays as conditions improve.
 *      Purely client-local — no server coordination. The server uses
 *      a static `BACKWARD_GRACE_MS` (= 10s) wide enough to cover the
 *      client's max `clientDelay` (5s) with 2× headroom, so the
 *      client adapts freely within `[1500, 5000]` without telling
 *      the server anything.
 *
 * Routing: every reducer — gameplay, world, chat, and login
 * (`claimOrLogin` / `setLastLogin`) — goes through the gate (`gateCall`).
 * No direct SpacetimeDB module connection remains; the gate is the sole
 * server transport. The clock window is fed by the gate's `time` heartbeat
 * (`noteServerTime`), not by SDK reducer events.
 */
export class ReducerManager {
  /** Sliding window of recent reducer-event captures. Each entry pairs
   *  the server's `event.value.timestamp` (microseconds) with **two**
   *  client-side time readings at the moment the SDK callback fired:
   *
   *   - `localPerfMs` = `performance.now()` (monotonic, immune to
   *     wall-clock jumps from NTP / WSL2 hyper-v time-sync). Used for
   *     **both** best-sample selection (max `serverMicros −
   *     localPerfMs`) and elapsed-time interpolation between captures.
   *   - `localMillis` = `Date.now()` (unix wall-clock). Retained only
   *     for the debug panel's human-readable "server vs wall-clock"
   *     gap readout; not used in any sync math.
   *
   *  Why `performance.now()` for both: WSL2 guest clocks regularly get
   *  nudged forward (or, on hypervisor catch-up, backward) by tens of
   *  ms to several seconds when they fall behind/ahead of the host. If
   *  we used `Date.now()` to compute capture offsets, a backward nudge
   *  during the window would make the offending sample's
   *  `serverMicros/1000 − Date.now()` read artificially high — and
   *  since we pick the largest offset as the anchor, the buggy sample
   *  would lock in until it evicts. `performance.now()` is monotonic
   *  and never steps, so the ordering across the window is stable
   *  regardless of host clock instability.
   *
   *  Bounded at `SAMPLE_WINDOW` — oldest entry evicted on insert. */
  private readonly captures: Array<{
    serverMicros: bigint;
    localMillis: number;
    localPerfMs: number;
  }> = [];

  /** Window size for offset selection. Large enough to ride through a
   *  few jittery callbacks without losing the underlying signal, small
   *  enough that genuine clock drift on either side gets reflected
   *  within a few seconds of activity. */
  private static readonly SAMPLE_WINDOW = 16;

  /** Anchor-selection mode. Set to `"max"` for production (current
   *  default): `pickAnchor()` scans the whole window and picks the
   *  freshest-delivered capture, providing jitter immunity by caching
   *  a best-case reference until something fresher displaces it.
   *
   *  Set to `"latest"` as a diagnostic mode to isolate per-capture
   *  delivery behavior. The anchor is always the most recent capture,
   *  so `serverNowMs()` tracks the latest known server time directly
   *  and Delta becomes the prediction error between *consecutive*
   *  captures only — useful when investigating sequence-dependent
   *  patterns (server-side cache warmup, JIT, etc.) where the cached
   *  best masks the trend. Best/Worst diagnostic readouts still scan
   *  the full window independently, so the spread stays visible. */
  private static readonly ANCHOR_MODE: "max" | "latest" = "max";

  /** Rolling window of recent RTT samples (ms), most-recent at the
   *  end. Populated by `ping()`; sized to absorb jitter while staying
   *  responsive to genuine network-condition changes. */
  private readonly rttSamples: number[] = [];

  /** Cap on the RTT sample window. Same size as offset window — both
   *  reflect "how recent should the smoothed value be". */
  private static readonly RTT_SAMPLE_WINDOW = 16;

  /** Prediction-error reading set on every fresh capture: how far off
   *  was the extrapolation from the prior anchor when this new
   *  capture's server-stamp arrived?
   *
   *  At capture-time `P_new` with reading `S_new`, the pre-capture
   *  estimate of server time at that perf-instant was
   *  `prev_anchor.serverMicros/1000 + (P_new − prev_anchor.localPerfMs)`
   *  (no lag-buffer subtraction — that's a presentation offset, not
   *  part of the prediction). Error = `predicted − actual`. Positive
   *  means we extrapolated past the actual server time (rate ran fast
   *  and/or delivery delay shrank); negative means we lagged behind
   *  (rate ran slow or delivery delay grew).
   *
   *  Held until the next capture overwrites it, so the sparkline shows
   *  a step function rather than a one-frame blip per event. `null`
   *  before the second capture (need a prior anchor to predict
   *  against). Also reset by `correctFromDrift` since the synthetic
   *  capture isn't a real prediction-vs-actual comparison. */
  private lastPredictionErrorMs: number | null = null;

  /** Bounded multi-series time-history for the debug panel's
   *  sparklines and any future drift-trend analysis. Keyed by
   *  free-form series name (`"offsetMs"`, `"rttMs"`, etc.) so callers
   *  pick what to track without ReducerManager needing to know;
   *  values are appended in caller-chosen sample order and bounded at
   *  `HISTORY_LIMIT` (FIFO eviction). `NaN` is allowed as a "no data
   *  this tick" placeholder so multiple series sampled together stay
   *  index-aligned even when one of them isn't ready yet. */
  private readonly histories: Map<string, number[]> = new Map();

  /** Cap on per-series history length. At 2Hz sampling that's 5
   *  minutes of trail; at 60Hz it's 10 seconds. Caller controls
   *  cadence via how often it calls `sampleSyncHistory()` /
   *  `recordHistorySample()`. */
  private static readonly HISTORY_LIMIT = 600;

  /** Regex matching the server's `time_drift:` rejection prefix from
   *  `effective_now_ms`. Same shape as `ActionManager.TIME_DRIFT_RE` —
   *  duplicated here because ReducerManager intercepts the rejection
   *  to feed a corrected capture back into the window, before the
   *  error propagates up to action-specific retry logic. */
  private static readonly TIME_DRIFT_RE = /time_drift:client_(ahead|behind)_by=(\d+)/;

  // ── Adaptive client-delay state ─────────────────────────────────
  //
  // Replaces the old static `CLIENT_LAG_MS = 2000`. Three intertwined
  // pieces tracked per-session:
  //
  //   - `runningDelta` — offset correction added to every extrapolation.
  //     Tracks "how much do we need to add to raw_extrapolation right
  //     now to match the actual server time." Half-step feedback
  //     controller: each capture computes residual error (corrected
  //     prediction vs actual stamp) and adjusts running_delta toward
  //     zeroing that error. Converges to 0 in steady state, swings
  //     transiently after D-shifts then decays exponentially.
  //
  //   - `runningDelay` — EWMA of recent extreme-spike magnitudes.
  //     Tracks the worst-case capture-to-capture variance observed
  //     recently. Decays as conditions improve (each new spike pulls
  //     it halfway toward that spike's magnitude — works both
  //     directions).
  //
  //   - `clientDelay` — derived as `2 * runningDelay`, clamped to
  //     [CLIENT_DELAY_MIN_MS, CLIENT_DELAY_MAX_MS]. Subtracted from
  //     `serverNowMs()` to keep us safely behind true server. The
  //     2× safety factor and the server-side 2× factor (the server's
  //     backward grace is `2 * clientDelay`) means transient spikes
  //     have generous headroom.
  //
  // Two-branch update on each capture, threshold =
  // `running_delay / 2`:
  //
  //   if |current_delta| > running_delay / 2:  spike, track magnitude
  //       running_delay += (|current_delta| - running_delay) / 2
  //       client_delay = clamp(2 * running_delay, MIN, MAX)
  //   else:                                     normal, smooth offset
  //       running_delta -= current_delta / 2
  //
  // Threshold is self-adjusting (= half of current running_delay) so
  // there's no magic-number ratio. The running_delay EWMA is
  // symmetric — deltas in [running_delay/2, running_delay) pull it
  // down; deltas > running_delay pull it up. Converges to roughly
  // the mean of upper-half delta magnitudes ("average spike"),
  // bounded by the clamp ceiling.

  private runningDelta = 0;
  private runningDelay = 1_500;   // RUNNING_DELAY_INIT_MS
  private clientDelay = 3_000;    // CLIENT_DELAY_INIT_MS

  /** Initial running_delay value. Sized so initial client_delay
   *  (2 * this) matches the pre-adaptive `CLIENT_LAG_MS = 2000` while
   *  giving the system room to grow on early-session spikes. */
  private static readonly RUNNING_DELAY_INIT_MS = 1_500;

  /** Initial client_delay. Equals `2 * RUNNING_DELAY_INIT_MS` but
   *  clamped — kept explicit for clarity. */
  private static readonly CLIENT_DELAY_INIT_MS = 3_000;

  /** Hard lower bound on `clientDelay`. Below this the deliberate lag
   *  drops below typical delivery delay + RTT/2, leaving zero headroom
   *  for routine variance. Keep this above the noise floor. */
  private static readonly CLIENT_DELAY_MIN_MS = 1_500;

  /** Hard upper bound on `clientDelay`. Caps how much one absurd reading
   *  (e.g. first-capture against an uninitialized prev_delta) can
   *  permanently inflate the lag budget. 5s is generous; if the system
   *  needs more than this we're outside the regime this design targets. */
  private static readonly CLIENT_DELAY_MAX_MS = 5_000;

  constructor() {}

  /** The logged-in player_id, set by `PlayerManager` after login. Forwarded
   *  to the gate as `caller_player_id` for the shard reducers that authenticate
   *  the caller (the gate is the auth boundary now; the reducers trust it). */
  private callerPlayerId: number | null = null;

  setCallerPlayerId(playerId: number | null): void {
    this.callerPlayerId = playerId;
  }

  private requireCaller(): number {
    if (this.callerPlayerId == null) {
      throw new Error("[gate] no caller player_id set (not logged in yet)");
    }
    return this.callerPlayerId;
  }

  /** Relay a shard reducer through the gate (write path). `args` is the named
   *  argument set; it's shaped for `/call` by `toCallArgs`. */
  private gateCall(reducer: string, args: Record<string, unknown>): Promise<void> {
    const gate = sharedGate();
    gate.ensureConnected();
    return gate.call(reducer, toCallArgs(args));
  }

  /** Record a fresh server timestamp from a reducer event. Captures
   *  `performance.now()` (the canonical client clock for all sync
   *  math) and `Date.now()` (kept only for the debug panel readout).
   *  See the `captures` field doc for the split.
   *
   *  Also runs the three-branch adaptive update on `runningDelta`,
   *  `runningDelay`, and `clientDelay`. See the adaptive-state field
   *  doc block for the algorithm spec. */
  noteServerTime(microsSinceUnixEpoch: bigint): void {
    const newPerfMs = performance.now();
    // Compute current_delta against the CORRECTED prediction
    // (raw_extrapolation + running_delta) so it measures residual
    // error in our offset estimate — the value we'd actually be
    // shipping via `serverNowMs()` at that moment. Positive
    // current_delta = our estimate ran ahead of the new ground truth
    // (need to pull running_delta down); negative = behind (push it
    // up). The `-= currentDelta/2` update is a half-step feedback
    // controller that converges running_delta → 0 in steady state
    // and decays exponentially after D-shifts.
    const prevAnchor = this.pickAnchor();
    if (prevAnchor) {
      const rawPrediction = Number(prevAnchor.serverMicros) / 1_000
        + (newPerfMs - prevAnchor.localPerfMs);
      const correctedPrediction = rawPrediction + this.runningDelta;
      const actual = Number(microsSinceUnixEpoch) / 1_000;
      const currentDelta = correctedPrediction - actual;
      this.lastPredictionErrorMs = currentDelta;

      const absCurrent = Math.abs(currentDelta);

      if (absCurrent > this.runningDelay / 2) {
        // Spike: |delta| exceeds half of running_delay. Pull
        // running_delay toward |currentDelta| via EWMA — symmetric,
        // so |delta| in [running_delay/2, running_delay) shrinks it
        // (the term is negative) and |delta| > running_delay grows
        // it. Equilibrium converges to roughly the mean magnitude
        // of upper-half deltas (those exceeding running_delay/2),
        // which approximates "average spike."
        this.runningDelay += (absCurrent - this.runningDelay) / 2;
        const target = 2 * this.runningDelay;
        this.clientDelay = Math.max(
          ReducerManager.CLIENT_DELAY_MIN_MS,
          Math.min(ReducerManager.CLIENT_DELAY_MAX_MS, target),
        );
        debug.log(
          ["spacetime"],
          `[spacetime] adaptive clientDelay spike: currentDelta=${Math.round(currentDelta)} runningDelay=${Math.round(this.runningDelay)} clientDelay=${Math.round(this.clientDelay)}`,
          4,
        );
        // No server-side coordination needed: the server uses a static
        // `BACKWARD_GRACE_MS` (= 10s) wide enough to cover the client's
        // max `clientDelay` (5s) with 2× margin. Adapting locally is
        // sufficient.
      } else {
        // Normal: residual error within current lag-budget reference.
        // Pull running_delta toward what would zero out current_delta:
        // positive currentDelta (we're high) → subtract; negative
        // (we're low) → add (subtract a negative). Half-step feedback
        // converges running_delta → 0 in steady state.
        this.runningDelta -= currentDelta / 2;
      }
    }
    this.captures.push({
      serverMicros: microsSinceUnixEpoch,
      localMillis: Date.now(),
      localPerfMs: newPerfMs,
    });
    if (this.captures.length > ReducerManager.SAMPLE_WINDOW) {
      this.captures.shift();
    }
    // Event-driven history push: one entry per capture event (vs the
    // time-driven `sampleSyncHistory()` cadence used by other series).
    // Stores the raw `serverMicros/1000 − localPerfMs` offset — pickAnchor's
    // input space. Plotted as a scatter so individual freebies (high
    // points) and slow captures (low points) are visually distinct,
    // letting you see exactly when the anchor's reference sample
    // enters/exits the window.
    this.recordHistorySample(
      "captureOffsetMs",
      Number(microsSinceUnixEpoch) / 1_000 - newPerfMs,
    );
  }

  /** Inspect a thrown SDK error for the server's `time_drift:` rejection
   *  prefix; if matched, seed a synthetic capture computed from the
   *  reported gap. This is the feedback loop that closes desync without
   *  waiting for the next subscription update to arrive — every drift
   *  rejection carries an exact server-time reading (we sent
   *  `clientTimeMs` and the server tells us how far off it was), so we
   *  can compute `server_now_at_processing = clientTimeMs ∓ gapMs` and
   *  inject it as if it had been a fresh capture.
   *
   *  Crucially, **clears the existing capture window before pushing**.
   *  If the window has drifted to the point of producing a rejection,
   *  every entry in it is biased and pickAnchor() would still anchor
   *  on the stale samples even with the synthetic added. Starting
   *  fresh forces the next `serverNowMs()` call to use this corrected
   *  reading, and subsequent reducer events will refill the window
   *  with valid samples.
   *
   *  `perfMsAtSend` is the `performance.now()` reading from immediately
   *  before the SDK call (the same `start` value used by `recordRtt`).
   *  We approximate the server's processing perf-time as the midpoint
   *  of the round-trip — the best estimate without server-side
   *  echoing — which can be off by up to RTT/2 either way. Even at
   *  500ms RTT that's only 250ms of perf-time uncertainty, well
   *  inside the 2-second grace budget.
   *
   *  Called from each reducer wrapper's catch block; the error is
   *  always re-thrown so callers' existing handling (ActionManager's
   *  `proposeAction` retry, etc.) still runs. */
  private correctFromDrift(err: unknown, clientTimeMs: number, perfMsAtSend: number): void {
    const match = ReducerManager.TIME_DRIFT_RE.exec(String(err));
    if (!match) return;
    const direction = match[1] as "ahead" | "behind";
    const gapMs = Number.parseInt(match[2], 10);
    if (!Number.isFinite(gapMs)) return;
    const serverTimeMs = direction === "ahead"
      ? clientTimeMs - gapMs
      : clientTimeMs + gapMs;
    const perfMs = (perfMsAtSend + performance.now()) / 2;
    this.captures.length = 0;
    this.captures.push({
      serverMicros: BigInt(Math.round(serverTimeMs)) * 1000n,
      localMillis: Date.now(),
      localPerfMs: perfMs,
    });
    // Drop the stale prediction-error reading — the synthetic capture
    // isn't a real prediction-vs-actual comparison, and the prior
    // reading was from a window that just got cleared.
    this.lastPredictionErrorMs = null;
    // Reset the adaptive offset correction: it was accumulated against
    // the now-discarded window, so applying it to extrapolations from
    // the synthetic anchor would double-count the correction.
    // running_delay / clientDelay are NOT reset — those track the
    // observed spike magnitude over a longer history and remain valid.
    this.runningDelta = 0;
    debug.log(
      ["spacetime"],
      `[spacetime] correctFromDrift direction=${direction} gapMs=${gapMs} serverTimeMs=${Math.round(serverTimeMs)} (window reset to 1 synthetic capture)`,
      4,
    );
  }

  /** Pick the capture currently anchoring time estimation: the entry
   *  with the largest `serverMicros/1000 − localPerfMs` offset — the
   *  freshest, least-queued measurement. Returns null before the first
   *  capture lands. Shared by `serverNowMs()` (interpolation source)
   *  and `syncStats()` (panel readout) so both report a consistent
   *  anchor. */
  private pickAnchor(): { serverMicros: bigint; localMillis: number; localPerfMs: number } | null {
    if (this.captures.length === 0) return null;
    if (ReducerManager.ANCHOR_MODE === "latest") {
      return this.captures[this.captures.length - 1];
    }
    let best = this.captures[0];
    let bestOffsetMs = Number(best.serverMicros) / 1_000 - best.localPerfMs;
    for (let i = 1; i < this.captures.length; i++) {
      const c = this.captures[i];
      const offsetMs = Number(c.serverMicros) / 1_000 - c.localPerfMs;
      if (offsetMs > bestOffsetMs) {
        best = c;
        bestOffsetMs = offsetMs;
      }
    }
    return best;
  }

  /** Server wall-clock now, in unix milliseconds (float). Adaptive
   *  three-term computation:
   *    `serverNowMs = raw_anchor_extrapolation + running_delta - client_delay`
   *  where:
   *    - `raw_anchor_extrapolation = anchor.serverMicros/1000 +
   *       (perf.now() − anchor.localPerfMs)` — pure rate extrapolation
   *       from the latest known server stamp.
   *    - `runningDelta` — accumulated offset correction that smooths
   *       anchor-swap jumps (see field doc).
   *    - `clientDelay` — deliberate backward lag, sized to current
   *       observed worst-case variance (`2 * runningDelay`, clamped).
   *
   *  Falls back to `Date.now() - clientDelay` before the first capture
   *  lands (initial connect). Once any capture exists, this is the
   *  source of truth for "now" everywhere the client compares against
   *  server `valid_at` values. */
  serverNowMs(): number {
    const best = this.pickAnchor();
    if (!best) return Date.now() - this.clientDelay;
    const elapsedMillis = performance.now() - best.localPerfMs;
    const rawMs = Number(best.serverMicros) / 1_000 + elapsedMillis;
    return rawMs + this.runningDelta - this.clientDelay;
  }

  /** Push a fresh RTT sample into the rolling window. Called by every
   *  reducer wrapper after its SDK call resolves; the delta from
   *  `performance.now()` bookends approximates "network round-trip +
   *  server processing time". `syncStats().bestRttMs` returns the min
   *  over the window — cheap reducers bottom out near pure network
   *  RTT, so the minimum filters out the processing-time contribution
   *  from heavier reducers. */
  private recordRtt(rttMs: number): void {
    this.rttSamples.push(rttMs);
    if (this.rttSamples.length > ReducerManager.RTT_SAMPLE_WINDOW) {
      this.rttSamples.shift();
    }
  }

  /** Read-only snapshot of the time-sync state for the debug panel.
   *  Cheap — single scan of the capture window. Returns:
   *
   *   - `serverNowMs`: current `serverNowMs()` estimate (buffered).
   *   - `dateNowMs`: client's `Date.now()`.
   *   - `offsetMs`: `serverNowMs − dateNowMs`. Negative when the
   *     client's wall-clock leads the server's; positive when it
   *     trails. Steady-state is `−clientDelay + K` where K is the
   *     server-ahead-of-client clock offset.
   *   - `captures`: current window length.
   *   - `bestOffsetMs`: the anchor capture's `serverMicros/1000 −
   *     localMillis` offset (wall-clock view, for human comparison
   *     against `dateNowMs` in the panel). The anchor is selected via
   *     `pickAnchor()` (max `serverMicros − localPerfMs`), so this
   *     value tracks the chosen anchor's wall-clock gap rather than
   *     the window-wide max of wall-clock offsets.
   *   - `worstOffsetMs`: symmetric to `bestOffsetMs` but for the
   *     capture with the *minimum* perf-offset in the window — i.e.
   *     the slowest-delivered sample. Reporting its wall-clock offset
   *     (not its perf-offset) so the two values are directly
   *     comparable as a wall-clock range. Watching best vs worst over
   *     time tells you whether spread changes are driven by freebies
   *     entering (best moves up) or slow captures arriving (worst
   *     moves down).
   *   - `deltaMs`: prediction error from the most recent capture —
   *     how far the extrapolation from the prior anchor missed the
   *     freshly-arrived server stamp. Held until the next capture
   *     overwrites it (so the sparkline shows step changes, not
   *     one-frame spikes). Positive = we extrapolated past actual;
   *     negative = we lagged. Null before the second capture or
   *     after a drift-correction window clear.
   *   - `clientLagMs`: live `clientDelay` value subtracted from
   *     `serverNowMs()`. Adaptive — grows on extreme spikes, decays
   *     as conditions stabilize. Client-local only; the server's
   *     static `BACKWARD_GRACE_MS` (= 10s) covers it with margin.
   *   - `runningDeltaMs`: cumulative offset correction. Smooths
   *     anchor-swap jumps. In steady state oscillates near zero.
   *   - `runningDelayMs`: EWMA of recent extreme-spike magnitudes.
   *     Drives `clientDelay = 2 * this`, clamped.
   *   - `rttMs`: most recent ping RTT in ms, or null if no ping has
   *     succeeded yet.
   *   - `bestRttMs`: min RTT across the sample window — closest to
   *     the true uncontended round-trip. Null until first sample.
   *   - `rttSamples`: number of RTT samples currently in the window. */
  syncStats(): {
    serverNowMs: number;
    dateNowMs: number;
    offsetMs: number;
    captures: number;
    bestOffsetMs: number | null;
    worstOffsetMs: number | null;
    deltaMs: number | null;
    clientLagMs: number;
    runningDeltaMs: number;
    runningDelayMs: number;
    rttMs: number | null;
    bestRttMs: number | null;
    rttSamples: number;
  } {
    const dateNowMs = Date.now();
    const serverNowMs = this.serverNowMs();
    // Best/Worst diagnostic scans are independent of `pickAnchor()`'s
    // mode — they always report the actual freshest and slowest
    // captures in the window, regardless of which one `pickAnchor()`
    // chooses for time estimation. That way the spread stays visible
    // even when `ANCHOR_MODE === "latest"` (diagnostic mode).
    let bestOffsetMs: number | null = null;
    let worstOffsetMs: number | null = null;
    if (this.captures.length > 0) {
      let best = this.captures[0];
      let bestPerfOffset = Number(best.serverMicros) / 1_000 - best.localPerfMs;
      let worst = best;
      let worstPerfOffset = bestPerfOffset;
      for (let i = 1; i < this.captures.length; i++) {
        const c = this.captures[i];
        const o = Number(c.serverMicros) / 1_000 - c.localPerfMs;
        if (o > bestPerfOffset)  { best = c;  bestPerfOffset = o; }
        if (o < worstPerfOffset) { worst = c; worstPerfOffset = o; }
      }
      bestOffsetMs  = Number(best.serverMicros)  / 1_000 - best.localMillis;
      worstOffsetMs = Number(worst.serverMicros) / 1_000 - worst.localMillis;
    }
    const deltaMs = this.lastPredictionErrorMs;
    let bestRttMs: number | null = null;
    for (const r of this.rttSamples) {
      if (bestRttMs === null || r < bestRttMs) bestRttMs = r;
    }
    const rttMs = this.rttSamples.length > 0
      ? this.rttSamples[this.rttSamples.length - 1]
      : null;
    return {
      serverNowMs,
      dateNowMs,
      offsetMs: serverNowMs - dateNowMs,
      captures: this.captures.length,
      bestOffsetMs,
      worstOffsetMs,
      deltaMs,
      clientLagMs: this.clientDelay,
      runningDeltaMs: this.runningDelta,
      runningDelayMs: this.runningDelay,
      rttMs,
      bestRttMs,
      rttSamples: this.rttSamples.length,
    };
  }

  /** Append `value` to the history series named `series`, creating
   *  the series lazily on first push. Evicts the oldest entry once
   *  the series exceeds `HISTORY_LIMIT`. `NaN` is permitted (and
   *  meaningful: rendering code can skip those points to leave gaps
   *  for "no data" ticks while keeping series index-aligned). */
  recordHistorySample(series: string, value: number): void {
    let arr = this.histories.get(series);
    if (!arr) {
      arr = [];
      this.histories.set(series, arr);
    }
    arr.push(value);
    if (arr.length > ReducerManager.HISTORY_LIMIT) arr.shift();
  }

  /** Take one snapshot of the live sync state and append each scalar
   *  to its corresponding history series. Called by the debug panel
   *  on its own cadence (typically downsampled below the panel's
   *  per-frame update rate to keep history span useful). Null-valued
   *  stats (RTT before any reducer round-trips, anchor before any
   *  capture) record as `NaN` so series stay length-matched.
   *
   *  Series names match the `syncStats()` field names so panel code
   *  can iterate the snapshot keys instead of hard-coding the list. */
  sampleSyncHistory(): void {
    const s = this.syncStats();
    this.recordHistorySample("offsetMs", s.offsetMs);
    this.recordHistorySample("bestOffsetMs", s.bestOffsetMs ?? Number.NaN);
    this.recordHistorySample("worstOffsetMs", s.worstOffsetMs ?? Number.NaN);
    this.recordHistorySample("deltaMs", s.deltaMs ?? Number.NaN);
    this.recordHistorySample("clientDelayMs", s.clientLagMs);
    this.recordHistorySample("runningDeltaMs", s.runningDeltaMs);
    this.recordHistorySample("runningDelayMs", s.runningDelayMs);
    this.recordHistorySample("rttMs", s.rttMs ?? Number.NaN);
    this.recordHistorySample("bestRttMs", s.bestRttMs ?? Number.NaN);
    this.recordHistorySample("captures", s.captures);
  }

  /** Read-only view of the named history series. Returns an empty
   *  array if the series has never been recorded — callers don't need
   *  to special-case startup. */
  getHistory(series: string): readonly number[] {
    return this.histories.get(series) ?? [];
  }

  /** All series names known so far (i.e. that have been pushed to at
   *  least once). Lets the panel discover what's available without a
   *  hard-coded list — register a graph by series name and ignore
   *  series that don't exist yet. */
  getHistorySeries(): readonly string[] {
    return Array.from(this.histories.keys());
  }

  /** Move the caller's soul along a client-computed path. Client
   *  A* runs in [pixijs/src/game/world/pathfind.ts](../../game/world/pathfind.ts);
   *  this just submits the result. The server validates adjacency +
   *  traversability per step and queues the per-step row writes. See
   *  [docs/MOVEMENT_REWRITE.md](../../../../docs/MOVEMENT_REWRITE.md). */
  async moveSoul(args: {
    soulId: number;
    path: Array<{ surface: number; macroZone: bigint; microLocation: number }>;
  }): Promise<void> {
    const clientTimeMs = BigInt(Math.round(this.serverNowMs()));
    debug.log(
      ["spacetime"],
      `[spacetime] moveSoul soul=${args.soulId} steps=${args.path.length} clientTimeMs=${clientTimeMs}`,
      0,
    );
    const start = performance.now();
    try {
      await this.gateCall("move_soul", {
        ...args,
        callerPlayerId: this.requireCaller(),
        clientTimeMs,
      });
    } catch (err) {
      this.correctFromDrift(err, Number(clientTimeMs), start);
      throw err;
    } finally {
      this.recordRtt(performance.now() - start);
    }
  }

  /** Generic card-placement reducer. See
   *  `docs/PLACE_CARD_GENERALIZATION.md` and
   *  [place.rs](../../../../spacetime/server/modules/shard/src/place.rs).
   *
   *  `placement.kind` selects the variant:
   *  - `0` (Stack): stack source under `parent_id` in `direction`
   *    (STACK_DIRECTION_UP/DOWN/HEX). Other fields ignored.
   *  - `1` (Loose): place loose at `(surface, macro_zone, q, r, xy)`.
   *    Inventory uses `xy` (packed (x, y)); world uses `(q, r)`.
   *
   *  Replaces the retired `equipCard` / `unequipCard` pair. */
  async placeCard(args: {
    cardId: number;
    placement: {
      kind: number;
      parentId: number;
      direction: number;
      surface: number;
      macroZone: bigint;
      q: number;
      r: number;
      xy: number;
    };
  }): Promise<void> {
    const clientTimeMs = BigInt(Math.round(this.serverNowMs()));
    debug.log(
      ["spacetime"],
      `[spacetime] placeCard card=${args.cardId} placement=${JSON.stringify(args.placement, (_k, v) => typeof v === "bigint" ? v.toString() : v)} clientTimeMs=${clientTimeMs}`,
      0,
    );
    const start = performance.now();
    try {
      await this.gateCall("place_card", {
        ...args,
        callerPlayerId: this.requireCaller(),
        clientTimeMs,
      });
    } catch (err) {
      this.correctFromDrift(err, Number(clientTimeMs), start);
      throw err;
    } finally {
      this.recordRtt(performance.now() - start);
    }
  }

  /** Fire `request_blueprint`: spawn a blueprint card at
   *  `(surface, macroZone, microZone, microLocation)` owned by
   *  `soulCardId`. The server validates that the soul has
   *  discovered the blueprint (`SoulPrivate.blueprints_0`), that
   *  the soul belongs to the caller's player, and that the soul
   *  has a free build slot under its `aspects.builder` cap.
   *  Driven by the blueprint-ghost drag's drop handler in
   *  `DragManager.handleBlueprintDrop`. */
  async requestBlueprint(args: {
    soulCardId: number;
    blueprintId: number;
    surface: number;
    macroZone: bigint;
    microLocation: number;
  }): Promise<void> {
    const clientTimeMs = BigInt(Math.round(this.serverNowMs()));
    debug.log(
      ["spacetime"],
      `[spacetime] requestBlueprint blueprint=${args.blueprintId} soul=${args.soulCardId} ` +
        `surface=${args.surface} macroZone=${args.macroZone} ` +
        `microLocation=${args.microLocation} clientTimeMs=${clientTimeMs}`,
      0,
    );
    const start = performance.now();
    try {
      await this.gateCall("request_blueprint", {
        ...args,
        callerPlayerId: this.requireCaller(),
        clientTimeMs,
      });
    } catch (err) {
      this.correctFromDrift(err, Number(clientTimeMs), start);
      throw err;
    } finally {
      this.recordRtt(performance.now() - start);
    }
  }

  /** Trust-on-first-use login by name. Used by `PlayerManager.claimOrLogin`.
   *  Routes through this manager so the `clientTimeMs` injection is
   *  centralized; PlayerManager doesn't need its own `serverNowMs()`
   *  access. */
  async claimOrLogin(args: { name: string }): Promise<void> {
    const clientTimeMs = BigInt(Math.round(this.serverNowMs()));
    debug.log(
      ["spacetime"],
      `[spacetime] claimOrLogin name=${args.name} clientTimeMs=${clientTimeMs}`,
      4,
    );
    // Login → the gate, which relays to the `players` auth DB AND establishes
    // the WS → player_id session (it reads the new player row by name). The
    // player-row write is what `PlayerManager` waits on via its `players`
    // subscription; clock-sync is now the gate's `time` heartbeat.
    const start = performance.now();
    try {
      await this.gateCall("claim_or_login", { ...args, clientTimeMs });
    } catch (err) {
      this.correctFromDrift(err, Number(clientTimeMs), start);
      throw err;
    } finally {
      this.recordRtt(performance.now() - start);
    }
    // Soul spawn is driven client-side via `spawnSoul` after the client sees it
    // owns no soul on its assigned card shard.
  }

  /** Spawn the local player's `player_soul` (via the gate → cards shard).
   *  Driven client-side: after login the client subscribes its owned
   *  cards and, seeing none, calls this. `soulIndex` is `1 + owned-soul
   *  count`; the reducer rejects if the player already owns >= that many
   *  souls, so a stale-low client count can't double-spawn. Trusts
   *  `playerId` (auth is the gateway's job). */
  async spawnSoul(playerId: number, soulIndex: number): Promise<void> {
    const clientTimeMs = BigInt(Math.round(this.serverNowMs()));
    debug.log(
      ["spacetime"],
      `[spacetime] spawnSoul playerId=${playerId} index=${soulIndex} clientTimeMs=${clientTimeMs}`,
      4,
    );
    const start = performance.now();
    try {
      await this.gateCall("spawn_soul", { playerId, soulIndex, clientTimeMs });
    } catch (err) {
      this.correctFromDrift(err, Number(clientTimeMs), start);
      throw err;
    } finally {
      this.recordRtt(performance.now() - start);
    }
  }

  /** Submit a recipe proposal. New wire format (per the unified
   *  card model — see docs/RECIPE_TAPE_REWRITE.md):
   *
   *  - `recipeId`: stable u16 from `recipes/id.json`.
   *  - `surface` / `macroZone` / `microZone`: root's intended world
   *    location (or inventory address).
   *  - `root`: root card_id.
   *  - `bindings`: per-iterator card_id lists. `bindings[i]` is the
   *    cards the recipe's `i`-th iterator binds to, in offset
   *    order. Branch 0 (tile) accepts `0` as the no-card sentinel
   *    when the action targets a synthetic tile. */
  async proposeAction(args: {
    recipeId: number;
    surface: number;
    macroZone: bigint;
    microLocation: number;
    root: number;
    bindings: number[][];
  }): Promise<void> {
    const clientTimeMs = BigInt(Math.round(this.serverNowMs()));
    debug.log(
      ["spacetime"],
      `[spacetime] proposeAction recipe=${args.recipeId} root=${args.root} surface=${args.surface} macroZone=${args.macroZone} microLocation=0x${args.microLocation.toString(16)} bindings=${JSON.stringify(args.bindings)} clientTimeMs=${clientTimeMs}`,
      0,
    );
    const start = performance.now();
    try {
      await this.gateCall("propose_action", {
        ...args,
        callerPlayerId: this.requireCaller(),
        clientTimeMs,
      });
    } catch (err) {
      this.correctFromDrift(err, Number(clientTimeMs), start);
      throw err;
    } finally {
      this.recordRtt(performance.now() - start);
    }
  }

  async setLastLogin(): Promise<void> {
    const clientTimeMs = BigInt(Math.round(this.serverNowMs()));
    debug.log(
      ["spacetime"],
      `[spacetime] setLastLogin clientTimeMs=${clientTimeMs}`,
      4,
    );
    // Through the gate — the gate injects `player_id` from the session (it owns
    // the session, so the client never supplies it). The clock window is now
    // seeded by the gate's `time` heartbeat, not this reducer's row write.
    const start = performance.now();
    try {
      await this.gateCall("set_last_login", { clientTimeMs });
    } catch (err) {
      this.correctFromDrift(err, Number(clientTimeMs), start);
      throw err;
    } finally {
      this.recordRtt(performance.now() - start);
    }
  }

  /** Ask the server to spawn the zone at `macroZone` (region-gated, idempotent
   *  server-side). Driven by `ZoneManager`'s region gate when a wanted world
   *  zone is present-but-not-yet-available. Passes the buffered `clientTimeMs`
   *  so the server stamps the new zone's `valid_at` on the client's timeline
   *  (via `effective_now_ms`) — otherwise a server-now stamp lands
   *  ~`clientDelay` in the client's buffered future and the zone takes seconds
   *  to surface through `ValidAtTable.promote`. */
  async requestZone(macroZone: bigint): Promise<void> {
    const clientTimeMs = BigInt(Math.round(this.serverNowMs()));
    debug.log(
      ["spacetime"],
      `[spacetime] requestZone macroZone=${macroZone} clientTimeMs=${clientTimeMs}`,
      2,
    );
    const start = performance.now();
    try {
      await this.gateCall("request_zone", { macroZone, clientTimeMs });
    } catch (err) {
      this.correctFromDrift(err, Number(clientTimeMs), start);
      throw err;
    } finally {
      this.recordRtt(performance.now() - start);
    }
  }

  /** Ask the server to declare a `Region` governing `macroZone` (idempotent,
   *  surface-keyed presence). Driven by `ZoneManager`'s region gate when a
   *  gated zone is wanted but no region governs it yet — e.g. a soul's
   *  inventory region, which `spawn_soul` no longer seeds cross-DB. The region
   *  row arriving lets the gate then fire `requestZone`. */
  async ensureRegion(macroZone: bigint): Promise<void> {
    const clientTimeMs = BigInt(Math.round(this.serverNowMs()));
    debug.log(
      ["spacetime"],
      `[spacetime] ensureRegion macroZone=${macroZone} clientTimeMs=${clientTimeMs}`,
      2,
    );
    const start = performance.now();
    try {
      await this.gateCall("ensure_region", { macroZone, clientTimeMs });
    } catch (err) {
      this.correctFromDrift(err, Number(clientTimeMs), start);
      throw err;
    } finally {
      this.recordRtt(performance.now() - start);
    }
  }


  /** Relayed through the gate to the chat module. The chat module has no
   *  players table, so the caller supplies `senderPlayerId` / `senderName`
   *  explicitly (resolved from `PlayerManager.getPlayer()`); `gateCall`
   *  snake-cases them for the `/call`. (RTT isn't bookended here — chat isn't on
   *  the shard-RTT critical path that drives the time-discipline math.) */
  async sendChatMessage(args: {
    senderPlayerId: number;
    senderName: string;
    body: string;
  }): Promise<void> {
    debug.log(
      ["spacetime", "chat"],
      `[spacetime] sendChatMessage len=${args.body.length}`,
      0,
    );
    await this.gateCall("send_chat_message", args);
  }
}
