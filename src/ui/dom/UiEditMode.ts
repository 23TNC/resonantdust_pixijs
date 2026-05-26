/**
 * App-wide "UI edit mode" flag. While enabled, every `DomPanel`
 * surfaces an extra row of action buttons (grid-snap, lock, hide
 * title bar) and forces its title bar visible regardless of the
 * panel's own preference. Toggled from the settings menu.
 *
 * State isn't persisted across sessions on purpose — edit mode is
 * a setup phase, not a runtime mode. Each session starts with it
 * off; the user re-enters when they want to rearrange panels.
 *
 * Listener pattern mirrors the rest of the panel system: every
 * subscriber gets a `(enabled) => void` callback on each change,
 * plus a synchronous one-shot fire on subscribe so callers don't
 * have to read `enabled` separately to set initial state.
 *
 * The mode also owns the grid geometry. `gridSize` is the target
 * cell side in pixels; `reservedTop` / `reservedBottom` are the
 * strips the grid avoids (typically the taskbar heights). On every
 * `getGrid()` call we read the live viewport and recompute the
 * exact cell width / height so the cells **exactly tile** the
 * area between the reserved strips — no half-cells that would
 * leave panels partially overlapping a taskbar.
 */
export interface UiEditModeOptions {
  /** Target cell side in pixels. Actual cell size is derived from
   *  this — the available area is divided into the nearest whole
   *  number of cells, so cells end up slightly larger or smaller
   *  than the target to fit exactly. Defaults to 32 (matching the
   *  taskbar height for a consistent visual rhythm). */
  gridSize?: number;
  /** Pixel strip at the top of the viewport the grid should
   *  avoid. Set to the top taskbar's height. */
  reservedTop?: number;
  /** Pixel strip at the bottom of the viewport the grid should
   *  avoid. Set to the bottom taskbar's height. */
  reservedBottom?: number;
}

export interface SnapGrid {
  /** Horizontal cell size in viewport pixels. */
  stepX: number;
  /** Vertical cell size in viewport pixels. */
  stepY: number;
  /** Grid origin X — always 0 today (no left/right reserves), but
   *  carried through the API so a future side-anchored bar could
   *  inset the grid without breaking callers. */
  originX: number;
  /** Grid origin Y — the bottom edge of the top reserved strip.
   *  Snapped panel `top` values are always `>=` this. */
  originY: number;
}

/** Forward-declared shape so `UiEditMode` can hold a reference
 *  without importing the concrete class (avoids a circular import
 *  chain DomPanel → UiEditMode → PanelSettingsPopup → DomPanel).
 *  The real `PanelSettingsPopup` is installed from `main.ts`
 *  after construction; until then `openSettings` is a no-op. */
export interface PanelSettingsPopupLike {
  show(panel: import("./DomPanel").DomPanel): void;
  close(): void;
}

export class UiEditMode {
  /** Default target cell side. 32 px matches the taskbar height
   *  so panels grid-snap onto the same rhythm. */
  static readonly DEFAULT_GRID_SIZE = 32;

  private _enabled = false;
  private readonly listeners = new Set<(enabled: boolean) => void>();
  /** Target cell size. Caller-mutable so a future "Grid size:
   *  16/32/64" setting can adjust the whole app at once. */
  gridSize: number;
  /** Pixel strips the grid avoids on top / bottom. Caller-mutable
   *  so the taskbar heights can be re-applied if they ever change
   *  at runtime. */
  reservedTop: number;
  reservedBottom: number;
  /** Shared per-panel settings popup. Set from `main.ts` after
   *  construction (see the forward-declared `PanelSettingsPopupLike`
   *  type above for the reason). `null` until then — `openSettings`
   *  silently no-ops in that window. */
  settingsPopup: PanelSettingsPopupLike | null = null;

  get enabled(): boolean { return this._enabled; }

  constructor(opts?: UiEditModeOptions) {
    this.gridSize       = opts?.gridSize       ?? UiEditMode.DEFAULT_GRID_SIZE;
    this.reservedTop    = opts?.reservedTop    ?? 0;
    this.reservedBottom = opts?.reservedBottom ?? 0;
  }

  /** Open the shared settings popup bound to `panel`. Called by
   *  each `DomPanel`'s ⛯ button. No-op if the popup hasn't been
   *  attached yet. */
  openSettings(panel: import("./DomPanel").DomPanel): void {
    this.settingsPopup?.show(panel);
  }

  toggle(): void { this.setEnabled(!this._enabled); }

  setEnabled(enabled: boolean): void {
    if (this._enabled === enabled) return;
    this._enabled = enabled;
    for (const cb of this.listeners) cb(enabled);
  }

  /** Subscribe to changes. Listener fires immediately with the
   *  current state so subscribers can do their initial render in
   *  the same code path as updates. Returns an unsubscribe fn. */
  on(cb: (enabled: boolean) => void): () => void {
    this.listeners.add(cb);
    cb(this._enabled);
    return () => this.listeners.delete(cb);
  }

  /** Snapshot of the snap grid against the **current** viewport.
   *  Read each time a snap math step runs, so resizing the window
   *  immediately reshapes the grid without re-attaching anything.
   *  Cells exactly tile the area between the reserved strips —
   *  if `gridSize` doesn't divide cleanly into the available
   *  height, the cell height nudges up or down to the nearest
   *  whole-cell count. */
  getGrid(): SnapGrid {
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const availH = Math.max(0, viewH - this.reservedTop - this.reservedBottom);
    const target = Math.max(1, this.gridSize);
    // Round to the nearest whole-cell count so cells exactly fit
    // the available area. Floors at 1 so degenerate viewports
    // (zero / tiny height) still produce a usable grid.
    const cols = Math.max(1, Math.round(viewW  / target));
    const rows = Math.max(1, Math.round(availH / target));
    return {
      stepX:   viewW  / cols,
      stepY:   availH / rows,
      originX: 0,
      originY: this.reservedTop,
    };
  }
}
