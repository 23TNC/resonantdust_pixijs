import { panelTitle, panelText } from "../panelStrings";

const HOST_ID = "app";

const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 20;

const PANEL_CSS: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  display: "flex",
  flexDirection: "column",
  background: "rgba(20, 22, 30, 0.96)",
  border: "1px solid #3a3a4a",
  borderRadius: "6px 6px 0 0",
  color: "#ecd6aa",
  fontFamily: "sans-serif",
  fontSize: "13px",
  minWidth: "200px",
  zIndex: "20",
  overflow: "hidden",
  boxShadow: "0 -4px 12px rgba(0,0,0,0.5)",
};

const HEADER_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 12px",
  borderBottom: "1px solid #3a3a4a",
  fontSize: "12px",
  color: "#a0a0b0",
  userSelect: "none",
};

const CLOSE_BTN_CSS: Partial<CSSStyleDeclaration> = {
  background: "none",
  border: "none",
  color: "#a0a0b0",
  cursor: "pointer",
  fontSize: "16px",
  padding: "0 0 0 8px",
  lineHeight: "1",
};

const ROW_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 12px",
  borderBottom: "1px solid #23252e",
};

const LABEL_CSS: Partial<CSSStyleDeclaration> = {
  fontSize: "13px",
  color: "#c0c8d8",
  userSelect: "none",
};

const STEPPER_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
};

const STEP_BTN_CSS: Partial<CSSStyleDeclaration> = {
  background: "#3a3a4a",
  border: "1px solid #5a5a6a",
  borderRadius: "3px",
  color: "#ecd6aa",
  cursor: "pointer",
  fontSize: "14px",
  lineHeight: "1",
  padding: "2px 8px",
};

const STEP_VALUE_CSS: Partial<CSSStyleDeclaration> = {
  minWidth: "28px",
  textAlign: "center",
  fontSize: "13px",
  color: "#ecd6aa",
  userSelect: "none",
};

const TOGGLE_ROW_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 12px",
  borderBottom: "1px solid #23252e",
};

const TOGGLE_BTN_CSS: Partial<CSSStyleDeclaration> = {
  background: "#3a3a4a",
  border: "1px solid #5a5a6a",
  borderRadius: "3px",
  color: "#888",
  cursor: "pointer",
  fontSize: "12px",
  padding: "2px 8px",
};

const TOGGLE_BTN_ACTIVE_CSS: Partial<CSSStyleDeclaration> = {
  background: "#2a4a3a",
  border: "1px solid #3a7a5a",
  color: "#7ae07a",
};

/**
 * DOM-based settings panel that slides up from the chat panel's gear
 * button. Anchored `position: fixed` with `right`/`bottom` set from the
 * gear button's viewport coords — computed once when `open()` is called.
 *
 * Font-size changes are applied in real time via `onFontSizeChange`.
 * Other settings are wired to debug.log for now and can be connected
 * to real behavior later.
 */
export class ChatSettingsMenu {
  private readonly panel: HTMLDivElement;
  private _open = false;

  private fontSize: number;
  private readonly fontSizeValueEl: HTMLSpanElement;

  private timestampsOn = false;
  private readonly timestampsOnBtn: HTMLButtonElement;
  private readonly timestampsOffBtn: HTMLButtonElement;

  private systemMsgsOn = true;
  private readonly systemMsgsOnBtn: HTMLButtonElement;
  private readonly systemMsgsOffBtn: HTMLButtonElement;

  /** Fires whenever the user changes the font size. Wire to ChatPanel. */
  onFontSizeChange: ((size: number) => void) | null = null;
  /** Fires when the timestamps toggle changes. Wire when implemented. */
  onTimestampsChange: ((on: boolean) => void) | null = null;
  /** Fires when the system messages toggle changes. Wire when implemented. */
  onSystemMsgsChange: ((on: boolean) => void) | null = null;

  get isOpen(): boolean { return this._open; }

  constructor(initialFontSize: number) {
    this.fontSize = initialFontSize;

    this.panel = document.createElement("div");
    Object.assign(this.panel.style, PANEL_CSS);

    // ── Header ─────────────────────────────────────────────────────────
    const header = document.createElement("div");
    Object.assign(header.style, HEADER_CSS);
    const title = document.createElement("span");
    title.textContent = panelTitle("chatSettings");
    const closeBtn = document.createElement("button");
    Object.assign(closeBtn.style, CLOSE_BTN_CSS);
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => this.close());
    header.appendChild(title);
    header.appendChild(closeBtn);
    this.panel.appendChild(header);

    // ── Font size stepper ──────────────────────────────────────────────
    const fontRow = document.createElement("div");
    Object.assign(fontRow.style, ROW_CSS);
    const fontLabel = document.createElement("span");
    Object.assign(fontLabel.style, LABEL_CSS);
    fontLabel.textContent = panelText("chatSettings", "fontSize");
    const stepper = document.createElement("div");
    Object.assign(stepper.style, STEPPER_CSS);
    const decBtn = document.createElement("button");
    Object.assign(decBtn.style, STEP_BTN_CSS);
    decBtn.textContent = "−";
    decBtn.addEventListener("click", () => this.changeFontSize(-1));
    this.fontSizeValueEl = document.createElement("span");
    Object.assign(this.fontSizeValueEl.style, STEP_VALUE_CSS);
    this.fontSizeValueEl.textContent = String(this.fontSize);
    const incBtn = document.createElement("button");
    Object.assign(incBtn.style, STEP_BTN_CSS);
    incBtn.textContent = "+";
    incBtn.addEventListener("click", () => this.changeFontSize(+1));
    stepper.appendChild(decBtn);
    stepper.appendChild(this.fontSizeValueEl);
    stepper.appendChild(incBtn);
    fontRow.appendChild(fontLabel);
    fontRow.appendChild(stepper);
    this.panel.appendChild(fontRow);

