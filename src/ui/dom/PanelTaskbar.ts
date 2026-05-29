import { NOTO_EMOJI_FAMILY } from "../../assets/fonts";
import type { DomPanel } from "./DomPanel";

const HOST_ID = "app";

/** Height of the taskbar strip. Panels whose default rect anchors to
 *  the bottom should leave this much room. Exposed as a static so
 *  callers can compute their own bottom offsets without hardcoding. */
const HEIGHT = 32;

/** Base bar style — position-agnostic. The constructor layers a
 *  `top: 0` + `borderBottom` (or `bottom: 0` + `borderTop`) on top
 *  to anchor the bar to the picked edge. */
const BAR_CSS: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  left: "0",
  right: "0",
  height: `${HEIGHT}px`,
  display: "flex",
  alignItems: "center",
  gap: "4px",
  padding: "0 6px",
  background: "rgba(20, 22, 30, 0.96)",
  color: "#ecd6aa",
  fontFamily: "sans-serif",
  fontSize: "12px",
  // Above every panel z-band (see `DomPanel`'s `Z_BAND_BASE` —
  // bands run 10000-49999 per "gameview"/"inventory"/"overlay"/
  // "dom"). 50001 keeps the bar visible above the highest band's
  // top of range; a panel-z that climbed into that territory
  // already overflowed its band, so we don't owe it cover.
  zIndex: "50001",
  userSelect: "none",
  boxSizing: "border-box",
};

const BAR_BOTTOM_CSS: Partial<CSSStyleDeclaration> = {
  bottom: "0",
  borderTop: "1px solid #3a3a4a",
};

const BAR_TOP_CSS: Partial<CSSStyleDeclaration> = {
  top: "0",
  borderBottom: "1px solid #3a3a4a",
};

/** Base entry style — applies to "open, not focused" panels. The
 *  closed / minimized / focused states layer additional properties
 *  on top via `Object.assign`. */
const ENTRY_CSS: Partial<CSSStyleDeclaration> = {
  background: "rgba(40, 44, 56, 0.5)",
  border: "1px solid #3a3a4a",
  borderRadius: "3px",
  color: "#a0a0b0",
  cursor: "pointer",
  padding: "4px 12px",
  height: "24px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: "sans-serif",
  fontSize: "12px",
  minWidth: "100px",
  maxWidth: "180px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  boxSizing: "border-box",
};

/** Override style for icon-mode entries — a square the height of the
 *  bar, holding a single unicode glyph. Used by panels that pass
 *  `taskbarIcon` instead of relying on the title text. */
const ENTRY_ICON_CSS: Partial<CSSStyleDeclaration> = {
  width: "24px",
  minWidth: "24px",
  maxWidth: "24px",
  padding: "0",
  fontFamily: NOTO_EMOJI_FAMILY,
  fontSize: "14px",
  lineHeight: "1",
};

/** Override style for icon-mode entries that *also* carry a live
 *  title-suffix (e.g. `👁 Wolf`). Drops the fixed-width square so the
 *  suffix text fits next to the glyph, but keeps the emoji font /
 *  size / line-height from the square form so the icon renders the
 *  same. Capped at the same wide-text `maxWidth` as
 *  [`ENTRY_CSS`] so a long suffix still ellipsises rather than
 *  blowing out the bar. */
const ENTRY_ICON_WITH_SUFFIX_CSS: Partial<CSSStyleDeclaration> = {
  width: "auto",
  minWidth: "auto",
  maxWidth: "180px",
  padding: "0 8px",
  fontFamily: NOTO_EMOJI_FAMILY,
  fontSize: "14px",
  lineHeight: "1",
};

/** Compose an icon-mode entry's label. With no live suffix this is
 *  just the glyph (preserves the square-icon look); with a suffix
 *  the entry widens via [`ENTRY_ICON_WITH_SUFFIX_CSS`] and shows
 *  `<icon> <suffix>` so e.g. multiple game-view panels stay
 *  distinguishable by the resolved soul/player name. Falls back to
 *  the glyph alone if the panel exits icon mode mid-resolve. */
