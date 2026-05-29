# AGENTS.md

## Purpose
Two DOM dropdown panels pinned to the top `PanelTaskbar`: `DebugPanel` (📊, performance / sync HUD) and `SettingsMenu` (⛯, log out / fullscreen / sound + UI edit mode toggle + reset-all-panels). Both are built on `ui/dom/DomPanel` — this directory predates the panel infrastructure rewrite, the name stuck.

> **Heads-up:** the old Pixi `TitleBar` `LayoutNode` is gone. The top "title bar" you see in the running app is the top `PanelTaskbar` plus these two pinned-icon dropdowns. There's no scene-owned title-bar Pixi component any more — see [`ui/dom/AGENTS.md`](../../ui/dom/AGENTS.md) for the replacement.

## Important files
- `DebugPanel.ts`: bound to the top taskbar as a pinned 📊 entry (right side). Three tabs (ⓘ main / 🔍 textures / 🛰 sync) listing the FPS / draw-call / atlas-occupancy / time-sync readouts. `setStats(deltaMS, drawCalls, atlasStats?, syncStats?)` is the per-frame entry point — smooths FPS internally, skips DOM writes when the panel is closed. Built once in `main.ts`, persists across scenes on `ctx.debugPanel`.
- `SettingsMenu.ts`: bound to the top taskbar as a pinned ⛯ entry (right side). Vertical list of action buttons:
  - **Enter / Exit UI Edit Mode** — toggles `ctx.uiEditMode`. Label flips via the menu's `onChange` subscription.
  - **Reset All Panels** — calls `DomPanel.resetAllToDefaults()`; recovery escape hatch for off-screen / wedged panels.
  - **Log Out**, **Toggle Fullscreen**, **Sound** — callback hooks (`onLogOut`, `onToggleFullscreen`, `onSound`) wired per-scene.
  Constructed with `resizable: false, minimizable: false` — it's a dropdown, not a window. Built once in `main.ts`, persists across scenes on `ctx.settingsMenu`.

## Conventions
- Both panels are pinned (`pinned: true`) so their taskbar entries persist even when closed — clicking the ⛯ / 📊 icon re-opens them. The "show entry iff `isMinimizable || pinned`" rule in `PanelTaskbar` is what keeps the settings menu's taskbar entry visible despite `minimizable: false`.
- Both opt into UI edit mode (`uiEditMode: uiEditMode`), so clicking on their bodies while in edit mode opens the shared `PanelSettingsPopup` for layout tweaks. Their own "panel settings popup" would create a loop (settings menu can't be configured from within itself meaningfully), but the system supports it uniformly anyway.
- `SettingsMenu`'s callback hooks (`onLogOut`, `onToggleFullscreen`, `onSound`) default to no-op debug logs. Wire them in scene `onEnter` if you want behavior; reset them to `null` in `onExit` if they capture scene-local state.

## Pitfalls
- **Directory name vs reality.** "titlebar" hasn't held a Pixi title-bar `LayoutNode` since the panel rewrite. Don't go looking for one — search `ui/dom/` instead. If you wanted to add a third pinned dropdown (e.g., an inventory shortcut) following this pattern, you could drop it here; the name is harmless.
- **`DebugPanel.setStats` runs even when the panel is closed.** The instant-FPS accumulator stays current so the next open doesn't show a stale value — but the DOM updates short-circuit on `!panel.isOpen`. That's why every scene's `update` calls `setStats` unconditionally regardless of whether debug is open.
- **`Reset All Panels` is a sledgehammer.** It clears every panel's persisted state and snaps each back to its constructor `defaultRect`. The user should know what they're doing; consider a confirm prompt if you find people clicking it by accident.
