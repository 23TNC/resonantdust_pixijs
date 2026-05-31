import { NOTO_EMOJI_FAMILY } from "../../assets/fonts";
import { panelTitle, panelText } from "../../game/panels/panelStrings";
import { CyclingSelect } from "./CyclingSelect";
import {
  DomPanel,
  type AnchorMode,
  type HeightMode,
  type PanelSettingKey,
  type PinMode,
  type SnapMode,
  type TitleSuffix,
} from "./DomPanel";

/** Panels-locale key for this popup (matches `content/panels/defaults.json`
 *  and `content/locales/panels/en.json`). */
const POPUP = "panelSettingsPopup";
/** Resolve one of this popup's strings from the panels locale. Short
 *  alias since every label / option below flows through it. */
const pp = (key: string): string => panelText(POPUP, key);

/**
 * Shared "Panel Settings" popup. One instance per app session,
 * bound to whichever panel currently has its ⛯ button clicked.
 * Surfaces the per-panel edit-mode controls (title bar, grid snap,
 * anchor, layer up / down) as a vertical list of labeled rows —
 * decluttering each panel's title bar and giving each control a
 * readable name instead of a tooltip-only glyph.
 *
 * Lifecycle:
 *   - Built once, hidden until `show(panel)` opens it bound to a
 *     specific panel.
 *   - Subsequent `show(panel)` calls re-bind to the new target.
 *   - `close()` unbinds + hides.
 *   - Auto-closes when UI edit mode flips off (wired from
 *     `main.ts` after construction).
 *
 * Doesn't participate in the taskbar, doesn't take a `uiEditMode`
 * reference (it's the surface that *configures* edit-mode panels,
 * so giving it its own edit-mode chrome would be circular).
 */

const ROW_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "6px 12px",
  borderBottom: "1px solid #23252e",
  gap: "8px",
};

const LABEL_CSS: Partial<CSSStyleDeclaration> = {
  color: "#a0a0b0",
  fontFamily: "sans-serif",
  fontSize: "13px",
  flex: "0 0 auto",
};

const BUTTON_GROUP_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  alignItems: "center",
  gap: "4px",
  flex: "0 0 auto",
};

const BUTTON_CSS: Partial<CSSStyleDeclaration> = {
  background: "none",
  border: "1px solid #3a3a4a",
  borderRadius: "3px",
  color: "#ecd6aa",
  cursor: "pointer",
  fontFamily: NOTO_EMOJI_FAMILY,
  fontSize: "14px",
  padding: "2px 8px",
  lineHeight: "1",
  minWidth: "32px",
};

/** Glyph colour for a toggle whose value is currently forced by
 *  another setting (e.g. Draggable while a non-none Snap is set,
 *  Resize Vertical while a non-"off" Height lock is set). The
 *  popup also no-ops clicks on these rows — the user has to
 *  release the forcing setting to regain control. */
const FORCED_BUTTON_COLOR = "#5a5a6a";
/** Default glyph colour — same as the rest of `BUTTON_CSS`.
 *  Pulled out as a constant so `refreshControls` has a single
 *  source of truth to reset to when a previously-forced toggle
 *  becomes free. */
const NORMAL_BUTTON_COLOR = "#ecd6aa";

/** Right-aligned wrapper for one-button rows. Keeps the toggle
 *  flush with the row's right edge while the label sits left. */
const CONTROL_WRAP_CSS: Partial<CSSStyleDeclaration> = {
  flex: "0 0 auto",
  display: "flex",
};

/** Wrapper for the anchor cycler. Right-justified — sized to the
 *  cycler's natural width (label + arrows) so the row reads as
 *  "Anchor [cycler]" with the cycler hugging the right edge,
 *  matching the other toggle rows. */
const CYCLER_WRAP_CSS: Partial<CSSStyleDeclaration> = {
  flex: "0 0 auto",
  display: "flex",
};

// Option lists carry a locale `labelKey` rather than a baked label —
// these consts evaluate at module load, before the wasm locale
// registry is initialised, so the display string is resolved lazily
// in `localizeOptions` at row-construction time (inside the
// constructor, post-init). `value` stays the typed mode enum.
const ANCHOR_OPTIONS: readonly { value: AnchorMode; labelKey: string }[] = [
  { value: "top-left",     labelKey: "topLeft" },
  { value: "top-right",    labelKey: "topRight" },
  { value: "bottom-left",  labelKey: "bottomLeft" },
  { value: "bottom-right", labelKey: "bottomRight" },
];

