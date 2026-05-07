# AGENT.md

## Purpose
Pointer- and key-event router. Listens to DOM events on the canvas (pointer)
and `window` (keys), runs a tiny pointer state machine, hit-tests **only at
down and up** (not on every move — that's expensive), and emits semantic
events that downstream consumers (drag manager, click handlers, scene-
specific shortcuts) subscribe to. Scene-scoped — owned by `GameScene`.

## Important files
- `InputManager.ts`: pointer + key event router. Constructor `(canvas, hitRoot: LayoutNode)`. Subscribe to pointer events via `on(event, listener)` and key events via `onKey(event, listener)`; both return unsubscribe fns. Exposes `lastPointer: { x, y }` updated on every `pointermove` so per-frame consumers (e.g. `WorldPanManager`) can read the live cursor without subscribing.
- `DragManager.ts`: drag orchestrator. Subscribes to `left_drag_start` / `left_drag_stop`; while dragging, owns its own `pointermove` listener on the canvas (attached on start, detached on stop) so per-move cost is paid only during an active drag. Reads `data.hit` to identify draggable cards (loose `GameRectCard` only); writes new `microLocation` via `setClient` on each move.

## Events
### Pointer (left button)
- **`left_down`** — pointerdown, button 0. Payload: `PointerEventData` (`x, y, hit, t`).
- **`left_drag_start`** — pointermove crosses `DRAG_THRESHOLD_PX` (5px) while pressed. Payload: the original `PointerEventData` from down (no fresh hit-test on moves).
- **`left_up`** — pointerup (always, regardless of click vs drag). Payload: `{ down, up }` — both endpoints of the gesture.
- **`left_click`** — pointerup AND no drag occurred. Payload: `{ down, up }`.
- **`left_drag_stop`** — pointerup AND a drag was in progress. Payload: `{ down, up }`.

### Keyboard
- **`key_down`** / **`key_up`** — payload: `{ key, code }` (the `KeyboardEvent.key` and `.code` fields). Listeners get `code` for layout-independent matches (e.g. `code === "KeyE"`) and `key` for character-driven matches.

## Conventions
- **Hit-tests run only at `down` and `up`.** Pointermoves only check distance for drag-detection and update `lastPointer` — no hit-test, no event, no allocation. Continuous follow-the-cursor work is a consumer concern (DragManager attaches its own pointermove only while dragging).
- **Up-time events carry both endpoints.** `left_up`, `left_click`, `left_drag_stop` payloads are `{ down: PointerEventData; up: PointerEventData; }`. Drag manager has source (down's hit) AND drop target (up's hit) in one event.
- **`hit` is freshly computed** at down and up. A node hit at `left_down` may be missing at `left_up` (e.g. card destroyed mid-drag). Subscribers must handle `hit === null`.
- **Pointer capture on down.** `canvas.setPointerCapture(pointerId)` so a drag that wanders off the canvas keeps delivering events. Released on up/cancel.
- **Left button only for now.** `e.button === 0` is the gate. Right and middle wire up later via `right_*` / `middle_*` event prefixes.
- **Key events bind on `window`, not the canvas.** Keys arrive even when focus is elsewhere on the page; the consumer decides whether that matters. Don't filter by focus inside InputManager.
- **Listener errors are caught and logged** — one bad listener can't break the dispatch loop.

## Pitfalls
- Re-entrant `pointerdown` while already pressed/dragging is ignored. If a second pointer (multi-touch) fires down, the existing gesture continues; the new touch is dropped. Multi-touch / multi-button is a separate design.
- `lastPointer` stays at `(0, 0)` until the first `pointermove`. Consumers that read it cold (no prior pointer activity) must handle the origin sentinel; in practice, anything reading it inside a drag has already seen many moves.
- `dispose()` removes listeners and releases capture. Call it from `GameScene.onExit` **before** destroying the layout root — a hit test against a destroyed root would crash.
- Events are dispatched synchronously inside the DOM event handler. Listener work that blocks (heavy compute, sync XHR) will jank the input thread. Keep listeners light; queue heavy work to the next frame.
- Pointermove handler is intentionally minimal (no hit-test). When we add continuous-drag support on a non-DragManager path, do it in a way that lets consumers opt in — don't make every move pay the hit-test cost just because one consumer wants drag tracking.
