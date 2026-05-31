import { debug } from "../../../debug";
import { DomPanel } from "../../../ui/dom/DomPanel";
import type { PanelTaskbar } from "../../../ui/dom/PanelTaskbar";
import type { UiEditMode } from "../../../ui/dom/UiEditMode";
import { panelTitle, panelText } from "../panelStrings";

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
 * Settings dropdown that drops down from the title-bar ⛯ icon. Built
 * on `DomPanel` for drag / persistence / close — settings has no tabs
 * and no resize / minimize, so it uses `setBody` to drop a vertical
 * list of action buttons into the panel body.
 *
 * Callback properties (e.g. `onLogOut`) default to a debug-log no-op
 * and can be wired by whichever scene is currently active. Reset them
 * to `null` in `onExit` if they capture scene-local state.
 */
export class SettingsMenu {
  private readonly panel: DomPanel;
  private readonly editModeBtn: HTMLButtonElement;
  private readonly uiEditMode: UiEditMode | null;
  private readonly unsubUiEditMode: (() => void) | null;

  /** Called when the user clicks Log Out. Wire from the active scene. */
  onLogOut: (() => void) | null = null;
  /** Called when the user clicks Toggle Fullscreen. Wire from the active scene. */
  onToggleFullscreen: (() => void) | null = null;
  /** Called when the user clicks Sound. Wire from the active scene. */
  onSound: (() => void) | null = null;

  get isOpen(): boolean { return this.panel.isOpen; }

  constructor(taskbar?: PanelTaskbar, uiEditMode?: UiEditMode) {
    this.uiEditMode = uiEditMode ?? null;
    this.panel = new DomPanel({
      title: panelTitle("settingsMenu"),
      storageKey: "settingsMenu",
      defaultRect: { right: "0", top: "32px", width: "200px" },
      resizable: false,
      minimizable: false,
      taskbar,
      pinned: true,
      taskbarIcon: "⛯",
      taskbarSide: "right",
      // Deliberately omit `uiEditMode` for the settings menu — the
      // user is *toggling* edit mode from this dropdown; the
      // dropdown itself doesn't need grid-snap / lock buttons on
      // its own chrome.
    });

    const body = document.createElement("div");
    this.editModeBtn = this.addItem(body, this.editModeLabel(), () => {
      // No-op if the manager wasn't wired — keeps the dropdown
      // useful even in degenerate setups.
      this.uiEditMode?.toggle();
    });
    this.addItem(body, panelText("settingsMenu", "resetPanels"), () => {
      // Recovery escape hatch for the "I dragged chat off-screen
      // and can't find it" case. Sweeps every live `DomPanel`
      // back to its constructor-defined position / size / toggle
      // defaults. Closes the menu after so the user can see the
      // result.
      DomPanel.resetAllToDefaults();
      this.panel.close();
    });
    this.addItem(body, panelText("settingsMenu", "logOut"), () => {
      this.panel.close();
      if (this.onLogOut) this.onLogOut();
      else debug.log(["ui"], "[SettingsMenu] Log Out: no handler set", 2);
    });
    this.addItem(body, panelText("settingsMenu", "toggleFullscreen"), () => {
      if (this.onToggleFullscreen) this.onToggleFullscreen();
      else debug.log(["ui"], "[SettingsMenu] Toggle Fullscreen: not implemented", 2);
    });
    this.addItem(body, panelText("settingsMenu", "sound"), () => {
      if (this.onSound) this.onSound();
      else debug.log(["ui"], "[SettingsMenu] Sound: not implemented", 2);
    });
    this.panel.setBody(body);

    // Keep the edit-mode item's label in sync with the manager so
    // the user can tell what tapping it will do. Mirrors the
    // `Enter / Exit UI Edit Mode` toggle pattern.
    this.unsubUiEditMode = this.uiEditMode
      ? this.uiEditMode.on(() => { this.editModeBtn.textContent = this.editModeLabel(); })
      : null;
  }

  private editModeLabel(): string {
    if (!this.uiEditMode) return panelText("settingsMenu", "editModeUnavailable");
    return this.uiEditMode.enabled
      ? panelText("settingsMenu", "exitEditMode")
      : panelText("settingsMenu", "enterEditMode");
  }

  private addItem(parent: HTMLDivElement, label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    Object.assign(btn.style, ITEM_CSS);
    btn.textContent = label;
    btn.addEventListener("mouseover", () => { btn.style.background = ITEM_HOVER_BG; });
    btn.addEventListener("mouseout",  () => { btn.style.background = "none"; });
    btn.addEventListener("click", onClick);
    parent.appendChild(btn);
    return btn;
  }

  toggle(): void { this.panel.toggle(); }
  open():   void { this.panel.open();   }
  close():  void { this.panel.close();  }
  destroy(): void {
    this.unsubUiEditMode?.();
    this.panel.destroy();
  }
}
