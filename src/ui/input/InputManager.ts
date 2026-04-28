import { getApp } from "@/app";
import { type LayoutObject } from "@/ui/layout/LayoutObject";

// ─── Event data ──────────────────────────────────────────────────────────────

/** Position, hit target, and timestamp captured at a single pointer event. */
export interface InputPointerData {
  x:      number;
  y:      number;
  target: LayoutObject | null;
  time:   number;
}

/** Paired down + up data for events that resolve on release. */
export interface InputActionData {
  down: InputPointerData;
  up:   InputPointerData;
}

/** Current pointer position plus the original down data, emitted during a drag. */
export interface InputDragMoveData {
  x:      number;
  y:      number;
  target: LayoutObject | null;
  time:   number;
  down:   InputPointerData;
}

/** Keyboard event data — modifier state plus key/code from the DOM event. */
export interface InputKeyData {
  /** KeyboardEvent.key — printable character or named key (e.g. "e", "E", "Enter"). */
  key:   string;
  /** KeyboardEvent.code — physical key identifier (e.g. "KeyE", "Enter"). */
  code:  string;
  ctrl:  boolean;
  shift: boolean;
  alt:   boolean;
  time:  number;
}

// ─── Event map ───────────────────────────────────────────────────────────────

export interface InputEventMap {
  left_down:       InputPointerData;
  left_drag_start: InputPointerData;
  left_drag_move:  InputDragMoveData;
  left_drag_end:   InputActionData;
  left_click:      InputActionData;
  left_click_long: InputActionData;
  key_down:        InputKeyData;
  key_up:          InputKeyData;
}

export type InputEventType = keyof InputEventMap;
type Listener<K extends InputEventType> = (data: InputEventMap[K]) => void;

// ─── Options ─────────────────────────────────────────────────────────────────

export interface InputManagerOptions {
  /** Pixels the pointer must move from the down position to start a drag. Default: 6. */
  dragThreshold?: number;
  /** Milliseconds a press must be held (without dragging) to be a long click. Default: 500. */
  longClickMs?:   number;
}

// ─── InputManager ────────────────────────────────────────────────────────────

/**
 * Translates raw pointer events into higher-level input events dispatched to
 * registered listeners via on() / off().
 *
 * Multiple independent listeners can subscribe to the same event.  Different
 * parts of the app (card dragging, UI, tooltips) subscribe separately without
 * coupling to one another.
 *
 * Hit testing calls root.hitTestLayout(x, y) with canvas-local coordinates.
 * pointerdown is captured on the canvas so only in-game clicks start a session;
 * pointermove and pointerup are tracked on window so drags that leave the canvas
 * still resolve correctly.
 *
 * Call destroy() to remove all DOM listeners.
 */
export class InputManager {
  private readonly _root:          LayoutObject;
  private readonly _dragThreshold: number;
  private readonly _longClickMs:   number;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _listeners = new Map<InputEventType, Set<Listener<any>>>();
  private readonly _ignore    = new Set<LayoutObject>();

  private _isDown     = false;
  private _isDragging = false;
  private _downData:  InputPointerData | null = null;

  private readonly _boundPointerDown: (e: PointerEvent) => void;
  private readonly _boundPointerMove: (e: PointerEvent) => void;
  private readonly _boundPointerUp:   (e: PointerEvent) => void;
  private readonly _boundKeyDown:     (e: KeyboardEvent) => void;
  private readonly _boundKeyUp:       (e: KeyboardEvent) => void;

  constructor(root: LayoutObject, options: InputManagerOptions = {}) {
    this._root          = root;
    this._dragThreshold = options.dragThreshold ?? 6;
    this._longClickMs   = options.longClickMs   ?? 500;

    this._boundPointerDown = this._onPointerDown.bind(this);
    this._boundPointerMove = this._onPointerMove.bind(this);
    this._boundPointerUp   = this._onPointerUp.bind(this);
    this._boundKeyDown     = this._onKeyDown.bind(this);
    this._boundKeyUp       = this._onKeyUp.bind(this);

    getApp().canvas.addEventListener("pointerdown", this._boundPointerDown);
    window.addEventListener("pointermove", this._boundPointerMove);
    window.addEventListener("pointerup",   this._boundPointerUp);
    window.addEventListener("keydown",     this._boundKeyDown);
    window.addEventListener("keyup",       this._boundKeyUp);
  }

