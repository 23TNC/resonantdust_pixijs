import { Container, Graphics, Rectangle, RenderTexture, Texture, type Renderer } from "pixi.js";
import type { TextureManager } from "./TextureManager";
import { HexTileVisual } from "../../game/viewport/hex/HexTileVisual";
import { CARD_HEIGHT, CARD_WIDTH } from "../../game/cards/layout/cardMetrics";
import { WORLD_HEX_RADIUS } from "../../game/viewport/hex/hexSize";
import type { CardDefinition } from "../../game/definitions/DefinitionManager";

/**
 * Hex bake radius. Set to the largest hex display radius (world hex
 * tiles at WORLD_HEX_RADIUS) so the baked texture is never upscaled
 * at render time — inventory hex cards at the smaller HEX_CARD_RADIUS
 * scale down from this, which stays crisp.
 */
const HEX_BAKE_RADIUS = WORLD_HEX_RADIUS;

/**
 * Transparent border baked around every card texture before atlas
 * packing. Reserves space between adjacent atlas slots so neighbouring
 * card pixels can't bleed into ours under bilinear sampling. The
 * returned Texture's frame still reports the un-padded content size,
 * so callers are unaffected.
 */
const BAKE_PADDING = 2;

/**
 * Bakes and caches card textures into a shared TextureManager atlas.
 *
 * On cache miss, the appropriate card visual is drawn for the
 * definition, rendered into a temporary RenderTexture sized to the
 * visual's bounding box, then handed to TextureManager.pack so the
 * pixels move into the atlas. The returned sub-Texture is cached and
 * reused for subsequent requests.
 *
 * Rect cards are keyed by (definition, titlePosition) — top and bottom
 * variants are independent entries since the title bar position
 * changes the rendered output. Hex cards are keyed by definition only.
 *
 * The manager owns the bake dimensions (via HEX_BAKE_RADIUS and the
 * existing CARD_WIDTH/HEIGHT constants). Display-time scaling is
 * the caller's responsibility — these textures are baked once at a
 * fixed size and re-used wherever the same definition is drawn.
 */
export class CardTextureManager {
  private readonly renderer: Renderer;
  private readonly textures: TextureManager;

  /** Hex bakes keyed by `(packedDef, bodyTextureUid)`. The body-
   *  texture id participates so a card def with `def.texture` set
   *  bakes one entry per resolved source texture — typically one per
   *  faction (`chorus`, `chord`, …) since the URL changes per
   *  faction folder. Defs without `def.texture` use uid `0` and
   *  bake once like before. */
  private readonly hexCache  = new Map<string, Texture>();
  /** Cache for rect-shaped tile bodies (`getRectTile`), keyed by packed def +
   *  body-texture uid — the rect analogue of `hexCache`. */
  private readonly rectTileCache = new Map<string, Texture>();

  private readonly hexVisual  = new HexTileVisual(HEX_BAKE_RADIUS);

  constructor(renderer: Renderer, textures: TextureManager) {
    this.renderer = renderer;
    this.textures = textures;
  }

  /** Packed atlas texture for a hex card definition. Bakes on first
   *  request and caches. A `null` definition produces a fallback-styled
   *  hex (handled by HexTileVisual) — used for empty world tiles.
   *
   *  The bake includes only the hex *background* (fill + outline); per-
   *  definition art is fetched separately via [`getCardArt`] and
   *  layered on top by the caller (`LayoutHexCard`). That split keeps
   *  the cache size linear when a single def can carry many art
   *  variants (e.g. soul cards with 16 portraits — see
   *  `content/cards/flags.json` → `cards.portrait_id`). */
  /** Packed atlas texture for a hex card definition, optionally with
   *  a body-fill texture baked in.
   *
   *  When `bodyTexture` is set, the hex polygon is filled with that
   *  source PNG (cover-fit, polygon-clipped) instead of `style[0]`.
   *  Cache key includes `bodyTexture.uid` so faction-aware lookups
   *  (each faction resolves to a different `objects/<size>_<aspect>/<faction>/...`
   *  URL → different atlas Texture → different `uid`) get their own
   *  cached bake — up to one per faction per def. Defs without a
   *  `def.texture` ref (or whose chosen URL hasn't loaded yet) pass
   *  `null`, which keys on uid `0` and bakes the existing colour-fill
   *  variant.
   *
   *  The bake includes only the hex *background*; per-definition art
   *  is fetched separately via `lodTextures` and layered on top
   *  by the caller (`LayoutHexCard`). */
  getHex(definition: CardDefinition | null, bodyTexture?: Texture | null): Texture {
    const key = hexKey(definition, bodyTexture ?? null);
    let tex = this.hexCache.get(key);
    if (!tex) {
      tex = this.bakeHex(definition, bodyTexture ?? null);
      this.hexCache.set(key, tex);
    }
    return tex;
  }