function iconLabel(panel: DomPanel): string {
  const icon = panel.taskbarIcon;
  if (icon === null) return "";
  const suffix = panel.titleSuffixText;
  return suffix ? `${icon} ${suffix}` : icon;
}

/** Pick the right CSS overlay for an icon-mode entry — square when
 *  the panel is icon-only, wide when a live suffix needs to fit
 *  alongside the glyph. Kept as a single source of truth so the
 *  register-time path and the live `applyEntryState` reset stay in
 *  lockstep on width / padding. */
function iconStyleFor(panel: DomPanel): Partial<CSSStyleDeclaration> {
  return panel.titleSuffixText ? ENTRY_ICON_WITH_SUFFIX_CSS : ENTRY_ICON_CSS;
}

/** Entry state when the panel is open + focused. Brightest — the
 *  user should be able to spot which panel is on top at a glance. */
const ENTRY_FOCUSED_CSS: Partial<CSSStyleDeclaration> = {
  background: "rgba(80, 90, 110, 0.85)",
  color: "#ffffff",
  borderColor: "#5a6472",
};

/** Entry state when the panel is open but currently minimized. Sits
 *  between focused and closed — the panel exists and has state to
 *  return to, just isn't visible. Italic conveys "deferred." */
const ENTRY_MINIMIZED_CSS: Partial<CSSStyleDeclaration> = {
  fontStyle: "italic",
};

/** Entry state for a pinned panel that's currently closed. Darker
 *  than minimized — the panel doesn't exist on screen at all, the
 *  entry is purely a re-launch affordance. */
const ENTRY_CLOSED_CSS: Partial<CSSStyleDeclaration> = {
  background: "rgba(20, 22, 30, 0.5)",
  color: "#7a7a8a",
  fontStyle: "italic",
};

/** Group container at the left or right end of the bar. Entries
 *  belonging to that side are appended into the matching group;
 *  the spacer between groups absorbs the leftover width. */
const GROUP_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  alignItems: "center",
  gap: "4px",
};

const SPACER_CSS: Partial<CSSStyleDeclaration> = {
  flex: "1 1 auto",
};

interface Entry {
  panel: DomPanel;
  button: HTMLButtonElement;
  /** Pinned entries persist while the panel is closed — the entry
   *  acts as a re-launch button. Unpinned entries vanish when their
   *  panel closes. */
  pinned: boolean;
  /** Icon-mode entries render as a square holding a single unicode
   *  glyph instead of a wide text rectangle. Captured here so the
   *  state-apply path can re-layer the icon CSS after the base
   *  reset without re-reading the panel's option. */
  iconMode: boolean;
  unsubOpen:     () => void;
  unsubMinimize: () => void;
  unsubFocus:    () => void;
  unsubAnchor:      () => void;
  unsubMinimizable: () => void;
  unsubTaskbarIcon: () => void;
  unsubTitle:       () => void;
}

/**
 * Bottom-of-viewport task bar for `DomPanel` instances. Windows-style:
 * each registered panel gets a button entry that reflects its
 * open / minimized / focused state and acts as the way back in for
 * minimized or pinned-closed panels.
 *
 * Click semantics on an entry:
 *   - Closed       → open + focus
 *   - Minimized    → restore + focus
 *   - Focused      → minimize (clicking the active app's icon
 *                   minimizes it, matching Windows)
 *   - Not focused  → bring to front
 *
 * Multiple panels register independently; the taskbar fans out
 * subscriptions to each panel's open / minimize / focus hooks so
 * entry styles stay in sync without polling. The taskbar itself
 * owns no panel state — it's a pure view over the panels.
 *
 * A single taskbar instance lives on `GameContext` (`ctx.taskbar`)
 * for the lifetime of the app session; scenes don't create their
 * own. Panels constructed without a taskbar reference fall back to
 * the in-place roll-up minimize behavior.
 */