  destroy(): void {
    getApp().canvas.removeEventListener("pointerdown", this._boundPointerDown);
    window.removeEventListener("pointermove", this._boundPointerMove);
    window.removeEventListener("pointerup",   this._boundPointerUp);
    window.removeEventListener("keydown",     this._boundKeyDown);
    window.removeEventListener("keyup",       this._boundKeyUp);
    this._listeners.clear();
  }

  // ─── Ignore list ─────────────────────────────────────────────────────────

  /**
   * Add a LayoutObject to the ignore set.  Ignored nodes and their entire
   * subtrees are invisible to hit testing until removed.
   *
   * Typical use: add the dragged object on left_drag_start so it does not
   * block the drop target check on left_drag_end, then remove it after.
   */
  addIgnore(obj: LayoutObject): void  { this._ignore.add(obj);    }
  removeIgnore(obj: LayoutObject): void { this._ignore.delete(obj); }
  clearIgnore(): void                 { this._ignore.clear();     }

  // ─── Subscriptions ───────────────────────────────────────────────────────

  on<K extends InputEventType>(event: K, listener: Listener<K>): void {
    let set = this._listeners.get(event);
    if (!set) { set = new Set(); this._listeners.set(event, set); }
    set.add(listener);
  }

  off<K extends InputEventType>(event: K, listener: Listener<K>): void {
    this._listeners.get(event)?.delete(listener);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _emit<K extends InputEventType>(event: K, data: InputEventMap[K]): void {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const listener of set) listener(data);
  }

  private _canvasCoords(e: PointerEvent): { x: number; y: number } {
    const rect = getApp().canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private _hit(x: number, y: number): LayoutObject | null {
    return this._root.hitTestLayout(x, y, this._ignore.size > 0 ? this._ignore : undefined);
  }

  private _onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;

    const { x, y } = this._canvasCoords(e);
    const data: InputPointerData = { x, y, target: this._hit(x, y), time: Date.now() };

    this._isDown     = true;
    this._isDragging = false;
    this._downData   = data;

    this._emit("left_down", data);
  }

  private _onPointerMove(e: PointerEvent): void {
    if (!this._isDown) return;

    const { x, y } = this._canvasCoords(e);
    const down = this._downData!;

    if (!this._isDragging) {
      if (Math.abs(x - down.x) > this._dragThreshold ||
          Math.abs(y - down.y) > this._dragThreshold) {
        this._isDragging = true;
        this._emit("left_drag_start", { x, y, target: this._hit(x, y), time: Date.now() });
      }
      return;
    }

    this._emit("left_drag_move", { x, y, target: this._hit(x, y), time: Date.now(), down });
  }

  private _onPointerUp(e: PointerEvent): void {
    if (!this._isDown || e.button !== 0) return;

    const { x, y } = this._canvasCoords(e);
    const up:   InputPointerData = { x, y, target: this._hit(x, y), time: Date.now() };
    const down = this._downData!;

    this._isDown   = false;
    this._downData = null;

    if (this._isDragging) {
      this._isDragging = false;
      this._emit("left_drag_end", { down, up });
    } else if (up.time - down.time > this._longClickMs) {
      this._emit("left_click_long", { down, up });
    } else {
      this._emit("left_click", { down, up });
    }
  }

  private _onKeyDown(e: KeyboardEvent): void {
    // Browsers fire repeated keydown events while a key is held — skip them
    // so subscribers see clean down/up boundaries.
    if (e.repeat) return;
    this._emit("key_down", this._keyData(e));
  }

  private _onKeyUp(e: KeyboardEvent): void {
    this._emit("key_up", this._keyData(e));
  }

  private _keyData(e: KeyboardEvent): InputKeyData {
    return {
      key:   e.key,
      code:  e.code,
      ctrl:  e.ctrlKey,
      shift: e.shiftKey,
      alt:   e.altKey,
      time:  Date.now(),
    };
  }
}
