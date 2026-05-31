import { debug } from "../../../debug";
import type { ReducerManager } from "../../../server/spacetime/ReducerManager";
import { DomPanel } from "../../../ui/dom/DomPanel";
import type { PanelTaskbar } from "../../../ui/dom/PanelTaskbar";
import type { UiEditMode } from "../../../ui/dom/UiEditMode";
import { panelTitle, panelText } from "../panelStrings";

/** Frames between history samples. At ~60fps that's roughly 2Hz —
 *  combined with `ReducerManager.HISTORY_LIMIT = 600`, the sparkline
 *  window spans ~5 minutes. Tune here if you want a different visual
 *  trail length (smaller = denser/shorter, larger = sparser/longer). */
const HISTORY_SAMPLE_INTERVAL_FRAMES = 30;

/** Exponential-lerp factor for FPS smoothing. Same shape as the one
 *  previously lived in the (now-removed) title bar — each tick blends
 *  the instant fps into the running average by this fraction so the
 *  readout doesn't jitter on every frame-time hiccup. */
const FPS_SMOOTHING = 0.05;

/** Format a unix-ms timestamp as `mm:ss.sss` within the current hour.
 *  Drops the high-order date/hour digits that would overflow the
 *  panel's column width and aren't useful for visual comparison
 *  between server time and `Date.now()`. */
function formatHourClock(ms: number): string {
  const intoHour = ((ms % 3_600_000) + 3_600_000) % 3_600_000;
  const minutes = Math.floor(intoHour / 60_000);
  const seconds = Math.floor((intoHour % 60_000) / 1_000);
  const millis = Math.floor(intoHour % 1_000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** Format a ms delta with an explicit sign for direction-at-a-glance.
 *  Rounded to integer ms — sub-ms precision isn't meaningful at this
 *  level of timing. */
function formatSignedMs(ms: number): string {
  const rounded = Math.round(ms);
  return rounded >= 0 ? `+${rounded} ms` : `${rounded} ms`;
}

const ROW_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "6px 12px",
  borderBottom: "1px solid #23252e",
};

const LABEL_CSS: Partial<CSSStyleDeclaration> = {
  color: "#a0a0b0",
};

const VALUE_CSS: Partial<CSSStyleDeclaration> = {
  color: "#ecd6aa",
};

/** Glyph button for a toggle row — transparent so only the ▣ / ▢
 *  reads, matching the value-column colour. Mirrors the toggle look
 *  of `PanelSettingsPopup`. */
const TOGGLE_BTN_CSS: Partial<CSSStyleDeclaration> = {
  background: "none",
  border: "none",
  color: "#ecd6aa",
  cursor: "pointer",
  font: "inherit",
  padding: "0",
};

/** Right-side cluster wrapping a sparkline canvas + the live value
 *  span. Lives inside a graph row so the label can still be flushed
 *  left by the row's outer `space-between`. */
const GRAPH_RIGHT_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

/** Sparkline canvas pixel dimensions in CSS pixels. The backing
 *  bitmap is scaled by `devicePixelRatio` so lines stay crisp on
 *  hi-DPI displays. Width is wide enough to show ~120 samples at
 *  reasonable density; height matches the row's text x-height so
 *  the graph sits visually on the same baseline as adjacent rows. */
const SPARKLINE_W = 80;
const SPARKLINE_H = 16;

/** Draw `samples` as a sparkline into `canvas`. Auto-scales the
 *  Y axis to the range of finite values in the window (so a graph
 *  always fills its vertical space regardless of the metric's
 *  natural magnitude), and treats `NaN` as a pen-up — multiple
 *  series sampled together that have "no data yet" ticks stay
 *  index-aligned without drawing through the gap. Clears the
 *  canvas on each call; cheap enough to do per-frame at the panel's
 *  update rate. */
function drawSparkline(canvas: HTMLCanvasElement, samples: readonly number[]): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  if (samples.length === 0) return;
  let min = Infinity;
  let max = -Infinity;
  for (const v of samples) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const n = samples.length;
  ctx.strokeStyle = "#ecd6aa";
  ctx.lineWidth = 1;
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) { pen = false; continue; }
    const x = n === 1 ? w / 2 : (i / (n - 1)) * (w - 1) + 0.5;
    const y = h - 1 - ((v - min) / range) * (h - 2) + 0.5;
    if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
  }
  ctx.stroke();
}

