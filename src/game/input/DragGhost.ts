import { Container } from "pixi.js";
import type { GameContext } from "../../GameContext";
import { RectCardVisual } from "../cards/layout/rectangle/RectVisual";

const GHOST_ALPHA = 0.6;

/**
 * Translucent drag preview for cards that don't physically move via
 * pickup-and-drop (souls today; movement-card patterns later).
 *
 * Unlike `Card.setDragging(true)` — which detaches the *real* layout
 * card from its zone surface and reparents it to the overlay so it
 * follows the cursor — this class spawns a SEPARATE visual that
 * mirrors the card's appearance. The original card stays in place;
 * only the ghost moves. On drop the ghost is discarded and the
 * underlying request (e.g. `move_soul`) fires.
 *
 * Parented to `ctx.layout.overlay` so it renders above everything.
 * `eventMode = "none"` so it doesn't intercept hit tests — the drop
 * resolution needs to see the world tile / target card beneath the
 * ghost, not the ghost itself.
 *
 * Today: rect-only (souls have `shape: "rect"` per `cards/types.json`).
 * If a future card type with `shape: "hex"` needs ghost-drag, swap in
 * a hex visual based on `ctx.definitions.shape(typeId)`.
 */
export class DragGhost {
  readonly container = new Container();
  private readonly visual = new RectCardVisual();
  private readonly tickerCallback: () => void;
  private destroyed = false;

  constructor(
    private readonly ctx: GameContext,
    packedDefinition: number,
    private readonly offsetX: number,
    private readonly offsetY: number,
  ) {
    const def = ctx.definitions.decode(packedDefinition) ?? null;
    const label = ctx.definitions.label(packedDefinition);
    this.visual.draw(def, "top", label);
    this.container.addChild(this.visual);
    this.container.alpha = GHOST_ALPHA;
    this.container.eventMode = "none";

    const overlay = ctx.layout?.overlay;
    if (overlay) overlay.container.addChild(this.container);

    // Pin to the cursor every frame. InputManager exposes
    // `lastPointer` sticky across pointermoves; we don't subscribe to
    // an explicit move event because there isn't one — and polling
    // per frame is cheap and naturally aligned with the layout
    // ticker that drives the rest of the scene.
    this.tickerCallback = () => this.updatePosition();
    ctx.app.ticker.add(this.tickerCallback);
    this.updatePosition();
  }

  /** Snap to the current cursor minus the grab offset. */
  updatePosition(): void {
    const ptr = this.ctx.input?.lastPointer;
    if (!ptr) return;
    this.container.position.set(ptr.x - this.offsetX, ptr.y - this.offsetY);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ctx.app.ticker.remove(this.tickerCallback);
    if (this.container.parent) this.container.parent.removeChild(this.container);
    this.container.destroy({ children: true });
  }
}
