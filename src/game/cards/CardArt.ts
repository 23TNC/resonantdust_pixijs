import { Sprite } from "pixi.js";
import type { LodTextureManager } from "../../assets/textures/LodTextureManager";
import type { TextureRegistry } from "../definitions/TextureRegistry";
import {
  RECT_CARD_HEIGHT,
  RECT_CARD_TITLE_HEIGHT,
  RECT_CARD_WIDTH,
  type RectCardTitlePosition,
} from "./layout/rectangle/RectCard";
import { HEX_CARD_HEIGHT, HEX_CARD_WIDTH } from "./layout/hexagon/HexCard";

/** Fraction of the body's smaller dimension that rect-card art
 *  occupies. Shared across `RectCard`, `BlueprintSlot`
 *  (`WrenchPanel`), and the character-create blueprints preview so
 *  every rect surface reads at the same scale. */
const RECT_ART_BODY_FRACTION = 0.85;

/** Multiplier applied to the exact "largest square inside a pointy-top
 *  hex" scale, leaving a small visual gap between art and outline.
 *  `1.0` = corners touch the hex edges; `0.95` = ~5% margin. */
const HEX_FIT_MARGIN = 0.95;

/** Shape of a `CardDefinition.object` reference. Mirrored here so
 *  CardArt callers can pass it directly without an extra type import.
 *  `name` is the object catalog key (`content/cards/objects.json`)
 *  used as the `master/<name>/` pack-folder name. `scale` (optional)
 *  overrides the object's declared `{min, max}` envelope per-card. */
export interface CardObjectRef {
  name: string;
  index?: number;
  scale?: { min: number; max: number };
}

/**
 * Centred, fits-in-a-box card-art layer. Owns a single `Sprite`
 * (anchored from the underlying texture spec, hidden until an apply
 * call lands a texture); callers parent `cardArt.sprite` under
 * whichever container draws above their card body.
 *
 * Every card-art lookup resolves through:
 *
 *   1. `TextureRegistry.find(ref.name)` → `{ size, scale, anchor }`
 *      where `size` is the aspect's desired draw size in screen px
 *      at scale 1.0.
 *   2. `LodTextureManager.get(ref.name, size, seed, ref.index, faction)`
 *      → Texture at the *picked LOD's* native dimensions. The picker
 *      resolves the smallest LOD ≥ desired size, dropping LODs when
 *      the ideal bucket has no files for this aspect, and falling
 *      through to a 64×64 white texture as the universal floor.
 *
 * **Square-aspect-ratio assumption.** Every LOD source is square
 * (`tex.width === tex.height`), so all the fit math collapses to a
 * single dimension. The hex-fit formula uses `tex.width` only.
 *
 * `seed` is normally the card's row id; previews / blueprints that
 * have no row use the def's stable id as a fallback so the preview
 * renders consistently across mounts. `ref.index` (when set) pins
 * the file whose basename is `<N>.png`; without it, the runtime
 * picks pseudo-randomly per `seed` from the aspect's variant list.
 *
 * Five callers today:
 *   - `RectCard.applyCardArt` (player's rect cards, in-world + inventory)
 *   - `HexCard.applyCardArt` (player's hex cards)
 *   - `CardFace.draw` (drag ghosts, blueprint previews)
 *   - `BlueprintSlot` (wrench-panel grid)
 *   - per-blueprint visuals in `PackContentsPanel` (character-create
 *     preview)
 *
 * A null `ref` or unknown aspect hides the sprite. An aspect with
 * no LOD files anywhere renders the white fallback (a uniform
 * square in the body region) — visible diagnostic that the aspect
 * is referenced but has no art. The runtime never returns null
 * from the texture lookup; `LodTextureManager.onLoad` still fires
 * when a higher-LOD upgrade lands so callers can re-resolve.
 */
export class CardArt {
  readonly sprite = new Sprite();

  constructor() {
    this.sprite.anchor.set(0.5, 0.5);
    this.sprite.visible = false;
  }

