import { Container, Graphics, Rectangle, RenderTexture, Texture, type Renderer } from "pixi.js";
import type { TextureManager } from "./TextureManager";
import { RectCardVisual } from "../../game/cards/layout/rectangle/RectVisual";
import { HexCardVisual } from "../../game/cards/layout/hexagon/HexVisual";
import {
  RECT_CARD_HEIGHT,
  RECT_CARD_WIDTH,
  type RectCardTitlePosition,
} from "../../game/cards/layout/rectangle/RectCard";
import { WORLD_HEX_RADIUS } from "../../game/world/hexSize";
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
 * existing RECT_CARD_WIDTH/HEIGHT constants). Display-time scaling is
 * the caller's responsibility — these textures are baked once at a
 * fixed size and re-used wherever the same definition is drawn.
 */
export class CardTextureManager {
  private readonly renderer: Renderer;
  private readonly textures: TextureManager;

  private readonly rectCache = new Map<number, Texture>();
  /** Hex bakes keyed by `(packedDef, bodyTextureUid)`. The body-
   *  texture id participates so a card def with `def.texture` set
   *  bakes one entry per resolved source texture — typically one per
   *  faction (`chorus`, `chord`, …) since the URL changes per
   *  faction folder. Defs without `def.texture` use uid `0` and
   *  bake once like before. */
  private readonly hexCache  = new Map<string, Texture>();
  /** Single-entry cache for the blank-rect texture — a rect card body
   *  with outline but no title bar and no label. Used by callers
   *  (today: `WrenchPanel`) that want the rect-card silhouette as a
   *  placeholder for slots without a resolved card definition. */
  private blankRectCache: Texture | null = null;

  private readonly rectVisual = new RectCardVisual();
  private readonly hexVisual  = new HexCardVisual(HEX_BAKE_RADIUS);

  constructor(renderer: Renderer, textures: TextureManager) {
    this.renderer = renderer;
    this.textures = textures;
  }

  /** Packed atlas texture for a rect card definition + title position.
   *  Bakes on first request; top/bottom are cached separately. A
   *  `null` definition produces a fallback-styled card (handled by
   *  RectCardVisual).
   *
   *  `label` is the display string baked into the title bar. Pass the
   *  locale-resolved string here (e.g. via
   *  `DefinitionManager.label(packed)`); when omitted, `RectCardVisual`
   *  falls back to `def.key`, which is the dev-side identifier and
   *  rarely the right thing to render. The label does not participate
   *  in the cache key — first bake for a given `(def, pos)` wins —
   *  so callers shouldn't mix label values for the same def. */
  getRect(
    definition: CardDefinition | null,
    titlePosition: RectCardTitlePosition,
    label?: string,
  ): Texture {
    const key = rectKey(definition, titlePosition);
    let tex = this.rectCache.get(key);
    if (!tex) {
      tex = this.bakeRect(definition, titlePosition, label);
      this.rectCache.set(key, tex);
    }
    return tex;
  }

  /** Packed atlas texture for a hex card definition. Bakes on first
   *  request and caches. A `null` definition produces a fallback-styled
   *  hex (handled by HexCardVisual) — used for empty world tiles.
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

  /** Atlas-packed texture for a rect-card-shaped placeholder — body
   *  fill + outline, no title bar, no label. Baked once on first call
   *  and cached. Caller-visible dimensions are `RECT_CARD_WIDTH ×
   *  RECT_CARD_HEIGHT` so it drops into the same Sprite slot as the
   *  per-def `getRect` textures.
   *
   *  Used by `WrenchPanel` to render blueprint slots whose bit is
   *  clear in the local soul's `blueprints_0` — unlocked slots swap
   *  to a per-def texture from `getRect(def, "top")` instead, which
   *  bakes the title bar + label. The visual contrast (presence vs
   *  absence of a title) is the "discovered?" cue. */
  getRectBlank(): Texture {
    if (this.blankRectCache !== null) return this.blankRectCache;
    // Body + outline only. Colors match the `FALLBACK_STYLE` background
    // in `RectVisual` so a blank slot reads as a darker `?`-less
    // variant of the fallback card.
    const visual = new Graphics();
    visual
      .rect(0, 0, RECT_CARD_WIDTH, RECT_CARD_HEIGHT)
      .fill({ color: 0x2a3340 });
    visual
      .rect(0, 0, RECT_CARD_WIDTH, RECT_CARD_HEIGHT)
      .stroke({ color: 0x4a5566, width: 2 });
    this.blankRectCache = this.renderAndPack(visual, RECT_CARD_WIDTH, RECT_CARD_HEIGHT);
    visual.destroy();
    return this.blankRectCache;
  }

  destroy(): void {
    this.rectVisual.destroy();
    this.hexVisual.destroy();
    this.rectCache.clear();
    this.hexCache.clear();
    this.blankRectCache = null;
  }

  private bakeRect(
    def: CardDefinition | null,
    pos: RectCardTitlePosition,
    label?: string,
  ): Texture {
    this.rectVisual.draw(def, pos, label);
    return this.renderAndPack(this.rectVisual, RECT_CARD_WIDTH, RECT_CARD_HEIGHT);
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

/** Cache key for `getRect`. Real definitions produce non-negative
 *  values via `(packed << 1) | bottomFlag`; `null` uses -1/-2 to
 *  encode the two title positions for the fallback card. */
function rectKey(def: CardDefinition | null, pos: RectCardTitlePosition): number {
  if (def === null) return pos === "bottom" ? -1 : -2;
  return (packedKey(def) << 1) | (pos === "bottom" ? 1 : 0);
}

function insetFrame(tex: Texture, inset: number): Texture {
  const { x, y, width, height } = tex.frame;
  return new Texture({
    source: tex.source,
    frame: new Rectangle(x + inset, y + inset, width - inset * 2, height - inset * 2),
  });
}