const SNAP_OPTIONS: readonly { value: SnapMode; labelKey: string }[] = [
  { value: "none",         labelKey: "none" },
  { value: "top-left",     labelKey: "topLeft" },
  { value: "top-right",    labelKey: "topRight" },
  { value: "bottom-left",  labelKey: "bottomLeft" },
  { value: "bottom-right", labelKey: "bottomRight" },
];

const HEIGHT_OPTIONS: readonly { value: HeightMode; labelKey: string }[] = [
  { value: "off",     labelKey: "off" },
  { value: "auto",    labelKey: "auto" },
  { value: "full",    labelKey: "full" },
  { value: "half",    labelKey: "half" },
  { value: "quarter", labelKey: "quarter" },
];

/** Locale key for every possible suffix mode. The popup row filters
 *  this down to the subset the bound panel actually supports (via
 *  `availableTitleSuffixes`). Resolved through `pp` at bind time. */
const TITLE_SUFFIX_KEYS: Record<TitleSuffix, string> = {
  none:   "none",
  player: "player",
  soul:   "soul",
};

const PIN_OPTIONS: readonly { value: PinMode; labelKey: string }[] = [
  { value: "none",          labelKey: "none" },
  { value: "bottom-left",   labelKey: "bottomLeft" },
  { value: "bottom-center", labelKey: "bottomCenter" },
  { value: "bottom-right",  labelKey: "bottomRight" },
  { value: "top-left",      labelKey: "topLeft" },
  { value: "top-center",    labelKey: "topCenter" },
  { value: "top-right",     labelKey: "topRight" },
];

/** Map a `labelKey`-carrying option list into the `{value, label}`
 *  shape `CyclingSelect` consumes, resolving each label from the
 *  panels locale. Call at row-construction time (post wasm-init). */
function localizeOptions<T extends string>(
  opts: readonly { value: T; labelKey: string }[],
): { value: T; label: string }[] {
  return opts.map(o => ({ value: o.value, label: pp(o.labelKey) }));
}

export class PanelSettingsPopup {
  private readonly panel: DomPanel;
  private readonly titleBarBtn:    HTMLButtonElement;
  private readonly gridSnapBtn:    HTMLButtonElement;
  private readonly anchorSelect:   CyclingSelect<AnchorMode>;
  private readonly draggableBtn:   HTMLButtonElement;
  private readonly snapSelect:     CyclingSelect<SnapMode>;
  private readonly heightSelect:   CyclingSelect<HeightMode>;
  private readonly pinSelect:      CyclingSelect<PinMode>;
  private readonly taskbarIconInput: HTMLInputElement;
  /** Title suffix cycler — rebuilt on every `bind` because the
   *  available option set is per-panel (a panel without resolvers
   *  has only "None" and the row hides). Stored so `refreshControls`
   *  can keep its selection in sync with the panel state. */
  private titleSuffixSelect: CyclingSelect<TitleSuffix> | null = null;
  private readonly titleSuffixRow: HTMLDivElement;
  /** Wrapper inside `titleSuffixRow` where the per-bind cycler is
   *  mounted. Replacing the cycler clears + appends here without
   *  disturbing the row's label / layout. */
  private readonly titleSuffixWrap: HTMLDivElement;
  private readonly minimizableBtn: HTMLButtonElement;
  private readonly resizableXBtn:  HTMLButtonElement;
  private readonly resizableYBtn:  HTMLButtonElement;
  private readonly closableBtn:    HTMLButtonElement;
  private readonly hideMinimizeBtnBtn: HTMLButtonElement;
  private readonly hideCloseBtnBtn:    HTMLButtonElement;
  private readonly maskBtn:        HTMLButtonElement;
  private readonly layerUpBtn:     HTMLButtonElement;
  private readonly layerDownBtn:   HTMLButtonElement;
  /** Row-element index keyed by `PanelSettingKey`. `refreshControls`
   *  iterates this to hide / show each row based on the bound
   *  panel's `excludeSettings`. Every row goes in here at
   *  construction; the popup itself doesn't pick which rows to
   *  render — the per-panel blacklist does. */
  private readonly rowsByKey = new Map<PanelSettingKey, HTMLDivElement>();