  /** Generic apply: centre at `(centerX, centerY)`, scale so the
   *  sprite spans `targetSize` on the larger axis (square sources
   *  → just one axis). Anchor reads from the resolved
   *  `TextureDefinition` per the aspect's render metadata. */
  apply(
    lodTextures: LodTextureManager,
    textureRegistry: TextureRegistry,
    ref: CardObjectRef | null | undefined,
    seed: number,
    centerX: number,
    centerY: number,
    targetSize: number,
    faction?: string | null,
  ): void {
    if (!ref) {
      this.sprite.visible = false;
      return;
    }
    const texDef = textureRegistry.find(ref.name);
    if (!texDef) {
      this.sprite.visible = false;
      return;
    }
    // LOD pick is driven by the aspect's `size` (its preferred draw
    // size in px). The caller's `targetSize` is the fit region for
    // THIS surface — typically smaller than the aspect's size. The
    // texture comes back at the LOD's native dimensions; sprite
    // scale converts to `targetSize` regardless.
    const tex = lodTextures.get(
      ref.name,
      texDef.size,
      seed,
      ref.index,
      faction ?? undefined,
    );
    this.sprite.texture = tex;
    // Anchor comes from the aspect's render metadata — a soul
    // portrait might pivot above centre to read "tall," a small
    // ground item pivots centred. Authors tune these in
    // `content/cards/aspects.json` per aspect.
    this.sprite.anchor.set(texDef.anchor.x, texDef.anchor.y);
    this.sprite.scale.set(targetSize / tex.width);
    this.sprite.position.set(centerX, centerY);
    this.sprite.visible = true;
  }

  /** Lay the art out over a standard rect card's body region (below
   *  the title bar when `titlePosition === "top"`, above it when
   *  `"bottom"`), scaled by `RECT_ART_BODY_FRACTION`. */
  applyRect(
    lodTextures: LodTextureManager,
    textureRegistry: TextureRegistry,
    ref: CardObjectRef | null | undefined,
    seed: number,
    titlePosition: RectCardTitlePosition = "top",
    faction?: string | null,
  ): void {
    const bodyHeight = RECT_CARD_HEIGHT - RECT_CARD_TITLE_HEIGHT;
    const centerY = titlePosition === "top"
      ? RECT_CARD_TITLE_HEIGHT + bodyHeight / 2
      : bodyHeight / 2;
    const target = RECT_ART_BODY_FRACTION * Math.min(RECT_CARD_WIDTH, bodyHeight);
    this.apply(
      lodTextures, textureRegistry, ref, seed,
      RECT_CARD_WIDTH / 2, centerY, target, faction,
    );
  }

  /** Lay the art out over a standard hex card — centred on the
   *  bounding box, scaled to the largest size that fits inside the
   *  pointy-top hex polygon (not just the inscribed circle).
   *
   *  Square sources collapse the constraint to one axis. For a hex
   *  of radius `r` containing a square of side `S` centred on the
   *  hex centre, corners at `(±S/2, ±S/2)` must lie inside the
   *  polygon:
   *
   *   - If `S/2 ≤ r` (corners in the full-width band), the binding
   *     constraint is `S ≤ √3·r` → `kWidth = √3·r / S`.
   *   - Tapered-band corners hit the line `x + √3·y ≤ √3·r`, so
   *     `S/2 + √3·S/2 ≤ √3·r` → `kTaper = 2√3·r / (S·(1 + √3))`.
   *
   *  The actual max scale is `min(kWidth, kTaper) × HEX_FIT_MARGIN`,
   *  applied to the LOD source's native dimensions. Spread between
   *  the two bounds depends on `S/r`; we just take min and let the
   *  margin handle slop. */
  applyHex(
    lodTextures: LodTextureManager,
    textureRegistry: TextureRegistry,
    ref: CardObjectRef | null | undefined,
    seed: number,
    faction?: string | null,
  ): void {
    if (!ref) {
      this.sprite.visible = false;
      return;
    }
    const texDef = textureRegistry.find(ref.name);
    if (!texDef) {
      this.sprite.visible = false;
      return;
    }
    const tex = lodTextures.get(
      ref.name,
      texDef.size,
      seed,
      ref.index,
      faction ?? undefined,
    );
    this.sprite.texture = tex;
    this.sprite.anchor.set(texDef.anchor.x, texDef.anchor.y);
    const r = HEX_CARD_HEIGHT / 2;
    const sqrt3 = Math.sqrt(3);
    const kWidthBound   = (sqrt3 * r) / tex.width;
    const kTaperedBound = (2 * sqrt3 * r) / (tex.width + sqrt3 * tex.height);
    const fit = Math.min(kWidthBound, kTaperedBound) * HEX_FIT_MARGIN;
    this.sprite.scale.set(fit);
    this.sprite.position.set(HEX_CARD_WIDTH / 2, HEX_CARD_HEIGHT / 2);
    this.sprite.visible = true;
  }
}
