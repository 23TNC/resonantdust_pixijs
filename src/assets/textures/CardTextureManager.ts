import { Assets, Container, RenderTexture, type Renderer, type Texture } from "pixi.js";
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
  /** Card-art atlas cache. Keyed by the sprite basename passed to
   *  [`getCardArt`]. One entry per *sprite filename*, independent of
   *  which definitions reference it — sixteen soul portraits share
   *  the cache space of sixteen textures regardless of how many soul
   *  cards exist. Pairs with the per-def `hexCache` / `rectCache`
   *  bakes: the background is keyed per def, the art per filename. */
  private readonly artCache = new Map<string, Texture>();

  private readonly rectVisual = new RectCardVisual();
  private readonly hexVisual  = new HexCardVisual(HEX_BAKE_RADIUS);

  constructor(renderer: Renderer, textures: TextureManager) {
    this.renderer = renderer;
    this.textures = textures;
  }

  /** Packed atlas texture for a rect card definition + title position.
   *  Bakes on first request; top/bottom are cached separately. A
   *  `null` definition produces a fallback-styled card (handled by
   *  RectCardVisual). */
  getRect(definition: CardDefinition | null, titlePosition: RectCardTitlePosition): Texture {
    const key = rectKey(definition, titlePosition);
    let tex = this.rectCache.get(key);
    if (!tex) {
      tex = this.bakeRect(definition, titlePosition);
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

  /** Atlas-packed texture for a card-art sprite, addressed by the
   *  basename of its PNG (with or without `.png`, e.g.
   *  `"128_requisite_8"`). Resolves the basename to a bundled URL via
   *  [`cardSpriteUrlFor`], packs the source texture into the shared
   *  atlas on first request, and caches the result forever.
   *
   *  Returns `null` until the underlying PNG has been loaded into
   *  `Assets`. `main.ts` preloads every card-sprite URL at boot, so
   *  in practice callers see a hit immediately after init — the
   *  `null` branch only matters for assets added at runtime or for
   *  the (rare) frame between an unknown name landing and the asset
   *  registry warming. */
  getCardArt(name: string): Texture | null {
    const cached = this.artCache.get(name);
    if (cached) return cached;
    const url = cardSpriteUrlFor(name);
    if (!url) return null;
    const src = Assets.get<Texture>(url);
    if (!src) return null;
    const packed = this.textures.pack(src);
    this.artCache.set(name, packed);
    return packed;
  }

  destroy(): void {
    this.rectVisual.destroy();
    this.hexVisual.destroy();
    this.rectCache.clear();
    this.hexCache.clear();
    this.artCache.clear();
  }

  private bakeRect(def: CardDefinition | null, pos: RectCardTitlePosition): Texture {
    this.rectVisual.draw(def, pos);
    return this.renderAndPack(this.rectVisual, RECT_CARD_WIDTH, RECT_CARD_HEIGHT);
  }

  private bakeHex(def: CardDefinition | null): Texture {
    this.hexVisual.draw(def);
    const w = Math.ceil(Math.sqrt(3) * HEX_BAKE_RADIUS);
    const h = 2 * HEX_BAKE_RADIUS;
    return this.renderAndPack(this.hexVisual, w, h);
  }

  /** Render a card visual into a temp RenderTexture sized to its
   *  bounding box, hand it to TextureManager for atlas placement,
   *  then destroy the temp. The returned Texture points into the
   *  atlas — the temp source is no longer referenced. */
  private renderAndPack(container: Container, w: number, h: number): Texture {
    const rt = RenderTexture.create({ width: w, height: h });
    this.renderer.render({ container, target: rt, clear: true });
    const packed = this.textures.pack(rt);
    rt.destroy(true);
    return packed;
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