  private boundPanel: DomPanel | null = null;
  /** Cleanup for the bound panel's `onAnchorChange` subscription,
   *  released on each `unbind`. Anchor is the one state today that
   *  can mutate from outside the popup (taskbar gates off it, and
   *  a future hotkey might too); other states only change via
   *  this popup's controls so a post-click `refreshButtons` is
   *  enough. */
  private unsubAnchor: (() => void) | null = null;
  /** Cleanup for the bound panel's `onHeightModeChange`
   *  subscription, released on each `unbind`. Reset can mutate
   *  height mode from outside the popup's own row, so we listen
   *  so the cycler stays in sync. */
  private unsubHeight: (() => void) | null = null;
  /** Cleanup for the bound panel's `onPinChange` subscription.
   *  Pin can mutate from outside the popup via `resetToDefaults`
   *  (and a future hotkey), so we listen so the cycler stays in
   *  sync. */
  private unsubPin: (() => void) | null = null;
  /** Cleanup for the bound panel's `onSnapChange` subscription.
   *  Snap mutates the Draggable toggle as a side effect (any
   *  non-none snap forces draggable off), so a snap change must
   *  re-render both controls. */
  private unsubSnap: (() => void) | null = null;
  /** Cleanup for the bound panel's `onDraggableChange`
   *  subscription. Reset can mutate draggable from outside the
   *  popup, and `toggleDraggable` while snapped clears snap as
   *  a side effect — both paths need the cycler / toggle to
   *  re-sync. */
  private unsubDraggable: (() => void) | null = null;
  /** Cleanup for the bound panel's `onTaskbarIconChange`
   *  subscription. `resetToDefaults` reverts the icon from
   *  outside the popup; without this listener the text input
   *  would keep showing the stale glyph until the next bind. */
  private unsubTaskbarIcon: (() => void) | null = null;
  /** Cleanup for the bound panel's `onTitleChange` subscription
   *  (live title updates flow into the popup heading) and the
   *  `onTitleSuffixChange` subscription (cycler re-syncs when
   *  reset / external mutation flips the mode). */
  private unsubTitle: (() => void) | null = null;
  private unsubTitleSuffix: (() => void) | null = null;
  /** Cleanup for the bound panel's `onMaskedChange` subscription.
   *  Mask can mutate from outside the popup via `resetToDefaults`,
   *  so the toggle re-syncs on every change. */
  private unsubMasked: (() => void) | null = null;

