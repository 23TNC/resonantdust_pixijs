import { Container } from "pixi.js";
import type { GameContext } from "../../GameContext";

export class LayoutNode {
  readonly container: Container = new Container();

  parent: LayoutNode | null = null;
  readonly children: LayoutNode[] = [];

  get zIndex(): number { return this.container.zIndex; }
  set zIndex(value: number) { this.container.zIndex = value; }

  private _x = 0;
  private _y = 0;
  private _width = 0;
  private _height = 0;

  private selfDirty = true;
  private subtreeDirty = true;

  private _localCtx: GameContext | null = null;

  setContext(ctx: GameContext | null): void {
    this._localCtx = ctx;
  }

  get ctx(): GameContext {
    let node: LayoutNode | null = this;
    while (node) {
      if (node._localCtx) return node._localCtx;
      node = node.parent;
    }
    throw new Error(
      "LayoutNode.ctx accessed before context was set on the layout tree",
    );
  }

  get x(): number {
    return this._x;
  }
  get y(): number {
    return this._y;
  }
  get width(): number {
    return this._width;
  }
  get height(): number {
    return this._height;
  }

  setBounds(x: number, y: number, width: number, height: number): void {
    if (
      this._x === x &&
      this._y === y &&
      this._width === width &&
      this._height === height
    ) {
      return;
    }
    this._x = x;
    this._y = y;
    this._width = width;
    this._height = height;
    this.container.x = x;
    this.container.y = y;
    this.invalidate();
  }

  invalidate(): void {
    if (this.selfDirty) return;
    this.selfDirty = true;
    let node: LayoutNode | null = this.parent;
    while (node && !node.subtreeDirty) {
      node.subtreeDirty = true;
      node = node.parent;
    }
  }

  layoutIfDirty(): void {
    if (!this.selfDirty && !this.subtreeDirty) return;
    if (this.selfDirty) {
      // layout() may return true to indicate it's still dirty (e.g. mid-tween)
      // — selfDirty stays true so it runs again next frame.
      this.selfDirty = this.layout() === true;
    }
    let anyDirty = false;
    for (const child of this.children) {
      if (child.selfDirty || child.subtreeDirty) {
        child.layoutIfDirty();
      }
      if (child.selfDirty || child.subtreeDirty) {
        anyDirty = true;
      }
    }
    this.subtreeDirty = anyDirty;
  }

  hitTestLayout(parentX: number, parentY: number): LayoutNode | null {
    const localX = parentX - this._x;
    const localY = parentY - this._y;
    if (!this.intersects(localX, localY)) return null;
    for (let i = this.children.length - 1; i >= 0; i--) {
      const hit = this.children[i].hitTestLayout(localX, localY);
      if (hit) return hit;
    }
    return this;
  }

  addChild(child: LayoutNode): void {
    if (child.parent === this) return;
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.push(child);
    this.container.addChild(child.container);
    this.invalidate();
  }

  removeChild(child: LayoutNode): void {
    const index = this.children.indexOf(child);
    if (index < 0) return;
    this.children.splice(index, 1);
    this.container.removeChild(child.container);
    child.parent = null;
    this.invalidate();
  }

  destroy(): void {
    for (const child of this.children) {
      child.parent = null;
      child.destroy();
    }
    this.children.length = 0;
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    }
    this.container.destroy({ children: true });
  }

  /**
   * Subclass hook. Return `true` to indicate this node is still dirty (e.g.
   * mid-tween) and should re-run next frame. Return nothing to clear dirty.
   */
  protected layout(): boolean | void {}

  protected intersects(localX: number, localY: number): boolean {
    return (
      localX >= 0 &&
      localX < this._width &&
      localY >= 0 &&
      localY < this._height
    );
  }
}
