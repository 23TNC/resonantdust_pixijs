/**
 * Minimal DOM overlay for the login / create-user form. Lives inside
 * `#app` (the same host the PixiJS canvas is appended to in `main.ts`),
 * absolutely positioned and centered over the canvas via CSS transform
 * so it stays put on canvas resize without per-frame layout math.
 *
 * Scope: this is the ONE place the codebase touches DOM input elements.
 * Swapping in a Pixi-native form later only requires replacing the
 * `LoginScene` body — no other module reads or references the overlay.
 *
 * Style is inline so the overlay is self-contained (no external CSS
 * file, no class names to keep in sync). The visual approximates the
 * dark game palette but doesn't pull from any shared theme — if/when
 * a theming system arrives this lifts straight in.
 */

const HOST_ID = "app";

const PANEL_CSS: Partial<CSSStyleDeclaration> = {
  position: "absolute",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "24px 32px",
  background: "rgba(20, 22, 30, 0.92)",
  border: "1px solid #3a3a4a",
  borderRadius: "6px",
  color: "#ecd6aa",
  fontFamily: "sans-serif",
  fontSize: "14px",
  minWidth: "280px",
  zIndex: "10",
};

const LABEL_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  fontSize: "12px",
  color: "#a0a0b0",
};

const INPUT_CSS: Partial<CSSStyleDeclaration> = {
  padding: "8px 10px",
  background: "#0b1426",
  border: "1px solid #3a3a4a",
  borderRadius: "3px",
  color: "#ecd6aa",
  fontFamily: "sans-serif",
  fontSize: "14px",
  outline: "none",
};

const BUTTON_CSS: Partial<CSSStyleDeclaration> = {
  padding: "8px 14px",
  background: "#3a3a4a",
  border: "1px solid #5a5a6a",
  borderRadius: "3px",
  color: "#ecd6aa",
  fontFamily: "sans-serif",
  fontSize: "14px",
  cursor: "pointer",
};

const STATUS_CSS: Partial<CSSStyleDeclaration> = {
  fontSize: "12px",
  color: "#a0a0b0",
  minHeight: "16px",
};

const BUTTON_ROW_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  gap: "8px",
  marginTop: "4px",
};

export class FormOverlay {
  readonly panel: HTMLDivElement;
  private readonly buttonRow: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private mounted = false;

  constructor() {
    this.panel = document.createElement("div");
    Object.assign(this.panel.style, PANEL_CSS);

    this.buttonRow = document.createElement("div");
    Object.assign(this.buttonRow.style, BUTTON_ROW_CSS);

    this.status = document.createElement("div");
    Object.assign(this.status.style, STATUS_CSS);
  }

  /** Insert the overlay into the canvas host. Idempotent — calling
   *  twice without `unmount` in between is a no-op. */
  mount(): void {
    if (this.mounted) return;
    const host = document.getElementById(HOST_ID) ?? document.body;
    host.appendChild(this.panel);
    this.mounted = true;
  }

  /** Remove the overlay from the DOM. Safe to call multiple times. */
  unmount(): void {
    if (!this.mounted) return;
    this.panel.remove();
    this.mounted = false;
  }

  /** Clear the panel's contents (between mode switches). Preserves
   *  the panel element itself so its DOM identity / focus state
   *  scope isn't disturbed. */
  clear(): void {
    while (this.panel.firstChild) {
      this.panel.removeChild(this.panel.firstChild);
    }
    // The button row is a reusable child of `panel` — removed above
    // by the firstChild walk, but its OWN children (the buttons from
    // the prior mode) survive in detached form. Drop them too,
    // otherwise the next `addButton` call re-appends the row to the
    // panel still carrying its stale buttons → mode-switching
    // accumulates buttons on each render.
    while (this.buttonRow.firstChild) {
      this.buttonRow.removeChild(this.buttonRow.firstChild);
    }
  }

  /** Append a label + input pair. Returns the input so the caller
   *  can read/write `value`, focus(), or wire keydown handlers. */
  addInput(label: string, type: "text" | "password", initial = ""): HTMLInputElement {
    const wrap = document.createElement("label");
    Object.assign(wrap.style, LABEL_CSS);
    wrap.textContent = label;

    const input = document.createElement("input");
    input.type = type;
    input.value = initial;
    input.autocomplete = "off";
    Object.assign(input.style, INPUT_CSS);

    wrap.appendChild(input);
    this.panel.appendChild(wrap);
    return input;
  }

  /** Append a button. Buttons share a horizontal row at the bottom
   *  of the panel — the row is created lazily on the first call so
   *  panels without buttons (degenerate) don't accumulate empty
   *  rows. */
  addButton(label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
    if (!this.buttonRow.isConnected) {
      this.panel.appendChild(this.buttonRow);
    }
    const button = document.createElement("button");
    button.textContent = label;
    Object.assign(button.style, BUTTON_CSS);
    button.addEventListener("click", (e) => {
      e.preventDefault();
      void onClick();
    });
    this.buttonRow.appendChild(button);
    return button;
  }

  /** Append (or re-show) the status line at the bottom of the panel.
   *  Called automatically by `setStatus` if not already attached, so
   *  callers don't have to remember to add it. */
  attachStatus(): void {
    if (!this.status.isConnected) {
      this.panel.appendChild(this.status);
    }
  }

  /** Update the status line text. `tone` picks a color: `"info"` is
   *  the muted default, `"error"` is red, `"success"` is green. */
  setStatus(text: string, tone: "info" | "error" | "success" = "info"): void {
    this.attachStatus();
    this.status.textContent = text;
    this.status.style.color =
      tone === "error" ? "#e07a7a" :
      tone === "success" ? "#7ae07a" :
      "#a0a0b0";
  }
}