  constructor() {
    this.panel = new DomPanel({
      title: panelTitle(POPUP),
      storageKey: "panelSettingsPopup",
      defaultRect: { right: "12px", top: "44px", width: "260px" },
      resizable: false,
      minimizable: false,
      // No `uiEditMode`, no `taskbar` — this popup is itself an
      // edit-mode utility, so it doesn't deserve its own edit-
      // mode chrome or a pinned taskbar entry.
    });

    const body = document.createElement("div");
    const titleRow  = this.addToggleRow(body, pp("titleBar"), "▣", () => this.boundPanel?.toggleTitleBarHidden());
    this.titleBarBtn = titleRow.btn;
    this.rowsByKey.set("titleBar", titleRow.row);
    const gridRow   = this.addToggleRow(body, pp("gridSnap"), "▣", () => this.boundPanel?.toggleGridSnap());
    this.gridSnapBtn = gridRow.btn;
    this.rowsByKey.set("gridSnap", gridRow.row);
    const anchorRow = this.addAnchorRow(body);
    this.anchorSelect = anchorRow.select;
    this.rowsByKey.set("anchor", anchorRow.row);
    const draggableRow = this.addToggleRow(body, pp("draggable"), "▣", () => {
      const p = this.boundPanel;
      // Snap-forces-drag-off — no-op the click so the user
      // doesn't get a confusing "I pressed it but nothing
      // changed" without realising why. The grey glyph in
      // `refreshControls` is the visual cue for "locked".
      if (!p || p.snap !== "none") return;
      p.toggleDraggable();
    });
    this.draggableBtn = draggableRow.btn;
    this.rowsByKey.set("draggable", draggableRow.row);
    const snapRow = this.addSnapRow(body);
    this.snapSelect = snapRow.select;
    this.rowsByKey.set("snap", snapRow.row);
    const heightRow = this.addHeightRow(body);
    this.heightSelect = heightRow.select;
    this.rowsByKey.set("height", heightRow.row);
    const pinRow = this.addPinRow(body);
    this.pinSelect = pinRow.select;
    this.rowsByKey.set("pin", pinRow.row);
    const iconRow = this.addTaskbarIconRow(body);
    this.taskbarIconInput = iconRow.input;
    this.rowsByKey.set("taskbarIcon", iconRow.row);
    const titleSuffixRow = this.addTitleSuffixRow(body);
    this.titleSuffixRow  = titleSuffixRow.row;
    this.titleSuffixWrap = titleSuffixRow.wrap;
    this.rowsByKey.set("titleSuffix", titleSuffixRow.row);
    const minRow = this.addToggleRow(body, pp("minimize"), "▣", () => this.boundPanel?.toggleMinimizable());
    this.minimizableBtn = minRow.btn;
    this.rowsByKey.set("minimize", minRow.row);
    const hideMinRow = this.addToggleRow(body, pp("hideMinimize"), "▢", () => this.boundPanel?.toggleHideMinimizeBtn());
    this.hideMinimizeBtnBtn = hideMinRow.btn;
    this.rowsByKey.set("hideMinimize", hideMinRow.row);
    const resXRow = this.addToggleRow(body, pp("resizeHorizontal"), "▣", () => this.boundPanel?.toggleResizableX());
    this.resizableXBtn = resXRow.btn;
    this.rowsByKey.set("resizeX", resXRow.row);
    const resYRow = this.addToggleRow(body, pp("resizeVertical"),   "▣", () => {
      const p = this.boundPanel;
      // Height-lock-forces-Y-off — same no-op pattern as the
      // Draggable row above.
      if (!p || p.heightMode !== "off") return;
      p.toggleResizableY();
    });
    this.resizableYBtn = resYRow.btn;
    this.rowsByKey.set("resizeY", resYRow.row);
    const closeRow = this.addToggleRow(body, pp("close"),  "▣", () => this.boundPanel?.toggleClosable());
    this.closableBtn = closeRow.btn;
    this.rowsByKey.set("close", closeRow.row);
    const hideCloseRow = this.addToggleRow(body, pp("hideClose"), "▢", () => this.boundPanel?.toggleHideCloseBtn());
    this.hideCloseBtnBtn = hideCloseRow.btn;
    this.rowsByKey.set("hideClose", hideCloseRow.row);
    // Mask: stencil-clip the panel body's Pixi content to the body
    // rect. Default on (~3 draw calls per masked container). Turn
    // off for panels whose content always fits by construction to
    // claw those drawcalls back. Default-hidden on non-Pixi panels
    // — `DomPanel` adds `"mask"` to `_hiddenSettings` for the base
    // class; `PixiPanel` removes it.
    const maskRow = this.addToggleRow(body, pp("mask"), "▣", () => this.boundPanel?.toggleMasked());
    this.maskBtn = maskRow.btn;
    this.rowsByKey.set("mask", maskRow.row);
    const layerRow = this.addLayerRow(body);
    this.layerUpBtn   = layerRow.up;
    this.layerDownBtn = layerRow.down;
    this.rowsByKey.set("layer", layerRow.row);
    // Reset is a one-shot action, not a toggle — uses the same
    // row shape but the button is ↺ and doesn't reflect any state.
    const resetRow = this.addToggleRow(body, pp("reset"), "↺", () => {
      this.boundPanel?.resetToDefaults();
    });
    this.rowsByKey.set("reset", resetRow.row);
    // "Copy this panel" — serializes the bound panel's live state
    // as JSON and writes it to the clipboard wrapped in
    // `{ "<defaultsKey>": { … } }` so it's paste-ready into
    // `content/panels/defaults.json`'s `panels` map. The user
    // workflow is: drag/resize the panel, click 📋, paste into the
    // content file, commit — new players boot with that layout.
    // Falls back to a textarea-select copy when the async
    // Clipboard API is unavailable (older browsers, non-secure
    // contexts). Button glyph briefly flips to ✓ / ⚠ for feedback.
    const copyRow = this.addToggleRow(body, pp("copyJson"), "📋", () => {
      const p = this.boundPanel;
      if (!p) return;
      const key = p.defaultsKey ?? p.storageKey;
      if (!key) {
        this.flashCopyResult(copyRow.btn, "⚠");
        return;
      }
      const payload = JSON.stringify({ [key]: p.serializeState() }, null, 2);
      void this.writeClipboard(payload).then(
        ok => this.flashCopyResult(copyRow.btn, ok ? "✓" : "⚠"),
      );
    });
    this.rowsByKey.set("copyJson", copyRow.row);
    // "Copy all panels" — same workflow but snapshots every live
    // panel into a single blob keyed by `defaultsKey ?? storageKey`.
    // Output drops straight under `content/panels/defaults.json`'s
    // `panels:` root (the wrapper key from the per-panel button is
    // omitted — the top level here IS the map). Useful when the
    // user has tweaked several panels and wants one paste covering
    // the whole layout. Panels without either key are skipped (no
    // way to address them in the defaults file).
    const copyAllRow = this.addToggleRow(body, pp("copyAllJson"), "📋📋", () => {
      const all = DomPanel.collectAllPanelStates();
      const payload = JSON.stringify(all, null, 2);
      void this.writeClipboard(payload).then(
        ok => this.flashCopyResult(copyAllRow.btn, ok ? "✓" : "⚠"),
      );
    });
    this.rowsByKey.set("copyAllJson", copyAllRow.row);
    this.panel.setBody(body);
  }

