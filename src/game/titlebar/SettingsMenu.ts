import { debug } from "../../debug";

const HOST_ID = "app";

const PANEL_CSS: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  right: "0",
  top: "32px",
  display: "flex",
  flexDirection: "column",
  background: "rgba(20, 22, 30, 0.96)",
  border: "1px solid #3a3a4a",
  borderTop: "none",
  borderRadius: "0 0 0 6px",
  color: "#ecd6aa",
  fontFamily: "sans-serif",
  fontSize: "14px",
  minWidth: "200px",
  zIndex: "20",
  overflow: "hidden",
  boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
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

const ITEM_CSS: Partial<CSSStyleDeclaration> = {
  padding: "10px 16px",
  background: "none",
  border: "none",
  borderBottom: "1px solid #23252e",
  color: "#ecd6aa",
  fontFamily: "sans-serif",
  fontSize: "14px",
  textAlign: "left",
  cursor: "pointer",
  width: "100%",
  boxSizing: "border-box",
};

const ITEM_HOVER_BG = "#2a2a3a";

/**
 * DOM-based settings panel that drops down from the title bar gear
 * icon. Mount/unmount is controlled by `toggle()` / `open()` /
 * `close()`; the DOM element is appended to `#app` on open and
 * removed on close.
 *
 * Callback properties (e.g. `onLogOut`) default to a debug-log
 * no-op and can be wired by whichever scene is currently active.
 * Reset them to `null` in `onExit` if they capture scene-local
 * state.
 */
export class SettingsMenu {
  private readonly panel: HTMLDivElement;
  private _open = false;

  /** Called when the user clicks Log Out. Wire from the active scene. */
  onLogOut: (() => void) | null = null;
  /** Called when the user clicks Toggle Fullscreen. Wire from the active scene. */
  onToggleFullscreen: (() => void) | null = null;
  /** Called when the user clicks Sound. Wire from the active scene. */
  onSound: (() => void) | null = null;

  get isOpen(): boolean { return this._open; }

  constructor() {
    this.panel = document.createElement("div");
    Object.assign(this.panel.style, PANEL_CSS);

    const header = document.createElement("div");
    Object.assign(header.style, HEADER_CSS);
    const title = document.createElement("span");
    title.textContent = "Settings";
    const closeBtn = document.createElement("button");
    Object.assign(closeBtn.style, CLOSE_BTN_CSS);
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => this.close());
    header.appendChild(title);
    header.appendChild(closeBtn);
    this.panel.appendChild(header);

    this.addItem("Log Out", () => {
      this.close();
      if (this.onLogOut) this.onLogOut();
      else debug.log(["ui"], "[SettingsMenu] Log Out: no handler set", 2);
    });
    this.addItem("Toggle Fullscreen", () => {
      if (this.onToggleFullscreen) this.onToggleFullscreen();
      else debug.log(["ui"], "[SettingsMenu] Toggle Fullscreen: not implemented", 2);
    });
    this.addItem("Sound", () => {
      if (this.onSound) this.onSound();
      else debug.log(["ui"], "[SettingsMenu] Sound: not implemented", 2);
    });
  }

  private addItem(label: string, onClick: () => void): void {
    const btn = document.createElement("button");
    Object.assign(btn.style, ITEM_CSS);
    btn.textContent = label;
    btn.addEventListener("mouseover", () => { btn.style.background = ITEM_HOVER_BG; });
    btn.addEventListener("mouseout", () => { btn.style.background = "none"; });
    btn.addEventListener("click", onClick);
    this.panel.appendChild(btn);
  }

  toggle(): void {
    if (this._open) this.close(); else this.open();
  }

  open(): void {
    if (this._open) return;
    const host = document.getElementById(HOST_ID) ?? document.body;
    host.appendChild(this.panel);
    this._open = true;
  }

  close(): void {
    if (!this._open) return;
    this.panel.remove();
    this._open = false;
  }

  destroy(): void {
    this.close();
  }
}
