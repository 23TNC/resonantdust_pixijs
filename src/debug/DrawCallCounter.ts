import type { Renderer } from "pixi.js";

/**
 * Patches the WebGL context to count draw calls per frame.
 * Call readAndReset() once per update tick to get the previous frame's count.
 */
export class DrawCallCounter {
  private _count = 0;

  patch(renderer: Renderer): void {
    const gl = (renderer as unknown as { gl?: WebGLRenderingContext }).gl;
    if (!gl) return;

    const inc = () => { this._count++; };

    const origDrawElements = gl.drawElements.bind(gl);
    const origDrawArrays   = gl.drawArrays.bind(gl);

    gl.drawElements = function(this: WebGLRenderingContext, ...args) {
      inc();
      return origDrawElements(...args);
    };
    gl.drawArrays = function(this: WebGLRenderingContext, ...args) {
      inc();
      return origDrawArrays(...args);
    };
  }

  /** Returns the accumulated count since the last reset, then resets to 0. */
  readAndReset(): number {
    const n = this._count;
    this._count = 0;
    return n;
  }
}
