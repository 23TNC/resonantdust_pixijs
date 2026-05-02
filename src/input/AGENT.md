# AGENT.md

## Purpose
Pointer-event router. Listens to DOM pointer events on the canvas, runs a tiny state machine, hit-tests **only at down and up** (not on every move — that's expensive), and emits semantic events that downstream consumers (drag manager, click handlers) subscribe to. Scene-scoped — owned by `GameScene`.

## Important files
- `InputManager.ts`: the one class. Constructor `(canvas, hitRoot: LayoutNode)`. Subscribe via `on(event, listener)`; returns an unsubscribe fn.

## Events
- **`left_down`** — pointerdown, button 0. Payload: `PointerEventData` (`x, y, hit, t`).
- **`left_drag_start`** — pointermove crosses `DRAG_THRESHOLD_PX` while pressed. Payload: the original `PointerEventData` from down (no fresh hit-test on moves).
- **`left_up`** — pointerup (always, regardless of click vs drag). Payload: `{ down, up }` — both endpoints of the gesture.
- **`left_click`** — pointerup AND no drag occurred. Payload: `{ down, up }`.
- **`left_drag_stop`** — pointerup AND a drag was in progress. Payload: `{ down, up }`.

## Conventions
- **Hit-tests run only at `down` and `up`.** Pointermoves only check distance for drag-detection — no hit-test, no event, no allocation. Continuous drag (following the cursor) is a separate concern; we'll wire it correctly when the drag manager lands.
- **Up-time events carry both endpoints.** `left_up`, `left_click`, `left_drag_stop` payloads are `{ down: PointerEventData; up: PointerEventData; }`. Drag manager has source (down's hit) AND drop target (up's hit) in one event.
- **`hit` is freshly computed** at down and up. A node hit at `left_down` may be missing at `left_up` (e.g. card destroyed mid-drag). Subscribers must handle `hit === null`.
- **Pointer capture on down.** `canvas.setPointerCapture(pointerId)` so a drag that wanders off the canvas keeps delivering events. Released on up/cancel.
- **Left button only for now.** `e.button === 0` is the gate. Right and middle wire up later via `right_*` / `middle_*` event prefixes.
- **Listener errors are caught and logged** — one bad listener can't break the dispatch loop.

## Pitfalls
- Re-entrant `pointerdown` while already pressed/dragging is ignored. If a second pointer (multi-touch) fires down, the existing gesture continues; the new touch is dropped. Multi-touch / multi-button is a separate design.
- `dispose()` removes listeners and releases capture. Call it from `GameScene.onExit` **before** destroying the layout root — a hit test against a destroyed root would crash.
- Events are dispatched synchronously inside the DOM event handler. Listener work that blocks (heavy compute, sync XHR) will jank the input thread. Keep listeners light; queue heavy work to the next frame.
- Pointermove handler is intentionally minimal (no hit-test). When we add continuous-drag support, do it in a way that lets consumers opt in — don't make every move pay the hit-test cost just because one consumer wants drag tracking.