/** Like `drawSparkline` but plots each sample as an isolated dot
 *  rather than connecting them with a polyline. Right for series
 *  where the sample-to-sample sequence isn't a smooth curve — e.g.
 *  per-capture delivery offsets, where each point is an independent
 *  measurement and the visual question is "where are the outliers,"
 *  not "what's the trend." Auto-scales Y to the data range so any
 *  spread is visible regardless of the metric's absolute magnitude. */
function drawScatter(canvas: HTMLCanvasElement, samples: readonly number[]): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  if (samples.length === 0) return;
  let min = Infinity;
  let max = -Infinity;
  for (const v of samples) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const n = samples.length;
  ctx.fillStyle = "#ecd6aa";
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) continue;
    const x = n === 1 ? w / 2 : (i / (n - 1)) * (w - 1);
    const y = h - 1 - ((v - min) / range) * (h - 2);
    ctx.fillRect(x, y, 1, 1);
  }
}

/** Snapshot of the client-server time-sync state. Sourced from
 *  `ReducerManager.syncStats()`. All ms unless otherwise noted. */
export interface SyncStats {
  /** Current `serverNowMs()` estimate (buffered). */
  serverNowMs: number;
  /** Client's `Date.now()`. */
  dateNowMs: number;
  /** `serverNowMs − dateNowMs`. Negative = client leads; positive = client trails. */
  offsetMs: number;
  /** Window length. */
  captures: number;
  /** Anchor capture's raw offset, or null before any capture lands. */
  bestOffsetMs: number | null;
  /** Worst capture's raw offset (slowest-delivered sample in the
   *  window). Symmetric to `bestOffsetMs`. Null before any capture. */
  worstOffsetMs: number | null;
  /** Prediction error from the most recent capture: how far our
   *  extrapolation missed the freshly-arrived server stamp. Held
   *  between captures. Null before the second capture or after a
   *  drift-correction window clear. */
  deltaMs: number | null;
  /** Constant subtracted from `serverNowMs()`. */
  clientLagMs: number;
  /** Most recent ping RTT, or null if no ping has succeeded yet. */
  rttMs: number | null;
  /** Min RTT across the sample window — closest to true uncontended round-trip. */
  bestRttMs: number | null;
  /** Number of RTT samples currently in the window. */
  rttSamples: number;
  /** Cumulative offset correction (running_delta). Smooths anchor-swap
   *  jumps. Sits near zero in steady state. */
  runningDeltaMs: number;
  /** EWMA of recent extreme-spike magnitudes (running_delay). Drives
   *  `clientLagMs = 2 * this`, clamped. */
  runningDelayMs: number;
}

/**
 * Read-only stats HUD. Three tabs:
 *   ⓘ main — at-a-glance: clocks, offset, fps, draw calls
 *   🖌 textures — atlas occupancy + slot counts per size
 *   🛰 sync — full time-sync state (offsets, captures, RTT)
 *
 * All chrome (title bar, drag, resize, tabs, minimize, close,
 * persistence) lives in `DomPanel`. This class just builds the row
 * structure for each tab and updates value spans on every
 * `setStats` call. Updates are gated on `panel.isOpen` so a closed
 * panel doesn't churn DOM.
 */
export class DebugPanel {
  private readonly panel: DomPanel;

  // ── Main tab values ─────────────────────────────────────────────
  private readonly mainServerNow:  HTMLSpanElement;
  private readonly mainOffset:     HTMLSpanElement;
  private readonly mainFps:        HTMLSpanElement;
  private readonly mainDrawCalls:  HTMLSpanElement;

  // ── Textures tab values ─────────────────────────────────────────
  private readonly texFps:         HTMLSpanElement;
  private readonly texDrawCalls:   HTMLSpanElement;
  private readonly texAtlases:     HTMLSpanElement;
  private readonly texS256:        HTMLSpanElement;
  private readonly texS128:        HTMLSpanElement;
  private readonly texS64:         HTMLSpanElement;

