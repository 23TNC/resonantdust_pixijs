import { Assets, Container, Graphics, Rectangle, RenderTexture, Texture, type Renderer } from "pixi.js";
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
import { cardSpriteUrlFor } from "../objectUrls";

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
  private readonly hexCache  = new Map<number, Texture>();
  /** Single-entry cache for the blank-rect texture — a rect card body
   *  with outline but no title bar and no label. Used by callers
   *  (today: `WrenchPanel`) that want the rect-card silhouette as a
   *  placeholder for slots without a resolved card definition. */
  private blankRectCache: Texture | null = null;
  /** Card-art atlas cache. Keyed by the sprite basename passed to
   *  [`getCardArt`]. One entry per *sprite filename*, independent of
   *  which definitions reference it — sixteen soul portraits share
   *  the cache space of sixteen textures regardless of how many soul
   *  cards exist. Pairs with the per-def `hexCache` / `rectCache`
   *  bakes: the background is keyed per def, the art per filename. */
  private readonly artCache = new Map<string, Texture>();
  /** Sprite basenames currently in the middle of an async
   *  `Assets.load` call. Deduplicates concurrent `getCardArt` requests
   *  for the same name so we don't trigger the same network fetch N
   *  times when many cards spawn at once referencing a not-yet-loaded
   *  sprite. Cleared once the load resolves and the result is packed
   *  into [`artCache`]. */
  private readonly artLoading = new Set<string>();
  /** Subscribers to `onArtLoad`. Fired once per sprite as soon as its
   *  texture lands in [`artCache`], so cards that hit the `null`
   *  branch on first request can re-sync without polling. Mirror of
   *  `ObjectTextureManager.onLoad`. */
  private readonly artLoadListeners = new Set<() => void>();

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
  getHex(definition: CardDefinition | null): Texture {
    const key = hexKey(definition);
    let tex = this.hexCache.get(key);
    if (!tex) {
      tex = this.bakeHex(definition);
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

  /** Atlas-packed texture for a card-art sprite, addressed by the
   *  basename of its PNG (with or without `.png`, e.g.
   *  `"128_requisite_8"`). Resolves the basename to a bundled URL via
   *  [`cardSpriteUrlFor`], packs the source texture into the shared
   *  atlas on first request, and caches the result forever.
   *
   *  Returns `null` when the PNG hasn't been loaded into `Assets`
   *  yet. Two cases hit that branch:
   *  - **Preloaded sprites** ([`corePreloadUrls`]): only `null` for
   *    the rare frame between an unknown name landing and the
   *    asset registry warming.
   *  - **Lazy-loaded sprites** (everything outside the preload set,
   *    e.g. tile art): `null` for as long as the PNG is in flight.
   *    First miss triggers `Assets.load(url)`; the load is deduped
   *    via [`artLoading`] so N concurrent callers share one fetch.
   *    On resolution the texture is packed and cached, and every
   *    [`onArtLoad`] subscriber fires so cards that skipped a frame
   *    can re-render. */
  getCardArt(name: string): Texture | null {
    const cached = this.artCache.get(name);
    if (cached) return cached;
    const url = cardSpriteUrlFor(name);
    if (!url) return null;
    const src = Assets.get<Texture>(url);
    if (src) {
      const packed = this.textures.pack(src);
      this.artCache.set(name, packed);
      return packed;
    }
    if (!this.artLoading.has(name)) {
      this.artLoading.add(name);
      void this.loadCardArt(name, url);
    }
    return null;
  }

  /** Subscribe to card-art load completions. Fires once per sprite
   *  the moment its texture lands in [`artCache`] (whether triggered
   *  by lazy `getCardArt` or by a future eager-load API), so cards
   *  that hit the `null` branch on a previous `applyCardArt` call
   *  can re-resolve without polling. Mirror of
   *  `ObjectTextureManager.onLoad`. Returns an unsubscribe fn. */
  onArtLoad(callback: () => void): () => void {
    this.artLoadListeners.add(callback);
    return () => this.artLoadListeners.delete(callback);
  }

  private async loadCardArt(name: string, url: string): Promise<void> {
    try {
      const tex = await Assets.load<Texture>(url);
      this.artCache.set(name, this.textures.pack(tex));
    } finally {
      this.artLoading.delete(name);
      for (const cb of [...this.artLoadListeners]) cb();
    }
  }

  destroy(): void {
    this.rectVisual.destroy();
    this.hexVisual.destroy();
    this.rectCache.clear();
    this.hexCache.clear();
    this.blankRectCache = null;
    this.artCache.clear();
    this.artLoading.clear();
    this.artLoadListeners.clear();
  }

  private bakeRect(
    def: CardDefinition | null,
    pos: RectCardTitlePosition,
    label?: string,
  ): Texture {
    this.rectVisual.draw(def, pos, label);
    return this.renderAndPack(this.rectVisual, RECT_CARD_WIDTH, RECT_CARD_HEIGHT);
  }

  private bakeHex(def: CardDefinition | null): Texture {
    this.hexVisual.draw(def);
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

/** Cache key for `getHex`. Real definitions produce non-negative
 *  packed ids; `null` uses -1 as a sentinel. */
function hexKey(def: CardDefinition | null): number {
  return def === null ? -1 : packedKey(def);
}

/** Cache key for `getRect`. Real definitions produce non-negative
 *  values via `(packed << 1) | bottomFlag`; `null` uses -1/-2 to
 *  encode the two title positions for the fallback card. */
function rectKey(def: CardDefinition | null, pos: RectCardTitlePosition): number {
  if (def === null) return pos === "bottom" ? -1 : -2;
  return (packedKey(def) << 1) | (pos === "bottom" ? 1 : 0);
}
