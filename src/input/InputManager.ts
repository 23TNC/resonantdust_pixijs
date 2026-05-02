import type { LayoutNode } from "../layout/LayoutNode";

const DRAG_THRESHOLD_PX = 5;

export interface PointerEventData {
  /** Canvas-local pixels (top-left = 0,0). */
  x: number;
  y: number;
  /** Result of `hitTestLayout(x, y)` on the layout root, computed at event time. */
  hit: LayoutNode | null;
  /** `performance.now()` timestamp. */
  t: number;
}

/** Payload for events fired at pointerup (carries both endpoints of the gesture). */
export interface UpEventData {
  down: PointerEventData;
  up: PointerEventData;
}

export type DownLikeEvent = "left_down" | "left_drag_start";
export type UpLikeEvent = "left_up" | "left_click" | "left_drag_stop";
export type InputEvent = DownLikeEvent | UpLikeEvent;

export type DownListener = (data: PointerEventData) => void;
export type UpListener = (data: UpEventData) => void;

type State = "idle" | "pressed" | "dragging";

/**
 * Scene-scoped pointer-event router. Hooks DOM pointer events on the canvas,
 * runs a small state machine, hit-tests **only** at pointerdown and pointerup
 * (not on every move — that's expensive), and emits semantic events:
 *
 *   - `left_down`         pointerdown, button 0. Payload: `PointerEventData`.
 *   - `left_drag_start`   pointermove crosses DRAG_THRESHOLD_PX while pressed.
 *                         Payload: `PointerEventData` (the original down).
 *   - `left_up`           pointerup (always). Payload: `{ down, up }`.
 *   - `left_click`        pointerup AND no drag occurred. Payload: `{ down, up }`.
 *   - `left_drag_stop`    pointerup AND a drag was in progress. Payload: `{ down, up }`.
 *
 * Subscribe via `on(event, listener)`; returns an unsubscribe fn. Up-time
 * listeners receive both down and up data — drag managers / click handlers
 * have everything they need to act on the gesture endpoints.
 */
export class InputManager {
  /**
   * Last pointer position, in canvas-local pixels. Updated on every
   * `pointermove` (no event fired). Sticky across pointermoves — readers
   * (e.g. LayoutCard during drag) can read every frame for cursor-follow.
   * Stays at (0,0) until the first move; consumers that care only about
   * drag scenarios always see it valid because a drag implies prior moves.
   */
  readonly lastPointer = { x: 0, y: 0 };

  private state: State = "idle";
  private downData: PointerEventData | null = null;
  private capturedPointerId: number | null = null;
  private readonly downListeners = new Map<DownLikeEvent, Set<DownListener>>();
  private readonly upListeners = new Map<UpLikeEvent, Set<UpListener>>();

  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onPointerCancel: (e: PointerEvent) => void;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly hitRoot: LayoutNode,
  ) {
    this.onPointerDown = this.handlePointerDown.bind(this);
    this.onPointerMove = this.handlePointerMove.bind(this);
    this.onPointerUp = this.handlePointerUp.bind(this);
    this.onPointerCancel = this.handlePointerCancel.bind(this);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
  }

  on(event: DownLikeEvent, listener: DownListener): () => void;
  on(event: UpLikeEvent, listener: UpListener): () => void;
  on(event: InputEvent, listener: DownListener | UpListener): () => void {
    if (event === "left_down" || event === "left_drag_start") {
      let set = this.downListeners.get(event);
      if (!set) {
        set = new Set();
        this.downListeners.set(event, set);
      }
      set.add(listener as DownListener);
      return () => {
        const s = this.downListeners.get(event);
        if (!s) return;
        s.delete(listener as DownListener);
        if (s.size === 0) this.downListeners.delete(event);
      };
    }
    let set = this.upListeners.get(event);
    if (!set) {
      set = new Set();
      this.upListeners.set(event, set);
    }
    set.add(listener as UpListener);
    return () => {
      const s = this.upListeners.get(event);
      if (!s) return;
      s.delete(listener as UpListener);
      if (s.size === 0) this.upListeners.delete(event);
    };
  }

  dispose(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
    if (this.capturedPointerId !== null) {
      try {
        this.canvas.releasePointerCapture(this.capturedPointerId);
      } catch {
        // capture may have already ended; ignore
      }
    }
    this.downListeners.clear();
    this.upListeners.clear();
    this.state = "idle";
    this.downData = null;
    this.capturedPointerId = null;
  }

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (this.state !== "idle") return;

    const data = this.eventData(e);
    this.downData = data;
    this.state = "pressed";

    try {
      this.canvas.setPointerCapture(e.pointerId);
      this.capturedPointerId = e.pointerId;
    } catch {
      // some environments may refuse capture; continue without it
    }

    this.emitDown("left_down", data);
  }

  private handlePointerMove(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.lastPointer.x = x;
    this.lastPointer.y = y;

    if (this.state !== "pressed" || !this.downData) return;

    if (
      Math.abs(x - this.downData.x) > DRAG_THRESHOLD_PX ||
      Math.abs(y - this.downData.y) > DRAG_THRESHOLD_PX
    ) {
      this.state = "dragging";
      this.emitDown("left_drag_start", this.downData);
    }
  }

  private handlePointerUp(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (this.state === "idle" || !this.downData) return;

    const upData = this.eventData(e);
    const payload: UpEventData = { down: this.downData, up: upData };
    const wasDragging = this.state === "dragging";

    this.emitUp("left_up", payload);
    if (wasDragging) {
      this.emitUp("left_drag_stop", payload);
    } else {
      this.emitUp("left_click", payload);
    }

    this.cleanup(e.pointerId);
  }

  private handlePointerCancel(e: PointerEvent): void {
    if (this.state === "idle" || !this.downData) return;

    const upData = this.eventData(e);
    const payload: UpEventData = { down: this.downData, up: upData };
    const wasDragging = this.state === "dragging";

    this.emitUp("left_up", payload);
    if (wasDragging) {
      this.emitUp("left_drag_stop", payload);
    }

    this.cleanup(e.pointerId);
  }

  private cleanup(pointerId: number): void {
    if (this.capturedPointerId === pointerId) {
      try {
        this.canvas.releasePointerCapture(pointerId);
      } catch {
        // ignore — capture may have ended already
      }
      this.capturedPointerId = null;
    }
    this.state = "idle";
    this.downData = null;
  }

  private eventData(e: PointerEvent): PointerEventData {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return {
      x,
      y,
      hit: this.hitRoot.hitTestLayout(x, y),
      t: performance.now(),
    };
  }

  private emitDown(event: DownLikeEvent, data: PointerEventData): void {
    const set = this.downListeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(data);
      } catch (err) {
        console.error(`[InputManager] ${event} listener threw`, err);
      }
    }
  }

  private emitUp(event: UpLikeEvent, data: UpEventData): void {
    const set = this.upListeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(data);
      } catch (err) {
        console.error(`[InputManager] ${event} listener threw`, err);
      }
    }
  }
}