  // ── Sync tab values ─────────────────────────────────────────────
  // Plain rows for values not worth graphing: clocks (visual is
  // already temporal).
  private readonly syncDateNow:    HTMLSpanElement;
  private readonly syncServerNow:  HTMLSpanElement;
  // Graph rows pair a sparkline canvas with the live readout. Series
  // names match `ReducerManager.sampleSyncHistory()` keys so the
  // panel reads each canvas's data via `reducers.getHistory(name)`.
  private readonly syncClientLag:     { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncRunningDelta:  { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncRunningDelay:  { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncDelta:         { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncOffset:        { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncBestOffset:    { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncWorstOffset:   { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncCaptures:      { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncCaptureOffset: { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncRtt:           { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncBestRtt:       { value: HTMLSpanElement; canvas: HTMLCanvasElement };

  private fps = 60;

  /** Optional handle to the live `ReducerManager`. When set, `setStats`
   *  drives `sampleSyncHistory()` on a fixed-frame cadence so the
   *  sparklines have continuous history regardless of whether the
   *  panel is open. Sampling runs even when the panel is hidden, so
   *  the trail you see right after opening reflects activity that
   *  happened before you opened it. */
  private reducers?: ReducerManager;
  private historyTick = 0;

  constructor(
    taskbar?: PanelTaskbar,
    uiEditMode?: UiEditMode,
    reducers?: ReducerManager,
  ) {
    this.reducers = reducers;
    this.panel = new DomPanel({
      title: panelTitle("debugPanel"),
      storageKey: "debugPanel",
      defaultRect: { right: "36px", top: "32px", width: "260px" },
      taskbar,
      pinned: true,
      taskbarIcon: "📊",
      taskbarSide: "right",
      uiEditMode,
    });

    const mainContent     = document.createElement("div");
    const texturesContent = document.createElement("div");
    const syncContent     = document.createElement("div");

    // ── Main tab — at-a-glance ────────────────────────────────────
    // Global on-screen-debug toggle. Flips `debug.showInfo`, which
    // feature code reads to decide whether to render debug overlays.
    this.addToggleRow(
      mainContent,
      panelText("debugPanel", "debugInfo"),
      () => debug.showInfo,
      () => debug.toggleInfo(),
    );
    this.mainServerNow = this.addRow(mainContent, panelText("debugPanel", "serverNow"));
    this.mainOffset    = this.addRow(mainContent, panelText("debugPanel", "offset"));
    this.mainFps       = this.addRow(mainContent, panelText("debugPanel", "fps"));
    this.mainDrawCalls = this.addRow(mainContent, panelText("debugPanel", "drawCalls"));

    // ── Textures tab — atlas / slot counts ────────────────────────
    this.texFps       = this.addRow(texturesContent, panelText("debugPanel", "fps"));
    this.texDrawCalls = this.addRow(texturesContent, panelText("debugPanel", "drawCalls"));
    this.texAtlases   = this.addRow(texturesContent, panelText("debugPanel", "atlases"));
    this.texS256      = this.addRow(texturesContent, panelText("debugPanel", "size256"));
    this.texS128      = this.addRow(texturesContent, panelText("debugPanel", "size128"));
    this.texS64       = this.addRow(texturesContent, panelText("debugPanel", "size64"));

    // ── Sync tab — full time-sync state ───────────────────────────
    // Clocks render `mm:ss.sss` within the current hour (plain rows;
    // the temporal axis is already visible in the value). Offsets,
    // captures count, and RTT get sparklines so trends across the
    // ~5-minute history window are visible at a glance.
    this.syncDateNow       = this.addRow(syncContent, panelText("debugPanel", "dateNow"));
    this.syncServerNow     = this.addRow(syncContent, panelText("debugPanel", "serverNow"));
    this.syncClientLag     = this.addGraphRow(syncContent, panelText("debugPanel", "clientDelay"));
    this.syncRunningDelay  = this.addGraphRow(syncContent, panelText("debugPanel", "runningDelay"));
    this.syncRunningDelta  = this.addGraphRow(syncContent, panelText("debugPanel", "runningDelta"));
    this.syncDelta         = this.addGraphRow(syncContent, panelText("debugPanel", "delta"));
    this.syncOffset        = this.addGraphRow(syncContent, panelText("debugPanel", "offset"));
    this.syncBestOffset    = this.addGraphRow(syncContent, panelText("debugPanel", "bestCapture"));
    this.syncWorstOffset   = this.addGraphRow(syncContent, panelText("debugPanel", "worstCapture"));
    this.syncCaptures      = this.addGraphRow(syncContent, panelText("debugPanel", "captures"));
    this.syncCaptureOffset = this.addGraphRow(syncContent, panelText("debugPanel", "captureSpread"));
    this.syncRtt           = this.addGraphRow(syncContent, panelText("debugPanel", "rtt"));
    this.syncBestRtt       = this.addGraphRow(syncContent, panelText("debugPanel", "rttBest"));

    this.panel.addTab("main",     "🛈", mainContent);
    this.panel.addTab("textures", "🖌", texturesContent);
    this.panel.addTab("sync",     "🛰", syncContent);
  }

  get isOpen(): boolean { return this.panel.isOpen; }

  toggle(): void { this.panel.toggle(); }
  open():   void { this.panel.open();   }
  close():  void { this.panel.close();  }
  destroy(): void { this.panel.destroy(); }

  /** Late-bind the `ReducerManager` after panel construction. The
   *  panel is built early in `main.ts` (before `ReducerManager` is
   *  instantiated) so the taskbar icon shows up immediately; once the
   *  manager exists, the caller wires it through here to enable
   *  history sampling and sparkline rendering. */
  setReducers(reducers: ReducerManager): void {
    this.reducers = reducers;
  }

  setStats(
    deltaMS: number,
    drawCalls: number,
    atlasStats?: { atlases: number; slotCounts: ReadonlyMap<number, number> },
    syncStats?: SyncStats,
  ): void {
    if (deltaMS > 0) {
      const instant = 1000 / deltaMS;
      this.fps = this.fps * (1 - FPS_SMOOTHING) + instant * FPS_SMOOTHING;
    }
    // History sampling runs unconditionally so the sparkline trail
    // reflects activity that happened before the panel was opened —
    // ReducerManager owns the bounded buffer, we just tick the clock.
    if (this.reducers && ++this.historyTick >= HISTORY_SAMPLE_INTERVAL_FRAMES) {
      this.historyTick = 0;
      this.reducers.sampleSyncHistory();
    }
    // The instant-fps calculation runs unconditionally so the running
    // average stays current; the DOM updates skip when closed so we
    // don't churn the panel's spans for nothing.
    if (!this.panel.isOpen) return;

    const fpsText = String(Math.round(this.fps));
    const dcText  = String(drawCalls);
    this.mainFps.textContent       = fpsText;
    this.mainDrawCalls.textContent = dcText;
    this.texFps.textContent        = fpsText;
    this.texDrawCalls.textContent  = dcText;

    if (atlasStats) {
      this.texAtlases.textContent = String(atlasStats.atlases);
      this.texS256.textContent    = String(atlasStats.slotCounts.get(256) ?? 0);
      this.texS128.textContent    = String(atlasStats.slotCounts.get(128) ?? 0);
      this.texS64.textContent     = String(atlasStats.slotCounts.get(64)  ?? 0);
    }
    if (syncStats) {
      const dateNowText   = formatHourClock(syncStats.dateNowMs);
      const serverNowText = formatHourClock(syncStats.serverNowMs);
      const offsetText    = formatSignedMs(syncStats.offsetMs);
      this.mainServerNow.textContent   = serverNowText;
      this.mainOffset.textContent      = offsetText;
      this.syncDateNow.textContent     = dateNowText;
      this.syncServerNow.textContent   = serverNowText;
      this.syncOffset.value.textContent = offsetText;
      this.syncBestOffset.value.textContent =
        syncStats.bestOffsetMs === null
          ? "—"
          : formatSignedMs(syncStats.bestOffsetMs);
      this.syncWorstOffset.value.textContent =
        syncStats.worstOffsetMs === null
          ? "—"
          : formatSignedMs(syncStats.worstOffsetMs);
      this.syncDelta.value.textContent =
        syncStats.deltaMs === null
          ? "—"
          : formatSignedMs(syncStats.deltaMs);
      this.syncCaptures.value.textContent = String(syncStats.captures);
      this.syncClientLag.value.textContent     = `${Math.round(syncStats.clientLagMs)} ms`;
      this.syncRunningDelay.value.textContent  = `${Math.round(syncStats.runningDelayMs)} ms`;
      this.syncRunningDelta.value.textContent  = formatSignedMs(syncStats.runningDeltaMs);
      this.syncRtt.value.textContent =
        syncStats.rttMs === null ? "—" : `${Math.round(syncStats.rttMs)} ms`;
      this.syncBestRtt.value.textContent =
        syncStats.bestRttMs === null
          ? "—"
          : `${Math.round(syncStats.bestRttMs)} ms (n=${syncStats.rttSamples})`;

      // Sparklines redraw each frame the panel's open. Cheap (5 small
      // canvases, ~120 samples each) and keeps the trail visually live
      // even between history samples (the underlying buffer only
      // advances every `HISTORY_SAMPLE_INTERVAL_FRAMES` ticks).
      if (this.reducers) {
        drawSparkline(this.syncClientLag.canvas,    this.reducers.getHistory("clientDelayMs"));
        drawSparkline(this.syncRunningDelay.canvas, this.reducers.getHistory("runningDelayMs"));
        drawSparkline(this.syncRunningDelta.canvas, this.reducers.getHistory("runningDeltaMs"));
        drawSparkline(this.syncDelta.canvas,        this.reducers.getHistory("deltaMs"));
        drawSparkline(this.syncOffset.canvas,       this.reducers.getHistory("offsetMs"));
        drawSparkline(this.syncBestOffset.canvas,   this.reducers.getHistory("bestOffsetMs"));
        drawSparkline(this.syncWorstOffset.canvas,  this.reducers.getHistory("worstOffsetMs"));
        drawSparkline(this.syncCaptures.canvas,     this.reducers.getHistory("captures"));
        drawSparkline(this.syncRtt.canvas,          this.reducers.getHistory("rttMs"));
        drawSparkline(this.syncBestRtt.canvas,      this.reducers.getHistory("bestRttMs"));
        // Capture-offset is event-driven (one entry per `noteServerTime`
        // call, not the 2Hz time-driven cadence other series use), so
        // it gets the scatter renderer — dots show individual captures,
        // outliers (freebies low or slow captures high) stick out
        // visually. The readout shows the window's spread = max−min,
        // a one-number summary of how spiky the dataset is.
        const capOffsetHist = this.reducers.getHistory("captureOffsetMs");
        drawScatter(this.syncCaptureOffset.canvas, capOffsetHist);
        let capMin = Infinity;
        let capMax = -Infinity;
        for (const v of capOffsetHist) {
          if (!Number.isFinite(v)) continue;
          if (v < capMin) capMin = v;
          if (v > capMax) capMax = v;
        }
        this.syncCaptureOffset.value.textContent =
          Number.isFinite(capMin) && Number.isFinite(capMax)
            ? `${Math.round(capMax - capMin)} ms`
            : "—";
      }
    }
  }

  /** Build a toggle row: a label plus a ▣ / ▢ glyph button reflecting
   *  `getState()`. Clicking runs `onToggle()` then re-reads the state
   *  so the glyph stays accurate. Same row chrome as `addRow`. */
  private addToggleRow(
    parent: HTMLDivElement,
    label: string,
    getState: () => boolean,
    onToggle: () => void,
  ): void {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = label;
    const btn = document.createElement("button");
    Object.assign(btn.style, TOGGLE_BTN_CSS);
    const sync = (): void => { btn.textContent = getState() ? "▣" : "▢"; };
    sync();
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onToggle();
      sync();
    });
    row.appendChild(labelEl);
    row.appendChild(btn);
    parent.appendChild(row);
  }

  private addRow(parent: HTMLDivElement, label: string): HTMLSpanElement {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    Object.assign(valueEl.style, VALUE_CSS);
    valueEl.textContent = "--";
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    parent.appendChild(row);
    return valueEl;
  }

  /** Row variant that adds a sparkline canvas between the label and
   *  the value text. Backing bitmap sized to `devicePixelRatio` so
   *  lines stay crisp on hi-DPI; CSS size stays at the constants so
   *  layout is stable. Returned tuple lets the caller drive both the
   *  graph (via `drawSparkline(canvas, samples)`) and the live
   *  readout (via `value.textContent = ...`). */
  private addGraphRow(parent: HTMLDivElement, label: string): {
    value: HTMLSpanElement;
    canvas: HTMLCanvasElement;
  } {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = label;
    const right = document.createElement("div");
    Object.assign(right.style, GRAPH_RIGHT_CSS);
    const canvas = document.createElement("canvas");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SPARKLINE_W * dpr;
    canvas.height = SPARKLINE_H * dpr;
    canvas.style.width = `${SPARKLINE_W}px`;
    canvas.style.height = `${SPARKLINE_H}px`;
    const ctx2d = canvas.getContext("2d");
    if (ctx2d) ctx2d.scale(dpr, dpr);
    const valueEl = document.createElement("span");
    Object.assign(valueEl.style, VALUE_CSS);
    valueEl.textContent = "--";
    // Value first, canvas second — canvas is the rightmost child, so
    // every graph row's canvas sits flush at the row's right padding
    // edge. Because all canvases share a fixed CSS width, they all
    // align at identical x-coordinates across rows. (Values are then
    // variable-width and float left of their canvas, so values don't
    // align with each other across rows — accepted trade.)
    right.appendChild(valueEl);
    right.appendChild(canvas);
    row.appendChild(labelEl);
    row.appendChild(right);
    parent.appendChild(row);
    return { value: valueEl, canvas };
  }
}
