import type { GameContext } from "../GameContext";
import type { LayoutNode } from "../layout/LayoutNode";
import type { UpEventData } from "../input/InputManager";
import { TILE_SIZE } from "./worldCoords";
import type { LayoutWorld } from "./LayoutWorld";

interface PanState {
  startPointerX: number;
  startPointerY: number;
  startAnchorQ: number;
  startAnchorR: number;
}

/**
 * Handles world-view panning. On a drag that starts over LayoutWorld (not a
 * card), tracks pointer movement each frame and shifts the "viewport" anchor
 * in ZoneManager, which causes LayoutWorld to re-center on the new position.
 *
 * Pixel-to-hex inverse of LayoutWorld.toScreen (pointy-top axial):
 *   dViewQ = -dx / (TILE_SIZE * √3) + dy / (3 * TILE_SIZE)
 *   dViewR = -(2 * dy) / (3 * TILE_SIZE)
 */
export class WorldPanManager {
  private state: PanState | null = null;
  private readonly unsubStart: () => void;
  private readonly unsubStop: () => void;

  constructor(
    private readonly ctx: GameContext,
    private readonly worldView: LayoutWorld,
  ) {
    if (!ctx.input) throw new Error("[WorldPanManager] ctx.input is null");

    this.unsubStart = ctx.input.on("left_drag_start", (data) => {
      if (this.state) return;
      if (data.hit !== (this.worldView as LayoutNode)) return;
      const anchor = this.ctx.zones.viewportAnchor;
      this.state = {
        startPointerX: data.x,
        startPointerY: data.y,
        startAnchorQ: anchor.q,
        startAnchorR: anchor.r,
      };
    });

    this.unsubStop = ctx.input.on("left_drag_stop", (_data: UpEventData) => {
      this.state = null;
    });
  }

  update(): void {
    if (!this.state || !this.ctx.input) return;
    const { startPointerX, startPointerY, startAnchorQ, startAnchorR } = this.state;
    const dx = this.ctx.input.lastPointer.x - startPointerX;
    const dy = this.ctx.input.lastPointer.y - startPointerY;
    const dViewQ = -dx / (TILE_SIZE * Math.sqrt(3)) + dy / (3 * TILE_SIZE);
    const dViewR = -(2 * dy) / (3 * TILE_SIZE);
    this.ctx.zones.setAnchor("viewport", startAnchorQ + dViewQ, startAnchorR + dViewR);
  }

  dispose(): void {
    this.state = null;
    this.unsubStart();
    this.unsubStop();
  }
}
