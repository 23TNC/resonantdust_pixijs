import { DomPanel } from "../../ui/dom/DomPanel";
import type { UiEditMode } from "../../ui/dom/UiEditMode";

/**
 * Login / create-user form. The chrome (background, border,
 * positioning, mount / unmount lifecycle) comes from `DomPanel`
 * with the title bar hidden — a centered, non-draggable modal-ish
 * surface. The form-specific API (`addInput`, `addButton`,
 * `setStatus`, …) lives on this class.
 *
 * Scope: this is the only place the codebase touches DOM input
 * elements. Swapping in a Pixi-native form later only requires
 * replacing the `LoginScene` body — no other module reads or
 * references the overlay.
 */
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

const BODY_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "24px 32px",
  minWidth: "280px",
};

export class FormOverlay {
  private readonly panel: DomPanel;
  private readonly body: HTMLDivElement;
  private readonly buttonRow: HTMLDivElement;
  private readonly status: HTMLDivElement;

  constructor(uiEditMode?: UiEditMode) {
    this.panel = new DomPanel({
      // Title is unused because `showTitleBar: false` hides the bar
      // entirely. Keeping it non-empty avoids any DOM-tools display
      // glitches if a debug surface ever reflects panel titles.
      title: "Login",
      showTitleBar: false,
      minimizable: false,
      closable: false,
      resizable: false,
      defaultRect: { left: "50%", top: "50%" },
      // Hand the edit-mode manager through so the user can
      // click the form in edit mode and tweak it via the
      // shared `PanelSettingsPopup` (anchor / snap / etc.) —
      // same surface every other panel exposes.
      uiEditMode,
    });
    // Classic centering trick — top-left at viewport center, then
    // translate back by half the panel's own size. `DomPanelRect`
    // doesn't carry `transform` (it's not really a rect property),
    // so set it on the underlying element directly.
    this.panel.panel.style.transform = "translate(-50%, -50%)";

    this.body = document.createElement("div");
    Object.assign(this.body.style, BODY_CSS);
    this.panel.setBody(this.body);

    this.buttonRow = document.createElement("div");
    Object.assign(this.buttonRow.style, BUTTON_ROW_CSS);

    this.status = document.createElement("div");
    Object.assign(this.status.style, STATUS_CSS);
  }

  /** Mount the form into the canvas host. Idempotent. */
  mount(): void { this.panel.open(); }

  /** Remove the form from the DOM. Safe to call multiple times. */
  unmount(): void { this.panel.close(); }

  /** Clear the form's contents between mode switches. Preserves the
   *  outer panel + body elements so DOM identity / focus scope
   *  isn't disturbed. */
  clear(): void {
    while (this.body.firstChild) {
      this.body.removeChild(this.body.firstChild);
    }
    // The button row is a reusable child of `body` — removed above
    // by the firstChild walk, but its OWN children (the buttons
    // from the prior mode) survive in detached form. Drop them too
    // so the next `addButton` doesn't re-append the row carrying
    // stale buttons.
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
    this.body.appendChild(wrap);
    return input;
  }

  /** Append a button to the bottom-of-form row. The row is added
   *  lazily on the first call so forms without buttons don't carry
   *  an empty row. */
  addButton(label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
    if (!this.buttonRow.isConnected) {
      this.body.appendChild(this.buttonRow);
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

  /** Append (or re-show) the status line at the bottom of the form.
   *  Called automatically by `setStatus` if not already attached. */
  attachStatus(): void {
    if (!this.status.isConnected) {
      this.body.appendChild(this.status);
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
