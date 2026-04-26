import { getApp } from "@/app";
import { LayoutRoot } from "@/ui/layout/LayoutRoot";

/**
 * Owns the active scene. Exactly one scene is live at a time.
 *
 * Scenes are LayoutRoot subclasses — they are PixiJS Containers that manage
 * their own resize subscription and expose tick() for the render loop.
 * SceneManager adds one persistent ticker listener that delegates to whatever
 * scene is current, so callers never touch the ticker directly.
 *
 * setScene() destroys the previous scene (including all its children).
 * destroy() tears down the manager and the active scene.
 */
export class SceneManager {
  private _current: LayoutRoot | null = null;

  constructor() {
    getApp().ticker.add(this._onTick, this);
  }

  setScene(next: LayoutRoot): void {
    if (this._current === next) return;

    const prev = this._current;
    this._current = next;

    const stage = getApp().stage;
    if (prev) {
      stage.removeChild(prev);
      prev.destroy({ children: true });
    }

    stage.addChild(next);
  }

  getScene(): LayoutRoot | null {
    return this._current;
  }

  destroy(): void {
    getApp().ticker.remove(this._onTick, this);

    if (this._current) {
      getApp().stage.removeChild(this._current);
      this._current.destroy({ children: true });
      this._current = null;
    }
  }

  private _onTick(): void {
    this._current?.tick();
  }
}