  /** Best-effort clipboard write. Tries the async Clipboard API
   *  first (requires a secure context + user-gesture, both true
   *  here — the click event satisfies user-gesture), falls back to
   *  a synchronous textarea+execCommand path for older / non-HTTPS
   *  setups. Returns `true` when either path succeeded. */
  private async writeClipboard(text: string): Promise<boolean> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch { /* fall through to textarea path */ }
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  /** Briefly swap the copy button's glyph to indicate success / fail
   *  then restore. Pure visual feedback — no state held. */
  private flashCopyResult(btn: HTMLButtonElement, glyph: string): void {
    const original = btn.textContent;
    btn.textContent = glyph;
    window.setTimeout(() => { btn.textContent = original; }, 900);
  }

  /** Open the popup bound to `panel`. Re-binds if already open. */
  show(panel: DomPanel): void {
    this.bind(panel);
    if (!this.panel.isOpen) this.panel.open();
    this.panel.focus();
    // Update the popup's title so the user can see which panel
    // they're configuring at a glance. The DomPanel API doesn't
    // expose `setTitle` yet — write to the underlying span via
    // the public panel element.
    this.updatePopupHeading(panel, panel.titleText);
    this.refreshControls();
  }

  /** Push the bound panel's title into the popup's own heading
   *  span ("<title> — Settings"). Used at `show` time and from
   *  the `onTitleChange` subscription so the heading tracks
   *  suffix flips / external `setTitle` calls live. */
  private updatePopupHeading(panel: DomPanel, title: string): void {
    const titleEl = this.panel.panel.querySelector("span");
    if (titleEl) titleEl.textContent = `${title} — ${pp("settingsHeadingSuffix")}`;
    void panel;
  }

  close(): void {
    this.unbind();
    this.panel.close();
  }

  /** Subscribe to the popup's open / close state. Proxies the
   *  underlying `DomPanel.onOpenChange` so external code (notably
   *  `main.ts`, which exits UI edit mode when the popup closes) can
   *  react without reaching through `this.panel`. Returns an
   *  unsubscribe fn. */
  onOpenChange(cb: (open: boolean) => void): () => void {
    return this.panel.onOpenChange(cb);
  }

  destroy(): void {
    this.unbind();
    this.panel.destroy();
  }

  // ── Internals ────────────────────────────────────────────────────

  private bind(panel: DomPanel): void {
    if (this.boundPanel === panel) return;
    this.unbind();
    this.boundPanel = panel;
    this.unsubAnchor    = panel.onAnchorChange(() => this.refreshControls());
    this.unsubHeight    = panel.onHeightModeChange(() => this.refreshControls());
    this.unsubPin       = panel.onPinChange(() => this.refreshControls());
    this.unsubSnap      = panel.onSnapChange(() => this.refreshControls());
    this.unsubDraggable = panel.onDraggableChange(() => this.refreshControls());
    this.unsubTaskbarIcon = panel.onTaskbarIconChange(() => this.refreshControls());
    this.unsubTitle       = panel.onTitleChange(title => this.updatePopupHeading(panel, title));
    this.unsubTitleSuffix = panel.onTitleSuffixChange(() => this.refreshControls());
    this.unsubMasked      = panel.onMaskedChange(() => this.refreshControls());
    // Per-panel cycler — rebuild against the freshly-bound
    // panel's available modes before the first `refreshControls`
    // call below reads from it.
    this.rebuildTitleSuffixSelect(panel);
  }

  private unbind(): void {
    this.unsubAnchor?.();
    this.unsubAnchor = null;
    this.unsubHeight?.();
    this.unsubHeight = null;
    this.unsubPin?.();
    this.unsubPin = null;
    this.unsubSnap?.();
    this.unsubSnap = null;
    this.unsubDraggable?.();
    this.unsubDraggable = null;
    this.unsubTaskbarIcon?.();
    this.unsubTaskbarIcon = null;
    this.unsubTitle?.();
    this.unsubTitle = null;
    this.unsubTitleSuffix?.();
    this.unsubTitleSuffix = null;
    this.unsubMasked?.();
    this.unsubMasked = null;
    this.boundPanel = null;
  }

