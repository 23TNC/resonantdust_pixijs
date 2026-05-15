# AGENTS.md

## Purpose
Bottom-left chat/logs panel. Two tabs: **general** (live server-backed `chat_messages`) and **logs** (client-only flavor-text events pushed by game systems). Resizable by dragging the top-right corner handle. Scene-scoped: constructed in `GameLayout` before `InputManager` exists; subscriptions to input events are deferred to the first `layout()` pass.

## Important files
- `ChatPanel.ts`: the main `LayoutNode`. Tab strip, scrollable message body (pooled `Text` instances, mask-clipped), HTML `<input>` for chat entry, drag-to-scroll scrollbar, resize handle. Exposes `preferredWidth` / `preferredHeight` so `GameLayout` clamps and sizes it. On `destroy()` tears down the SpacetimeDB chat subscription, removes the HTML `<input>` element, and drops all `InputManager` listeners.
- `LogManager.ts`: scene-scoped ring buffer (cap 200 entries) of client-only flavor-text events. Game systems call `push(text)`; `ChatPanel`'s logs tab renders `getAll()`. `subscribe(listener)` fires with no payload on every push. `dispose()` clears entries and listeners. Lives on `ctx.logs` (set in `GameScene.onEnter`, nulled in `onExit`).

## Chat subscription model
`subscribeInput` (called once on the first `layout()` pass that finds `ctx.input != null`) issues `data.subscriptions.subscribeChat(thresholdPacked)`, where `threshold` is the session's `last_login_secs` if it falls within the server's 1-hour retention window, otherwise "now". After subscribing it calls `reducers.setLastLogin()` so the next session's threshold covers this one. Torn down in `destroy()` via `data.subscriptions.unsubscribeChat()`.

## Conventions
- **Input subscriptions are deferred.** `ChatPanel` is constructed inside `GameLayout` before `GameScene` creates `InputManager` (`ctx.input` is null at that point). The first `layout()` pass that finds `ctx.input != null` calls `subscribeInput()` once and sets `subscriptionsWired = true`. Nothing else tries to subscribe at construction time.
- **Pool-based Text rendering.** `generalTexts` / `logsTexts` are grown as needed and reused across re-renders — `visible = false` hides unused pool slots. Never allocate a new `Text` per message on each render.
- **Messages stack bottom-up.** Most-recent message anchors at the body's bottom edge; older messages accumulate above. `scrollOffset = 0` means "newest visible" — positive offset reveals older content toward the top.
- **Scroll offset snaps to `LINE_HEIGHT` (18 px)** so rows always sit on the same y-grid regardless of panel resize.
- **HTML `<input>` for text entry.** Uses `document.createElement("input")` pinned via `position: fixed` — the same pattern as `FormOverlay` in the login scene. `repositionInput` walks the `LayoutNode` parent chain to accumulate global stage coords. Stage coords are already CSS pixels when `autoDensity` is on (`main.ts`).
- **Scrollbar geometry is cached per render.** `applyScrollbarGeometry` caches `activeMaxScroll` / `activeTrackHeight` / `activeThumbHeight` so the drag-scroll handler can convert thumb-pixel motion back into a scroll offset delta without re-deriving the layout.

## Pitfalls
- **`ctx.input` is null at construction.** Never subscribe to `InputManager` events in the constructor; the lazy `layout()` wire-up is the only safe point.
- **HTML input DPR alignment.** `repositionInput` does NOT multiply by `rect.width / canvas.width` — that ratio equals 1 in CSS-pixel mode (`autoDensity` on) and would misalign at non-1× DPR. Stage coords are already CSS pixels.
- **`wheel` handler requires `passive: false`.** `addEventListener("wheel", handler, { passive: false })` is required to call `e.preventDefault()` and suppress page scroll. Omitting `{ passive: false }` silently fails in Chrome.
- **`LogManager` is disposed before `ChatPanel.destroy()`.** `GameScene.onExit` calls `ctx.logs.dispose()` (and sets `ctx.logs = null`) before tearing down `GameLayout`. The `unsubLogs?.()` call in `ChatPanel.destroy()` is safe — the listener was already dropped by `dispose()` — but any post-`onExit` access to `ctx.logs` must null-check.