    // ── Timestamps toggle ──────────────────────────────────────────────
    const tsRow = document.createElement("div");
    Object.assign(tsRow.style, TOGGLE_ROW_CSS);
    const tsLabel = document.createElement("span");
    Object.assign(tsLabel.style, LABEL_CSS);
    tsLabel.textContent = panelText("chatSettings", "timestamps");
    const tsBtns = document.createElement("div");
    Object.assign(tsBtns.style, STEPPER_CSS);
    this.timestampsOnBtn = document.createElement("button");
    this.timestampsOnBtn.textContent = panelText("chatSettings", "on");
    this.timestampsOffBtn = document.createElement("button");
    this.timestampsOffBtn.textContent = panelText("chatSettings", "off");
    this.timestampsOnBtn.addEventListener("click", () => this.setTimestamps(true));
    this.timestampsOffBtn.addEventListener("click", () => this.setTimestamps(false));
    tsBtns.appendChild(this.timestampsOnBtn);
    tsBtns.appendChild(this.timestampsOffBtn);
    tsRow.appendChild(tsLabel);
    tsRow.appendChild(tsBtns);
    this.panel.appendChild(tsRow);

    // ── System messages toggle ─────────────────────────────────────────
    const sysRow = document.createElement("div");
    Object.assign(sysRow.style, TOGGLE_ROW_CSS);
    const sysLabel = document.createElement("span");
    Object.assign(sysLabel.style, LABEL_CSS);
    sysLabel.textContent = panelText("chatSettings", "systemMessages");
    const sysBtns = document.createElement("div");
    Object.assign(sysBtns.style, STEPPER_CSS);
    this.systemMsgsOnBtn = document.createElement("button");
    this.systemMsgsOnBtn.textContent = panelText("chatSettings", "on");
    this.systemMsgsOffBtn = document.createElement("button");
    this.systemMsgsOffBtn.textContent = panelText("chatSettings", "off");
    this.systemMsgsOnBtn.addEventListener("click", () => this.setSystemMsgs(true));
    this.systemMsgsOffBtn.addEventListener("click", () => this.setSystemMsgs(false));
    sysBtns.appendChild(this.systemMsgsOnBtn);
    sysBtns.appendChild(this.systemMsgsOffBtn);
    sysRow.appendChild(sysLabel);
    sysRow.appendChild(sysBtns);
    this.panel.appendChild(sysRow);

    this.refreshToggleStyles();
  }

  /**
   * Open the menu anchored to the gear button's position.
   * `cssRight` and `cssBottom` are distances from the right/bottom
   * viewport edges (suitable for `position: fixed; right: …; bottom: …`).
   */
  open(cssRight: number, cssBottom: number): void {
    if (this._open) return;
    this.panel.style.right = `${cssRight}px`;
    this.panel.style.bottom = `${cssBottom}px`;
    const host = document.getElementById(HOST_ID) ?? document.body;
    host.appendChild(this.panel);
    this._open = true;
  }

  close(): void {
    if (!this._open) return;
    this.panel.remove();
    this._open = false;
  }

  toggle(cssRight: number, cssBottom: number): void {
    if (this._open) this.close(); else this.open(cssRight, cssBottom);
  }

  destroy(): void {
    this.close();
  }

  private changeFontSize(delta: number): void {
    const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, this.fontSize + delta));
    if (next === this.fontSize) return;
    this.fontSize = next;
    this.fontSizeValueEl.textContent = String(this.fontSize);
    this.onFontSizeChange?.(this.fontSize);
  }

  private setTimestamps(on: boolean): void {
    if (this.timestampsOn === on) return;
    this.timestampsOn = on;
    this.refreshToggleStyles();
    this.onTimestampsChange?.(on);
  }

  private setSystemMsgs(on: boolean): void {
    if (this.systemMsgsOn === on) return;
    this.systemMsgsOn = on;
    this.refreshToggleStyles();
    this.onSystemMsgsChange?.(on);
  }

  private refreshToggleStyles(): void {
    this.applyToggle(this.timestampsOnBtn,  this.timestampsOn);
    this.applyToggle(this.timestampsOffBtn, !this.timestampsOn);
    this.applyToggle(this.systemMsgsOnBtn,  this.systemMsgsOn);
    this.applyToggle(this.systemMsgsOffBtn, !this.systemMsgsOn);
  }

  private applyToggle(btn: HTMLButtonElement, active: boolean): void {
    Object.assign(btn.style, TOGGLE_BTN_CSS);
    if (active) Object.assign(btn.style, TOGGLE_BTN_ACTIVE_CSS);
  }
}