  private refreshControls(): void {
    const p = this.boundPanel;
    if (!p) return;
    // All toggles read ▣ when on, ▢ when off — consistent visual
    // shorthand across rows.
    this.titleBarBtn.textContent    = p.isTitleBarHidden ? "▢" : "▣";
    this.gridSnapBtn.textContent    = p.isGridSnap       ? "▣" : "▢";
    this.minimizableBtn.textContent = p.isMinimizable    ? "▣" : "▢";
    this.resizableXBtn.textContent  = p.isResizableX     ? "▣" : "▢";
    this.closableBtn.textContent    = p.isClosable       ? "▣" : "▢";
    // "Hide" toggles read inverted from the others — ▣ when the
    // button is hidden (toggle on), ▢ when visible (toggle off).
    this.hideMinimizeBtnBtn.textContent = p.isMinimizeBtnHidden ? "▣" : "▢";
    this.hideCloseBtnBtn.textContent    = p.isCloseBtnHidden    ? "▣" : "▢";
    this.maskBtn.textContent            = p.isMasked            ? "▣" : "▢";
    // Draggable: when snap is non-none the value is forced off
    // and the row can't be toggled — dim the glyph to signal
    // "locked". When snap is none the raw `_draggable` toggle
    // wins and the glyph reads as the user's preference.
    const draggableForced = p.snap !== "none";
    this.draggableBtn.textContent = draggableForced ? "▢" : (p.isDraggable ? "▣" : "▢");
    this.draggableBtn.style.color = draggableForced ? FORCED_BUTTON_COLOR : NORMAL_BUTTON_COLOR;
    // Resize Vertical: same shape — height-lock forces it off.
    const resizeYForced = p.heightMode !== "off";
    this.resizableYBtn.textContent = resizeYForced ? "▢" : (p.isResizableY ? "▣" : "▢");
    this.resizableYBtn.style.color = resizeYForced ? FORCED_BUTTON_COLOR : NORMAL_BUTTON_COLOR;
    this.anchorSelect.setValue(p.anchor);
    this.snapSelect.setValue(p.snap);
    this.heightSelect.setValue(p.heightMode);
    this.pinSelect.setValue(p.pin);
    // Mirror the panel's live taskbar icon into the input —
    // resetToDefaults / external setters mutate this from outside
    // the popup. Skip when the field is currently focused so the
    // user's mid-typing buffer isn't clobbered by a re-sync
    // round-trip from their own keystroke.
    if (document.activeElement !== this.taskbarIconInput) {
      this.taskbarIconInput.value = p.taskbarIcon ?? "";
    }
    // Title suffix cycler re-syncs on external mutation (reset
    // etc.). Row visibility for the no-resolver case is handled
    // *after* the per-key loop below, so the auto-hide doesn't
    // get clobbered.
    this.titleSuffixSelect?.setValue(p.titleSuffix);
    // Per-row visibility honours the panel's `excludeSettings`
    // blacklist — every row shows by default; opt-out is explicit.
    // Restoring to `"flex"` (not `""`) preserves each row's flex
    // layout — clearing the inline `display` would drop back to
    // the div default `block` and toggles would slip out of their
    // right-aligned slots.
    for (const [key, row] of this.rowsByKey) {
      row.style.display = p.isSettingHidden(key) ? "none" : "flex";
    }
    // Auto-hide the title-suffix row when the panel registered
    // no resolvers — "None" alone isn't a useful cycle. Runs
    // after the per-key loop above so this hide doesn't get
    // overwritten by the default-flex pass.
    if (p.availableTitleSuffixes.length <= 1) {
      this.titleSuffixRow.style.display = "none";
    }
    // Layer up/down are stateless actions, nothing to refresh.
    void this.layerUpBtn;
    void this.layerDownBtn;
  }