export interface PanelTaskbarOptions {
  /** Which edge of the viewport to anchor against. `"bottom"` is the
   *  default — classic taskbar. `"top"` puts the bar across the top
   *  with a bottom border instead. */
  position?: "top" | "bottom";
}

/** Module-level registry indexed by edge so `DomPanel` can look up
 *  the live taskbar for a given position when the user changes the
 *  Pin setting at runtime. Holds at most one bar per edge — the
 *  app constructs two of these (top + bottom) at boot, and the
 *  registry survives the bar's lifetime. Constructing a second
 *  bar on the same edge replaces the previous one in the registry;
 *  the previous bar's panels stay registered to it until its own
 *  `destroy()` clears them. */
const taskbarsByPosition: { top: PanelTaskbar | null; bottom: PanelTaskbar | null } = {
  top: null,
  bottom: null,
};

export class PanelTaskbar {
  static readonly HEIGHT = HEIGHT;

  /** Look up the live taskbar for `position`, or `null` when the
   *  app hasn't (yet) constructed one for that edge. Used by
   *  `DomPanel.setPin` to find the destination bar without
   *  threading both bars through every panel constructor. */
  static getByPosition(position: "top" | "bottom"): PanelTaskbar | null {
    return taskbarsByPosition[position];
  }

  readonly position: "top" | "bottom";
  private readonly bar: HTMLDivElement;
  private readonly leftGroup:   HTMLDivElement;
  private readonly centerGroup: HTMLDivElement;
  private readonly rightGroup:  HTMLDivElement;
  private readonly entries: Entry[] = [];
  private focusedPanel: DomPanel | null = null;
  private _destroyed = false;

  get destroyed(): boolean { return this._destroyed; }

  constructor(opts?: PanelTaskbarOptions) {
    this.position = opts?.position ?? "bottom";
    taskbarsByPosition[this.position] = this;
    this.bar = document.createElement("div");
    Object.assign(this.bar.style, BAR_CSS);
    Object.assign(
      this.bar.style,
      this.position === "top" ? BAR_TOP_CSS : BAR_BOTTOM_CSS,
    );

    // Bar layout: [left group] [spacer] [center group] [spacer]
    // [right group]. Entries route into their side's group based on
    // `panel.taskbarSide` ("left" / "center" / "right"). Two
    // flex-grow spacers symmetrically pad the center group so it
    // stays middle-aligned regardless of how many entries land in
    // each side group.
    this.leftGroup = document.createElement("div");
    Object.assign(this.leftGroup.style, GROUP_CSS);
    const spacerL = document.createElement("div");
    Object.assign(spacerL.style, SPACER_CSS);
    this.centerGroup = document.createElement("div");
    Object.assign(this.centerGroup.style, GROUP_CSS);
    const spacerR = document.createElement("div");
    Object.assign(spacerR.style, SPACER_CSS);
    this.rightGroup = document.createElement("div");
    Object.assign(this.rightGroup.style, GROUP_CSS);
    this.bar.appendChild(this.leftGroup);
    this.bar.appendChild(spacerL);
    this.bar.appendChild(this.centerGroup);
    this.bar.appendChild(spacerR);
    this.bar.appendChild(this.rightGroup);

    const host = document.getElementById(HOST_ID) ?? document.body;
    host.appendChild(this.bar);
  }

