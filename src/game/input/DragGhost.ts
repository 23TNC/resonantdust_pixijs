import { Container } from "pixi.js";
import type { GameContext } from "../../GameContext";
import { GenericCardFace } from "../cards/generic/GenericCardFace";
import { localPlayerFactionFolder } from "../../server/player/playerFlags";

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
 * Shape-agnostic: the ghost renders the def's `:visuals` through the same
 * generic PrimList pipeline as a live card (`GenericCardFace`), so it looks
 * identical to what drops, whatever the card's geometry.
 */
export class DragGhost {
  readonly container = new Container();
  private readonly face: GenericCardFace;
  private readonly tickerCallback: () => void;
  private readonly unsubArtLoad: () => void;
  private readonly faction: string | null;
  private destroyed = false;

  constructor(
    private readonly ctx: GameContext,
    private readonly packedDefinition: number,
    private readonly offsetX: number,
    private readonly offsetY: number,
  ) {
    // Seed = `packedDefinition` (a stable per-def integer; the ghost is a
    // preview, not tied to a card row). For packs with multiple variants the
    // user sees one consistent ghost per def; the real card on drop may show a
    // different sprite because it seeds on `card_id`.
    this.face = new GenericCardFace(ctx, packedDefinition);
    this.faction = localPlayerFactionFolder(this.ctx);
    this.face.draw(packedDefinition, this.faction);
    this.container.addChild(this.face);
    this.container.alpha = GHOST_ALPHA;
    this.container.eventMode = "none";

    const overlay = ctx.layout?.overlay;
    if (overlay) overlay.container.addChild(this.container);

    // Lazy-loaded packs can return `null` on first resolution and
    // finish loading mid-drag. Re-draw once the pack arrives so
    // the ghost picks up the texture without requiring the user
    // to release and re-grab.
    this.unsubArtLoad = ctx.lodTextures.onLoad(() => {
      if (this.destroyed) return;
      this.face.draw(this.packedDefinition, this.faction);
    });

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
    this.unsubArtLoad();
    this.ctx.app.ticker.remove(this.tickerCallback);
    if (this.container.parent) this.container.parent.removeChild(this.container);
    this.container.destroy({ children: true });
  }
}