  /** Build a one-button toggle row. The click handler runs the
   *  caller's toggle then refreshes the popup's controls so the
   *  visual state stays accurate. Returns both the row element
   *  (so the caller can hide whole rows for unsupported features)
   *  and the button (so the caller can update the glyph based on
   *  state). */
  private addToggleRow(
    parent: HTMLDivElement,
    label: string,
    glyph: string,
    onClick: () => void,
  ): { row: HTMLDivElement; btn: HTMLButtonElement } {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const wrap = document.createElement("div");
    Object.assign(wrap.style, CONTROL_WRAP_CSS);
    const btn = document.createElement("button");
    Object.assign(btn.style, BUTTON_CSS);
    btn.textContent = glyph;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
      this.refreshControls();
    });
    wrap.appendChild(btn);
    row.appendChild(wrap);
    parent.appendChild(row);
    return { row, btn };
  }

  /** Anchor row — uses the reusable cycling-select component.
   *  Changes propagate into the bound panel via the cycler's
   *  `onChange`; the popup's external `onAnchorChange`
   *  subscription handles the reverse direction (panel mutated
   *  from outside the popup → re-sync the cycler). */
  private addAnchorRow(parent: HTMLDivElement): { row: HTMLDivElement; select: CyclingSelect<AnchorMode> } {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = pp("anchor");
    row.appendChild(labelEl);

    const wrap = document.createElement("div");
    Object.assign(wrap.style, CYCLER_WRAP_CSS);
    const select = new CyclingSelect<AnchorMode>({
      options: localizeOptions(ANCHOR_OPTIONS),
      // Fits the longest option ("Bottom Right") so the cycler
      // doesn't visibly jitter in width as the user clicks
      // through values.
      labelMinWidth: "92px",
      onChange: (value) => this.boundPanel?.setAnchor(value),
    });
    wrap.appendChild(select.element);
    row.appendChild(wrap);
    parent.appendChild(row);
    return { row, select };
  }

  /** Snap row — cycling select that glues the panel to a corner
   *  of the safe area (or `"none"` to release it). Shape mirrors
   *  the anchor row; a non-none value side-effects the Draggable
   *  toggle off (handled in `DomPanel.setSnap`), which the popup
   *  reflects via its `onDraggableChange` subscription. */
  private addSnapRow(parent: HTMLDivElement): { row: HTMLDivElement; select: CyclingSelect<SnapMode> } {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = pp("snapping");
    row.appendChild(labelEl);

    const wrap = document.createElement("div");
    Object.assign(wrap.style, CYCLER_WRAP_CSS);
    const select = new CyclingSelect<SnapMode>({
      options: localizeOptions(SNAP_OPTIONS),
      labelMinWidth: "92px",
      onChange: (value) => this.boundPanel?.setSnap(value),
    });
    wrap.appendChild(select.element);
    row.appendChild(wrap);
    parent.appendChild(row);
    return { row, select };
  }

  /** Height row — cycling select that locks the panel's height
   *  to a fraction of the safe area between the taskbars. Shape
   *  mirrors the anchor row. */
  private addHeightRow(parent: HTMLDivElement): { row: HTMLDivElement; select: CyclingSelect<HeightMode> } {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = pp("height");
    row.appendChild(labelEl);

    const wrap = document.createElement("div");
    Object.assign(wrap.style, CYCLER_WRAP_CSS);
    const select = new CyclingSelect<HeightMode>({
      options: localizeOptions(HEIGHT_OPTIONS),
      // Fits the longest option ("Quarter") so the cycler doesn't
      // visibly jitter in width as the user clicks through values.
      labelMinWidth: "92px",
      onChange: (value) => this.boundPanel?.setHeightMode(value),
    });
    wrap.appendChild(select.element);
    row.appendChild(wrap);
    parent.appendChild(row);
    return { row, select };
  }

  /** Pin row — cycling select that attaches the panel's entry to
   *  one of the four taskbar corners (or detaches it). Driven via
   *  `DomPanel.setPin`, which (un)registers with the appropriate
   *  `PanelTaskbar` looked up by position. */
  private addPinRow(parent: HTMLDivElement): { row: HTMLDivElement; select: CyclingSelect<PinMode> } {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = pp("taskbarPin");
    row.appendChild(labelEl);

    const wrap = document.createElement("div");
    Object.assign(wrap.style, CYCLER_WRAP_CSS);
    const select = new CyclingSelect<PinMode>({
      options: localizeOptions(PIN_OPTIONS),
      // Fits the longest option ("Bottom Center") so the cycler
      // doesn't visibly jitter in width as the user clicks
      // through values.
      labelMinWidth: "100px",
      onChange: (value) => this.boundPanel?.setPin(value),
    });
    wrap.appendChild(select.element);
    row.appendChild(wrap);
    parent.appendChild(row);
    return { row, select };
  }

  /** Title Suffix row — empty shell at construction; the actual
   *  cycler is rebuilt on every `bind` from the bound panel's
   *  `availableTitleSuffixes` so the option list matches whatever
   *  resolvers that specific panel registered. A panel with no
   *  resolvers (just "none") gets the whole row hidden inside
   *  `refreshControls`. */
  private addTitleSuffixRow(parent: HTMLDivElement): { row: HTMLDivElement; wrap: HTMLDivElement } {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = pp("titleSuffix");
    row.appendChild(labelEl);
    const wrap = document.createElement("div");
    Object.assign(wrap.style, CYCLER_WRAP_CSS);
    row.appendChild(wrap);
    parent.appendChild(row);
    return { row, wrap };
  }

  /** Rebuild the title-suffix cycler against `panel`'s available
   *  modes. Called from `bind` because the option set is per-
   *  panel — Inventory might offer player+soul, the debug HUD
   *  might offer none. Detaches the previous cycler (if any) and
   *  mounts a fresh one into `titleSuffixWrap`. */
  private rebuildTitleSuffixSelect(panel: DomPanel): void {
    while (this.titleSuffixWrap.firstChild) {
      this.titleSuffixWrap.removeChild(this.titleSuffixWrap.firstChild);
    }
    const available = panel.availableTitleSuffixes;
    if (available.length <= 1) {
      // Only "none" — no real choice to offer; the row hides via
      // `refreshControls`. Skip cycler construction entirely so
      // we don't pay for a one-option widget no one sees.
      this.titleSuffixSelect = null;
      return;
    }
    const options = available.map(v => ({ value: v, label: pp(TITLE_SUFFIX_KEYS[v]) }));
    const select = new CyclingSelect<TitleSuffix>({
      options,
      labelMinWidth: "92px",
      onChange: (value) => this.boundPanel?.setTitleSuffix(value),
    });
    select.setValue(panel.titleSuffix);
    this.titleSuffixWrap.appendChild(select.element);
    this.titleSuffixSelect = select;
  }

  /** Taskbar Icon row — text input for the glyph shown on the
   *  panel's taskbar entry. Empty value = text-mode entry (panel
   *  title). Writes propagate live to the panel on every `input`
   *  event, so the taskbar reshapes in real-time as the user
   *  pastes / types. `maxLength: 4` is generous: most use cases
   *  are a single unicode emoji (2 code units after a surrogate
   *  pair) but combining marks / VS16 selectors can push to 3-4. */
  private addTaskbarIconRow(parent: HTMLDivElement): { row: HTMLDivElement; input: HTMLInputElement } {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = pp("taskbarIcon");
    row.appendChild(labelEl);

    const wrap = document.createElement("div");
    Object.assign(wrap.style, CYCLER_WRAP_CSS);
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 4;
    input.placeholder = pp("taskbarIconPlaceholder");
    Object.assign(input.style, {
      background: "rgba(20, 22, 30, 0.96)",
      border: "1px solid #3a3a4a",
      borderRadius: "3px",
      color: "#ecd6aa",
      fontFamily: NOTO_EMOJI_FAMILY,
      fontSize: "14px",
      padding: "2px 6px",
      width: "60px",
      textAlign: "center",
      outline: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    input.addEventListener("input", () => {
      this.boundPanel?.setTaskbarIcon(input.value);
    });
    // Stop the popup's "click → focus" pattern from interpreting
    // a text-field click as a "bring popup to front" action. The
    // input naturally focuses on click anyway.
    input.addEventListener("click", (e) => e.stopPropagation());
    wrap.appendChild(input);
    row.appendChild(wrap);
    parent.appendChild(row);
    return { row, input };
  }

  /** Layer row has two buttons (up / down) instead of a single
   *  toggle, so it gets its own helper. */
  private addLayerRow(parent: HTMLDivElement): { row: HTMLDivElement; up: HTMLButtonElement; down: HTMLButtonElement } {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = pp("layer");
    row.appendChild(labelEl);

    const group = document.createElement("div");
    Object.assign(group.style, BUTTON_GROUP_CSS);
    const up = document.createElement("button");
    Object.assign(up.style, BUTTON_CSS);
    up.textContent = "🞁";
    up.addEventListener("click", (e) => {
      e.stopPropagation();
      this.boundPanel?.layerUp();
    });
    const down = document.createElement("button");
    Object.assign(down.style, BUTTON_CSS);
    down.textContent = "🞃";
    down.addEventListener("click", (e) => {
      e.stopPropagation();
      this.boundPanel?.layerDown();
    });
    group.appendChild(up);
    group.appendChild(down);
    row.appendChild(group);
    parent.appendChild(row);
    return { row, up, down };
  }
}
