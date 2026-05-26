# AGENTS.md

## Purpose
Chat / logs panel — a DOM-based two-tab surface for live `chat_messages` (general) and client-only flavor text events (logs). Built on `ui/dom/DomPanel`, registered with the bottom `PanelTaskbar` as a pinned entry. Scene-scoped: instantiated by `MainScene` (not by `MainLayout`) since it's a DOM surface, not a Pixi layout node.

## Important files
- `ChatPanel.ts`: thin wrapper around a `DomPanel`. Two `addTab` registrations — 💬 general + 📜 logs — each backed by its own scrollable `<div>`. A footer slot (via `panel.setFooter`) holds the chat `<input>`. Persists position/size/active-tab/etc. under `chatPanel.*`. On `destroy()` unsubscribes from `chatMessages` + `logs`, tears down the server chat subscription, and lets `DomPanel.destroy()` remove the DOM nodes.
- `LogManager.ts`: scene-scoped ring buffer (cap 200 entries) of client-only flavor-text events. Game systems call `push(text)`; the chat panel's logs tab re-renders from `getAll()` on every push. `subscribe(listener)` fires with no payload on every push. `dispose()` clears entries and listeners. Lives on `ctx.logs` (set in `MainScene.onEnter`, nulled in `onExit`).

## Chat subscription model
On construction the chat panel resolves the session's threshold: if `player.lastLoginSecs` falls within the server's 1-hour retention window the threshold is that timestamp (so the user sees what they missed); otherwise it's "now" (no scrollback). The threshold is packed into the `sent_at` coord space — `(thresholdSecs * 1000) << 16`. It subscribes via `data.chatSubscriptions.subscribeChat(thresholdPacked)` and bumps `last_login_secs` via `reducers.setLastLogin()` so the next session's threshold covers this one. `destroy()` calls `data.chatSubscriptions.unsubscribeChat()`.

## Conventions
- **DOM all the way down.** No Pixi `LayoutNode`, no atlased `Text` pool, no custom scrollbar — the browser's native scroll container handles everything. Messages are plain `<div>`s appended to the active tab's content. The input is a regular `<input type="text">`.
- **One DOM node per chat message; pool isn't needed.** Browser DOM handles thousands of rows fine for this workload. The map `generalRows: Map<bigint, HTMLDivElement>` exists so a retention sweep (`onChatChange("removed", key, …)`) can drop the matching row without re-rendering the entire feed.
- **Logs tab re-renders in full on each push.** The log buffer is push-only and short (≤200 entries); the incremental-append bookkeeping wasn't worth it. `getAll()` → wipe content → append all rows.
- **Auto-scroll only when pinned.** Before appending a new chat message, check `isPinnedToBottom(scrollContainer)` (within `AUTO_SCROLL_EPSILON = 4 px`); only then scroll to bottom after the append. If the user has scrolled up to read history, new messages don't yank them back down.
- **Owned by `MainScene`, not `MainLayout`.** `MainLayout` is the Pixi layout tree; the DOM chat panel doesn't belong there. `MainScene.onEnter` constructs it after `ctx.logs` is wired (the chat panel subscribes to logs in its constructor and needs the manager present).
- **Pinned in the bottom taskbar.** Constructor passes `taskbar: ctx.taskbar, pinned: true` so chat always has an entry on the bottom bar — clicking the entry restores from minimize or refocuses, and the entry stays put when chat is closed so the user can re-open it.

## Pitfalls
- **`ctx.logs` must exist before constructing `ChatPanel`.** The constructor calls `ctx.logs.subscribe(...)` for the logs tab. `MainScene.onEnter` sets `ctx.logs = new LogManager()` *before* instantiating chat — flipping that order leaves the logs tab unsubscribed (no error, just silent).
- **The chat subscription threshold is computed in the constructor.** Mounting the panel doesn't issue the subscription — construction does. If you defer construction (e.g., lazy "first opens chat") the threshold reflects deferred-time, not scene-enter time. The current eager construction matches the historical "subscribe on scene enter" behavior.
- **DOM panel body is `pointer-events: auto`.** Unlike `PixiPanel`, the chat panel needs to receive scroll wheel + click events on its messages and input. Don't override `body.style.pointerEvents` here.
- **Don't destroy `LogManager` before `ChatPanel`.** `MainScene.onExit` order matters: tear down chat first (so its `unsubLogs()` runs while the listener set is still live), then dispose the log manager.
