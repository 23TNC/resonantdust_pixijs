# AGENTS.md

## Purpose
Shared DOM-based UI primitives. Every floating / dockable surface in the app (chat, debug HUD, settings menu, character-select chooser, taskbars) is built on these — the DOM side owns drag / resize / minimize / close / persistence, and consumers add either DOM content or Pixi content through narrow extension points. The bottom-of-screen "Windows-style" taskbars + the UI-edit-mode workflow also live here.

## Important files

### Panel infrastructure
- `DomPanel.ts`: the core class. A `position: fixed` DOM div with title bar (drag handle), optional tab strip, body, optional footer, optional resize corner, and an absolute-positioned actions container (minimize / close). Tabs and body content are caller-supplied DOM elements; events (`onOpenChange`, `onMinimizeChange`, `onAnchorChange`, `onMinimizableChange`, `onFocus`, `onRectChange`, `onTabChange`) propagate state changes. Persists position/size/active-tab/minimized/lock-and-anchor/grid-snap/title-bar-hidden/minimize-toggle/resize-toggle to `localStorage` under `${storageKey}.*`. Module-level `allPanels: Set<DomPanel>` registry powers the static `resetAllToDefaults()` — the "I lost a panel" recovery escape hatch surfaced in the settings menu.
- `DomPanelStyles.ts`: every inline CSS constant (`PANEL_CSS`, `TITLEBAR_CSS`, `TABS_CSS`, `BODY_CSS`, etc.) plus the per-corner resize-handle CSS helper `resizeCornerCssFor("tl"|"tr"|"bl"|"br")`. Theming changes live here — `DomPanel` never inlines its own styles.
- `pointerInteractions.ts`: `attachDrag(handle, target, hooks)` + `attachResize(corner, target, opts)`. Document-level pointermove/up listeners so gestures survive the cursor leaving the handle. Hooks: `shouldStart` (gate — receives the `PointerEvent` so callers can skip drag based on target), `snapGrid` (per-tick grid info for snap-to-grid), `corner` (per-tick grab-corner for anchor-aware resize), `onMove` / `onEnd`.
- `PixiPanel.ts`: subclass that hosts a Pixi `LayoutNode` (`content`) mirrored to the DOM panel's body rect, plus two more Pixi nodes that paint the visible chrome over the (now-transparent) DOM equivalents: `chrome` (title bar backdrop + title text + minimize / close glyphs) and `resizeIndicator` (the 14×14 grip in the corner). The DOM title bar, action buttons, and resize corner remain in the layout but their `background` / `color` are flipped to transparent — they still own drag + click capture, but the *visible* chrome is the Pixi nodes. Reason: card visuals in `MainLayout.overlay` (zIndex 1000) can now draw above the chrome during drag, which they couldn't when the chrome was DOM-composited above the canvas. PixiPanels are end-to-end Pixi-rendered; only `DomPanel` instances with DOM content (chat, debug, settings) draw chrome through the browser. Re-positions the resize corner to the corner opposite the anchor (so resizing keeps the anchored corner stationary). Mask is optional (`masked: false` skips the ~3 draw-call cost of stencil masking).
- `PanelTaskbar.ts`: bottom or top viewport-wide bar. Registered `DomPanel`s appear as entries (left or right side, text or single-glyph). Windows-style click semantics: closed pinned → open + focus; minimized → restore + focus; focused → minimize; not-focused → bring to front. Entry visibility rule: show iff `panel.isMinimizable || panel.pinned`.
- `PanelSettingsPopup.ts`: the "Panel Settings" popover. Built once per session, re-binds to whichever panel got its body clicked while UI edit mode is on. Rows: Title bar (▣/▢), Grid snap (▣/▢), Anchor (`CyclingSelect`), Minimize (▣/▢), Resize (▣/▢), Layer (🞁 🞃), Reset (↺).
- `CyclingSelect.ts`: generic `CyclingSelect<T>` component — ◀ label ▶, arrows hide at the ends (via `visibility: hidden` so the label stays centered). `labelMinWidth` lets callers fix the label width when option labels vary.
- `UiEditMode.ts`: app-wide edit-mode flag + shared grid geometry. `getGrid()` reads the live viewport and divides the safe area (between `reservedTop` and `reservedBottom`) into whole cells around `gridSize` — cells **exactly tile** the area so snapped panels never partially overlap a taskbar. Holds a reference to the `PanelSettingsPopup` (attached from `main.ts` after construction to break the import cycle `UiEditMode → popup → DomPanel → UiEditMode`).

## Wiring (main.ts → GameContext)
```
const taskbar      = new PanelTaskbar({ position: "bottom" });
const topTaskbar   = new PanelTaskbar({ position: "top" });
const uiEditMode   = new UiEditMode({ reservedTop: …, reservedBottom: … });
const panelSettingsPopup = new PanelSettingsPopup();
uiEditMode.settingsPopup = panelSettingsPopup;
uiEditMode.on(enabled => { if (!enabled) panelSettingsPopup.close(); });

const debugPanel   = new DebugPanel(topTaskbar, uiEditMode);
const settingsMenu = new SettingsMenu(topTaskbar, uiEditMode);
```
All five sit on `ctx.{taskbar, topTaskbar, uiEditMode, debugPanel, settingsMenu}` for any scene to reach.