  /** Rect-shaped tile body — the rectangle analogue of `getHex`. Body fill +
   *  outline, no title bar / label, sized `CARD_WIDTH × CARD_HEIGHT`
   *  so it scales into a rect-grid cell the same way `getHex` fills a hex cell.
   *  Used by `LayoutWorld.buildTile` when the viewport's grid is rectangular
   *  (e.g. an inventory's "empty" tiles). `bodyTexture` cover-fills the rect
   *  when present (textured tiles); otherwise `style[0]` (or a fallback) fills
   *  it. A `null` def bakes the fallback, matching `getHex`'s empty-tile path. */
  getRectTile(definition: CardDefinition | null, bodyTexture?: Texture | null): Texture {
    const key = `tile:${definition ? packedKey(definition) : -1}:${bodyTexture?.uid ?? 0}`;
    let tex = this.rectTileCache.get(key);
    if (!tex) {
      const g = new Graphics();
      g.rect(0, 0, CARD_WIDTH, CARD_HEIGHT);
      if (bodyTexture) {
        g.fill({ texture: bodyTexture });
      } else {
        g.fill({ color: definition?.style[0] ?? 0x2a3340 });
      }
      // Visible cell outline — the "empty" tile fill (#0b1426) matches the
      // viewport backdrop, so the outline is what reads as the grid.
      g.rect(0, 0, CARD_WIDTH, CARD_HEIGHT).stroke({ color: 0x2a3a4a, width: 2 });
      tex = this.renderAndPack(g, CARD_WIDTH, CARD_HEIGHT);
      g.destroy();
      this.rectTileCache.set(key, tex);
    }
    return tex;
  }

  destroy(): void {
    this.hexVisual.destroy();
    this.hexCache.clear();
    this.rectTileCache.clear();
  }

  private bakeHex(def: CardDefinition | null, bodyTexture: Texture | null): Texture {
    this.hexVisual.draw(def, bodyTexture);
    const w = Math.ceil(Math.sqrt(3) * HEX_BAKE_RADIUS);
    const h = 2 * HEX_BAKE_RADIUS;
    return this.renderAndPack(this.hexVisual, w, h);
  }

  /** Render a card visual into a temp RenderTexture sized to its
   *  bounding box plus a transparent BAKE_PADDING border, hand it to
   *  TextureManager for atlas placement, then destroy the temp. The
   *  returned Texture's frame is narrowed back to the inner (w × h)
   *  content area — the padded border stays reserved in the atlas so
   *  adjacent slots can't bleed in, but callers see the original size. */
  private renderAndPack(container: Container, w: number, h: number): Texture {
    const paddedW = w + BAKE_PADDING * 2;
    const paddedH = h + BAKE_PADDING * 2;
    const rt = RenderTexture.create({ width: paddedW, height: paddedH });
    container.position.set(BAKE_PADDING, BAKE_PADDING);
    this.renderer.render({ container, target: rt, clear: true });
    container.position.set(0, 0);
    const padded = this.textures.pack(rt);
    rt.destroy(true);
    return new Texture({
      source: padded.source,
      frame: new Rectangle(
        padded.frame.x + BAKE_PADDING,
        padded.frame.y + BAKE_PADDING,
        w,
        h,
      ),
    });
  }
}

function packedKey(def: CardDefinition): number {
  return (def.cardType << 12) | def.definitionId;
}

/** Cache key for `getHex`. Composite of the packed def id and the
 *  body-texture's atlas uid (0 when no texture is baked in). Real
 *  definitions produce non-negative packed ids; `null` uses -1 as a
 *  sentinel. Stringified so the two ids round-trip cleanly without
 *  worrying about Pixi's uid growing past 32 bits. */
function hexKey(def: CardDefinition | null, bodyTexture: Texture | null): string {
  const defPart = def === null ? -1 : packedKey(def);
  const texPart = bodyTexture?.uid ?? 0;
  return `${defPart}:${texPart}`;
}

