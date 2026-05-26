import { Container } from "pixi.js";
import type { GameContext } from "../../GameContext";
import type { CardDefinition } from "../../game/definitions/DefinitionManager";
import { CardFace } from "../cards/CardFace";
import { getTextureRegistry } from "../definitions/TextureRegistry";
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
 * Today: rect-only (souls have `shape: "rect"` per `cards/types.json`).
 * If a future card type with `shape: "hex"` needs ghost-drag, swap in
 * a hex visual based on `ctx.definitions.shape(typeId)`.
 */
export class DragGhost {
  readonly container = new Container();
  private readonly face = new CardFace();
  private readonly tickerCallback: () => void;
  private readonly unsubArtLoad: () => void;
  private readonly def: CardDefinition | null;
  private readonly label: string | undefined;
  private destroyed = false;

  constructor(
    private readonly ctx: GameContext,
    packedDefinition: number,
    private readonly offsetX: number,
    private readonly offsetY: number,
  ) {
    this.def = ctx.definitions.decode(packedDefinition) ?? null;
    this.label = ctx.definitions.label(packedDefinition);
    // Resolve card art via the unified resolver. Seed =
    // `packedDefinition` (a stable per-def integer; ghost is a
    // preview, not tied to a specific card row). For packs with
    // multiple variants the user sees one consistent ghost per
    // def; the actual card on drop may show a different sprite
    // because the real card seeds on `card_id`.
    const art = {
      lodTextures: this.ctx.lodTextures,
      textureRegistry: getTextureRegistry(),
      seed: packedDefinition,
      faction: localPlayerFactionFolder(this.ctx),
      definitions: this.ctx.definitions,
    };
    this.face.draw(this.def, "top", this.label, art);
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
      this.face.draw(this.def, "top", this.label, art);
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