## Conventions

### Lifecycle
- **Construct, then `.open()`.** Constructors only build DOM and wire listeners — they don't append to the host. `open()` mounts under `#app` (fallback `document.body`) and fires `onOpenChange(true)` + `fireRectChange()` so subscribers that registered *before* open get notified.
- **Subscribe before `open()` if you need the initial rect.** `PixiPanel.syncRect` lays out content in response to `rectChange`; consumers like `MainLayout` that mirror the rect into their own children must do the same.
- **`destroy()` is idempotent.** Removes window-resize listener, taskbar registration, every event listener, and clears the `allPanels` slot.

### Drag / resize / chrome
- **Action buttons live inside the title bar.** Absolute-positioned with `top: 50%; transform: translateY(-50%); right: 12px` so they vertical-center against the title bar's box. The title bar's `pointerdown` handler checks `e.target` against `actionsEl.contains(...)` and bails out — button clicks don't initiate drags.
- **Body is `pointer-events: none` only for `PixiPanel`.** Vanilla `DomPanel` bodies stay interactive (chat, debug, settings rows). Subclasses opt out per their needs; `body` is `protected readonly` so they can.
- **Resize corner flips per anchor.** `currentResizeCorner()` returns the corner opposite `_anchor`: top-right anchor → bl handle, bottom-left → tr, etc. The resize math (`attachResize`'s `sx`/`sy` signs) inverts cursor delta accordingly so the anchored corner never moves.
- **Anchor doesn't move the panel.** `applyAnchor` reads the *current* rect and writes whichever CSS anchors keep the panel at that screen position. Switching anchors pins a different corner but the panel stays where it was.

### Persistence
- All persisted keys live under `${storageKey}.*`. Hardcoded suffix list in `resetToDefaults` for auditability.
- All `left` / `top` / `right` / `bottom` are persisted (not just `left` + `top`) so anchored panels survive reload with their corner-pinning CSS intact.

### Z-index
- Module-level counter `nextZIndex` starts at 20; every `bringToFront` increments. No cap — practical session totals stay under 1000.
- Taskbars sit at `zIndex: 9999` so they always sit above floating panels.

### Pointer events vs canvas
- **DOM panel bodies intercept clicks by default.** That's correct for chat / debug / settings (DOM-content panels). For `PixiPanel` it would block clicks from reaching the canvas underneath, so `PixiPanel` flips `body.style.pointerEvents = "none"` in its constructor. Title bar / tabs / action buttons / resize corner remain interactive — they're siblings of the body, not children.

### Update chain
- `onRectChange` fires on: drag, resize, anchor change, minimize/restore, **`open()`**, **window resize**. The last two were added so `PixiPanel.content` (and any external subscriber mirroring the panel's rect) sees correct bounds from mount, and re-flows on viewport reflow.
- `PixiPanel.content` is a base `LayoutNode` — it doesn't auto-size its children. Consumers add a single child and explicitly `setBounds(0, 0, content.width, content.height)` in their `onRectChange` callback (see `MainLayout`).

## Pitfalls

- **Import cycle around `UiEditMode`.** `UiEditMode` references `PanelSettingsPopup` (which references `DomPanel`, which references `UiEditMode`). Broken by `UiEditMode.settingsPopup` being typed as a forward-declared interface (`PanelSettingsPopupLike`), populated from `main.ts` after construction.
- **Settings menu and debug HUD constructors need both `taskbar` and `uiEditMode`.** Their `DomPanel` constructor takes `uiEditMode` for the panel-click → settings-popup flow, and the constructor's outer wrapper takes the `taskbar` to register the pinned entry. Passing `undefined` makes those features silently degrade.
- **PixiPanel's parent must be transform-free.** The DOM `getBoundingClientRect()` returns viewport-pixel coords. PixiPanel pipes those straight into `content.setBounds` — if the parent has scale/pan, content lands at the wrong place. Use a scene-root `LayoutNode` parented under a Pixi container that's at `(0,0)`.
- **`pointer-events: none` on PixiPanel body breaks edit-mode click-anywhere.** Inside edit mode, clicking the body of a PixiPanel passes through to the canvas instead of opening the settings popup. The user can still open the settings popup via the title bar (or any other DomPanel chrome that bubbles to `panel.click`). The "click anywhere" semantic only fully works for vanilla `DomPanel`s with interactive bodies.
- **Anchored panels can't be closed via UI.** `refreshChrome` hides minimize + close while `isAnchored`. The user has to un-anchor first (from the settings popup) before they can close.
- **Locked → anchor transition is what `setAnchor` does now.** There used to be a separate "lock" toggle; it was replaced by the `Anchor` cycler. `isAnchored = anchor !== "none"`. The taskbar's "pinned launchers always show" exception is what keeps the settings menu visible despite `minimizable: false`.
- **Reset-all-panels is the recovery escape hatch.** Settings → "Reset All Panels" calls `DomPanel.resetAllToDefaults()` which iterates `allPanels` and clears every persisted key, restoring each panel to its constructor `defaultRect`. Use this when a panel ends up off-screen, anchored where it can't be reached, or locked in a bad state.
