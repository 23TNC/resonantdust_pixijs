// ════════════════════════════════════════════════════════════════════════
// LEGACY — part of the non-generic render pipeline. No longer used by card
// rendering (cards are generic); now reached ONLY by the drag ghost (CardFace).
// MARKED FOR CLEANUP — remove once the drag ghost is migrated to the generic
// pipeline.
// ════════════════════════════════════════════════════════════════════════
import { Container } from "pixi.js";
import type { CardDefinition, DefinitionManager } from "../definitions/DefinitionManager";
import type { LodTextureManager } from "../../assets/textures/LodTextureManager";
import type { TextureRegistry } from "../definitions/TextureRegistry";
import { CardArt } from "./CardArt";
import {
  RECT_CARD_HEIGHT,
  RECT_CARD_WIDTH,
  type RectCardTitlePosition,
} from "./layout/rectangle/RectCard";
import { RectCardVisual } from "./layout/rectangle/RectVisual";

/** Desired draw size to feed the LOD picker when resolving the
 *  body-fill texture for a CardFace. The body is `RECT_CARD_WIDTH ×
 *  RECT_CARD_HEIGHT` and the texture covers it via `coverMatrix`;
 *  we pick an LOD ≥ the larger axis so cover-fit never has to
 *  upscale on the binding dimension. */
const FACE_BODY_DESIRED = Math.max(RECT_CARD_WIDTH, RECT_CARD_HEIGHT);

/**
 * Composed rect-card face — `RectCardVisual` (body + title + name +
 * outline) plus a `CardArt` sprite overlay, in one Container with one
 * `draw()` entry point.
 *
 * The pre-existing pattern of "instantiate a `RectCardVisual`, draw
 * it, then manually layer a `CardArt` on top" lived in three call
 * sites (drag ghost, character-create blueprint preview, wrench-panel
 * slots). Each drifted independently — the drag ghost shipped
 * without its sprite layer for a while, the character-create panel
 * needed a separate `onArtLoad` rebuild, and the wrench panel went
 * through the atlas-bake path. This class is the unified shape they
 * all collapse to.
 *
 * Z-order, back to front:
 *   1. `visual` (Container, body fill)
 *   2. `cardArt.sprite` (per-def sprite overlay)
 *   3. `visual.titleBar`  ┐
 *   4. `visual.nameText`  │ re-parented above the art so the title
 *   5. `visual.cardOutline`┘ elements stay readable on top.
 *
 * `LayoutRectCard` does *not* use this class — it needs to interleave
 * other layers (progress bars, in-front-objects overlay,
 * state-overlay) between body and title, which the fixed z-order
 * above doesn't permit. The `visual` / `cardArt` references are
 * exposed for callers that need finer-grained control without
 * abandoning the wrapper entirely.
 */
export class CardFace extends Container {
  static readonly WIDTH  = RECT_CARD_WIDTH;
  static readonly HEIGHT = RECT_CARD_HEIGHT;

  /** Body + title + name + outline. Exposed so callers can subscribe
   *  to specific sub-nodes if needed (uncommon). */
  readonly visual: RectCardVisual;
  /** Sprite-art overlay. Exposed so callers can refresh art
   *  independently on `lodTextures.onLoad` if they care. */
  readonly cardArt: CardArt;

  constructor() {
    super();
    this.visual = new RectCardVisual();
    this.cardArt = new CardArt();
    this.addChild(this.visual);
    this.addChild(this.cardArt.sprite);
    // Re-parent the readable title elements above the art so the
    // sprite never obscures the card's identifying text.
    this.addChild(this.visual.titleBar);
    this.addChild(this.visual.nameText);
    this.addChild(this.visual.cardOutline);
  }

  /** Render body + title + name + outline + (optional) card art.
   *
   *  - `art` present → resolves `definition.object` through the
   *    unified resolver and lays the sprite over the body region.
   *    Pair this with `lodTextures.onLoad(() => face.draw(...))`
   *    when ghosts/previews outlive a lazy load — the substitute
   *    will upgrade when a higher LOD lands.
   *  - `art` omitted → draws the body only, no art.
   *
   *  `art.seed` is the variance source for pseudo-random variant
   *  pick (when `definition.object.index` is unset). Pass the card's
   *  `card_id` when available; preview surfaces fall back to
   *  `definitionId` so the preview stays stable across mounts. */
  draw(
    definition: CardDefinition | null,
    titlePosition: RectCardTitlePosition = "top",
    label?: string,
    art?: {
      lodTextures: LodTextureManager;
      textureRegistry: TextureRegistry;
      seed: number;
      faction?: string | null;
      /** Optional. When supplied, lets CardFace check the def for a
       *  `faction` sub-aspect override (e.g. a chorus-tagged card forces
       *  the `chorus` folder regardless of `art.faction`). Omit when the
       *  caller doesn't care — `art.faction` then wins unmodified. */
      definitions?: DefinitionManager;
    },
  ): void {
    // Card-side faction override beats the caller-supplied
    // `art.faction` (typically the local player's faction). Cards
    // carrying a sub-aspect of `faction` (chorus / chord / resonance)
    // render with that folder so a designer can ship faction-
    // specific cards that look identical across players.
    const effectiveFaction =
      art?.definitions?.cardFactionOverride(definition) ??
      art?.faction ??
      undefined;
    // Body texture (when `def.texture` declares an aspect): same
    // resolver, same seed/faction as the foreground art — body
    // fill's desired size is the card's body bbox so the LOD
    // picker grabs a bucket large enough to cover-fit without
    // upscaling. The aspect's own `size` field is ignored for
    // body-fill aspects since they're shape-driven.
    let bodyTexture = null;
    if (art && definition?.texture) {
      const ref = definition.texture;
      bodyTexture = art.lodTextures.get(
        ref.name,
        FACE_BODY_DESIRED,
        art.seed,
        ref.index,
        effectiveFaction,
      );
    }
    this.visual.draw(definition, titlePosition, label, bodyTexture);
    if (art) {
      this.cardArt.applyRect(
        art.lodTextures,
        art.textureRegistry,
        definition?.object ?? null,
        art.seed,
        titlePosition,
        effectiveFaction ?? null,
      );
    } else {
      this.cardArt.sprite.visible = false;
    }
  }
}