  /** Add a panel to the taskbar. Idempotent — re-registering the
   *  same panel is a no-op. Pinned status, icon, and side all come
   *  from the panel itself so the caller doesn't have to mirror
   *  them. */
  register(panel: DomPanel): void {
    if (this._destroyed) return;
    if (this.entries.some((e) => e.panel === panel)) return;

    const iconMode = panel.taskbarIcon !== null;
    const button = document.createElement("button");
    Object.assign(button.style, ENTRY_CSS);
    if (iconMode) Object.assign(button.style, iconStyleFor(panel));
    button.textContent = iconMode ? iconLabel(panel) : panel.titleText;
    // Always set the tooltip to the human-readable title — for
    // icon-mode entries this is the only way to discover what the
    // glyph means.
    button.title = panel.titleText;
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      this.handleClick(panel);
    });
    this.groupFor(panel.taskbarSide).appendChild(button);

    const entry: Entry = {
      panel,
      button,
      pinned: panel.pinned,
      iconMode,
      unsubOpen:     panel.onOpenChange(() => this.applyEntryState(entry)),
      unsubMinimize: panel.onMinimizeChange(() => this.applyEntryState(entry)),
      unsubFocus:    panel.onFocus(() => {
        this.focusedPanel = panel;
        this.applyAllStates();
      }),
      unsubAnchor:      panel.onAnchorChange(()      => this.applyEntryState(entry)),
      unsubMinimizable: panel.onMinimizableChange(() => this.applyEntryState(entry)),
      // Icon changes reshape the entry button: icon-mode flips
      // between square (single glyph) and wide-text (panel
      // title) on every transition through `null`, and the
      // current label / iconMode flag both have to track the
      // panel's live state. `reskinEntryFromPanel` is the one
      // path that touches button text + iconMode + the per-
      // mode CSS together so the entry can't desync.
      unsubTaskbarIcon: panel.onTaskbarIconChange(() => this.reskinEntryFromPanel(entry)),
      // Title changes (suffix flips, external `setTitle` calls
      // like the blueprints capacity counter) re-write the
      // wide-text button label and tooltip. Icon-mode entries
      // still get the tooltip refresh — the glyph itself doesn't
      // carry the title text, so the tooltip is the only place
      // the user sees the live name.
      unsubTitle:       panel.onTitleChange(title => {
        entry.button.title = title;
        // Icon-mode entries fold the live suffix in next to the
        // glyph so different instances of the same panel type
        // (multiple game-views, etc.) stay distinguishable.
        entry.button.textContent = entry.iconMode ? iconLabel(entry.panel) : title;
      }),
    };
    this.entries.push(entry);
    if (panel.isOpen && !panel.isMinimized) this.focusedPanel = panel;
    this.applyEntryState(entry);
  }

  /** Remove a panel's entry. Called by `DomPanel.destroy()`. No-op
   *  for unknown panels. */
  unregister(panel: DomPanel): void {
    if (this._destroyed) return;
    const idx = this.entries.findIndex((e) => e.panel === panel);
    if (idx === -1) return;
    const entry = this.entries[idx];
    entry.unsubOpen();
    entry.unsubMinimize();
    entry.unsubFocus();
    entry.unsubAnchor();
    entry.unsubMinimizable();
    entry.unsubTaskbarIcon();
    entry.unsubTitle();
    entry.button.remove();
    this.entries.splice(idx, 1);
    if (this.focusedPanel === panel) this.focusedPanel = null;
  }

  destroy(): void {
    this._destroyed = true;
    for (const entry of this.entries) {
      entry.unsubOpen();
      entry.unsubMinimize();
      entry.unsubFocus();
      entry.unsubAnchor();
      entry.unsubMinimizable();
      entry.unsubTaskbarIcon();
      entry.unsubTitle();
    }
    this.entries.length = 0;
    this.bar.remove();
    if (taskbarsByPosition[this.position] === this) {
      taskbarsByPosition[this.position] = null;
    }
  }

  // ── Internals ────────────────────────────────────────────────────

  /** Map a `taskbarSide` (`"left"` / `"center"` / `"right"`) to the
   *  matching group container the entry button belongs in. Used at
   *  registration time and again when a panel's pin side changes
   *  (so the button moves between groups in place). */
  private groupFor(side: "left" | "center" | "right"): HTMLDivElement {
    if (side === "right")  return this.rightGroup;
    if (side === "center") return this.centerGroup;
    return this.leftGroup;
  }

  /** Re-render the entry button to match the panel's current
   *  `taskbarIcon`. Flips `iconMode` between text-rectangle and
   *  icon-square based on whether the icon is non-null, updates
   *  the button text, then runs the full state-apply pass so the
   *  focused / minimized / closed overlay re-layers on top of the
   *  freshly-reset base. Wired to `onTaskbarIconChange` so the
   *  popup's Taskbar Icon row updates the entry live. */
  private reskinEntryFromPanel(entry: Entry): void {
    const icon = entry.panel.taskbarIcon;
    entry.iconMode = icon !== null;
    entry.button.textContent = entry.iconMode ? iconLabel(entry.panel) : entry.panel.titleText;
    this.applyEntryState(entry);
  }

  /** The most-recently-focused panel registered with this taskbar, or
   *  `null` if no registered panel has been focused yet. Useful as a
   *  default target for actions that want "the panel the user was
   *  last working with" — e.g. the panel-settings popup that opens
   *  on entering UI edit mode. Stays pointed at the last-focused
   *  panel even after that panel closes; only cleared by `unregister`. */
  getFocusedPanel(): DomPanel | null {
    return this.focusedPanel;
  }

  private handleClick(panel: DomPanel): void {
    if (!panel.isOpen) {
      // Closed → open (which also focuses).
      panel.open();
      return;
    }
    if (panel.isMinimized) {
      // Minimized → restore + focus (focus brings it to the front).
      panel.restore();
      panel.focus();
      return;
    }
    // Visible (open + not minimized). If this panel is already the
    // frontmost / focused one, a click minimizes it (toggle away).
    // Otherwise it's buried behind a peer — bring it to front and
    // select it in a single click. `focus()` raises both the DOM
    // chrome z-index and the Pixi nodes (via PixiPanel's onFocus
    // reorder hook), so surfacing a buried panel no longer needs a
    // click-on-body or a second taskbar click.
    if (this.focusedPanel === panel) {
      panel.minimize();
    } else {
      panel.focus();
    }
  }

  private applyEntryState(entry: Entry): void {
    const { panel, button } = entry;

    // Show iff the panel can be minimized OR it's pinned. Pinned
    // entries act as always-visible launchers (settings menu,
    // etc.) regardless of minimize capability; non-pinned panels
    // only earn an entry when they have a minimize affordance
    // for the user to come back from.
    if (!panel.isMinimizable && !entry.pinned) {
      button.style.display = "none";
      return;
    }
    // Unpinned entries vanish when their panel is closed.
    if (!entry.pinned && !panel.isOpen) {
      button.style.display = "none";
      return;
    }
    button.style.display = "";

    // Reset to base, then re-layer overrides. The icon-mode CSS
    // is part of the base for icon entries — applied on every
    // reset so a state-change doesn't leak the wider-rectangle
    // shape from prior styling.
    Object.assign(button.style, ENTRY_CSS);
    if (entry.iconMode) Object.assign(button.style, iconStyleFor(entry.panel));
    if (!panel.isOpen) {
      // Pinned + closed: darkest. Panel doesn't exist on screen.
      Object.assign(button.style, ENTRY_CLOSED_CSS);
    } else if (panel.isMinimized) {
      // Open but minimized: italic accent over the base — lighter
      // than closed, signalling "the panel is still around, just
      // collapsed."
      Object.assign(button.style, ENTRY_MINIMIZED_CSS);
    } else if (this.focusedPanel === panel) {
      Object.assign(button.style, ENTRY_FOCUSED_CSS);
    }
    if (entry.iconMode) {
      // Unicode glyphs (especially emoji from NotoEmoji) don't have
      // italic forms; the browser fakes the slant as a sheared
      // bitmap and it looks bad. The dim color from CLOSED still
      // differentiates the state — drop the italic for icon mode.
      button.style.fontStyle = "normal";
    }
  }

  private applyAllStates(): void {
    for (const entry of this.entries) this.applyEntryState(entry);
  }
}
