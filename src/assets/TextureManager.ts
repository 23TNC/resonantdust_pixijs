import { Container, Rectangle, RenderTexture, Texture, type Renderer } from "pixi.js";
import type { CardDefinition } from "../definitions/DefinitionManager";
import { RectCardVisual } from "../cards/views/RectCardVisual";
import { HexCardVisual, HEX_WIDTH, HEX_HEIGHT } from "../cards/views/HexCardVisual";
import {
  RECT_CARD_WIDTH,
  RECT_CARD_HEIGHT,
  type RectCardTitlePosition,
} from "../cards/views/RectangleCard";

// Sentinel key for cards whose definition is unknown (fallback card style).
// Packed values are at most 16-bit (0x0000–0xFFFF) so values above are safely out of range.
const NULL_PACKED = 0x1FFFF;

/** Packed sentinel for empty world tiles (definition_id 0 / unknown zone). */
export const EMPTY_TILE_PACKED = 0x1FFFE;

// Fake definition used to drive HexCardVisual when rendering empty world tiles.
// secondary === primary so the inner band is invisible; name is blank.
const EMPTY_TILE_DEF: CardDefinition = {
  packed:       EMPTY_TILE_PACKED,
  typeId:       0,
  categoryId:   0,
  definitionId: 0,
  key:          "",
  typeName:     "",
  categoryName: "",
  name:         "",
  style:        ["#141e28", "#141e28", "#243040"],
  aspects:      [],
};

// ── Custom / hardcoded rect cards ────────────────────────────────────────────
// These are not in the definition files. Each gets a stable sentinel packed
// value for atlas caching. Add new entries here as needed.

export type CustomCard = "empty";

const CUSTOM_PACKED: Record<CustomCard, number> = {
  empty: 0x1FFFD,
};

const CUSTOM_DEFS: Record<CustomCard, CardDefinition> = {
  // Same neutral palette as the empty hex world tile.
  empty: {
    packed:       CUSTOM_PACKED.empty,
    typeId:       0,
    categoryId:   0,
    definitionId: 0,
    key:          "",
    typeName:     "",
    categoryName: "",
    name:         "",
    style:        ["#141e28", "#141e28", "#243040"],
    aspects:      [],
  },
};


/**
 * Encodes a rect atlas cache key.
 * Low bit = orientation (0 = top, 1 = bottom); upper bits = packed definition.
 */
function rectKey(packed: number, pos: RectCardTitlePosition): number {
  return (packed << 1) | (pos === "bottom" ? 1 : 0);
}

function queryMaxTextureSize(renderer: Renderer): number {
  const gl = (renderer as unknown as { gl?: WebGLRenderingContext }).gl;
  if (gl?.getParameter) {
    return gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  }
  return 2048;
}

/**
 * Manages one or more RenderTexture atlas pages for a single card size.
 * Cards are laid out in a grid; each unique slot is written once and held
 * permanently. Pages are allocated lazily as slots are consumed.
 */
class CardAtlas {
  private readonly pages: RenderTexture[] = [];
  private cursor = 0;

  private readonly cols: number;
  private readonly rows: number;
  private readonly slotsPerPage: number;

  constructor(
    private readonly renderer: Renderer,
    private readonly cardW: number,
    private readonly cardH: number,
    private readonly atlasSize: number,
  ) {
    this.cols = Math.floor(atlasSize / cardW);
    this.rows = Math.floor(atlasSize / cardH);
    this.slotsPerPage = this.cols * this.rows;
  }

  /** Render `visual` into the next free slot and return a sub-texture for it. */
  allocate(visual: Container): Texture {
    const slot       = this.cursor++;
    const pageIndex  = Math.floor(slot / this.slotsPerPage);
    const slotInPage = slot % this.slotsPerPage;
    const col        = slotInPage % this.cols;
    const row        = Math.floor(slotInPage / this.cols);

    while (this.pages.length <= pageIndex) {
      this.pages.push(RenderTexture.create({ width: this.atlasSize, height: this.atlasSize }));
    }

    const page = this.pages[pageIndex];
    const x    = col * this.cardW;
    const y    = row * this.cardH;

    visual.position.set(x, y);
    this.renderer.render({ container: visual, target: page, clear: false });
    visual.position.set(0, 0);

    return new Texture({ source: page.source, frame: new Rectangle(x, y, this.cardW, this.cardH) });
  }

  destroy(): void {
    for (const page of this.pages) page.destroy(true);
    this.pages.length = 0;
  }
}

/**
 * Shared texture atlas cache for card visuals. Reduces draw calls by ensuring
 * every card of the same definition shares a single GPU texture region.
 *
 * Rect cards hold two textures per definition — one for each title orientation
 * ("top" / "bottom"). Both are baked in the same pass the first time either
 * orientation is requested for a given definition, so a subsequent request for
 * the other orientation is always a cache hit.
 *
 * Hex cards hold one texture per definition.
 *
 * Atlas pages are sized to the largest texture the current WebGL context
 * supports. Pages are allocated lazily as new definitions are encountered.
 *
 * Usage:
 *   const tex = textureManager.getRectTexture(definition, packedDefinition, "top");
 *   sprite.texture = tex;
 */
export class TextureManager {
  private readonly rectAtlas: CardAtlas;
  private readonly hexAtlas:  CardAtlas;

  private readonly rectCache = new Map<number, Texture>();
  private readonly hexCache  = new Map<number, Texture>();

  // Staging visuals — one of each type, reused for every render-to-atlas call.
  private readonly rectStage = new RectCardVisual();
  private readonly hexStage  = new HexCardVisual();

  readonly atlasSize: number;

  constructor(renderer: Renderer) {
    this.atlasSize = queryMaxTextureSize(renderer);
    this.rectAtlas = new CardAtlas(renderer, RECT_CARD_WIDTH, RECT_CARD_HEIGHT, this.atlasSize);
    this.hexAtlas  = new CardAtlas(renderer, HEX_WIDTH,      HEX_HEIGHT,       this.atlasSize);
  }

  /**
   * Return a cached texture for the given rect card definition and title
   * position. On first request for a definition, both "top" and "bottom"
   * orientations are baked into the atlas in a single pass.
   */
  getRectTexture(
    definition: CardDefinition | null,
    packed: number,
    titlePosition: RectCardTitlePosition = "top",
  ): Texture {
    const key = rectKey(definition ? packed : NULL_PACKED, titlePosition);
    let tex = this.rectCache.get(key);
    if (!tex) {
      this.rectStage.draw(definition, titlePosition);
      tex = this.rectAtlas.allocate(this.rectStage);
      this.rectCache.set(key, tex);
    }
    return tex;
  }

  /** Return a cached rect texture for a hardcoded custom card. */
  getCustomRectTexture(card: CustomCard, titlePosition: RectCardTitlePosition = "top"): Texture {
    const packed = CUSTOM_PACKED[card];
    const key = rectKey(packed, titlePosition);
    let tex = this.rectCache.get(key);
    if (!tex) {
      this.rectStage.draw(CUSTOM_DEFS[card], titlePosition);
      tex = this.rectAtlas.allocate(this.rectStage);
      this.rectCache.set(key, tex);
    }
    return tex;
  }

  /**
   * Return a cached texture for the given hex card definition.
   * Renders into the atlas on first request.
   */
  getHexTexture(definition: CardDefinition | null, packed: number): Texture {
    const key = definition ? packed
              : packed === EMPTY_TILE_PACKED ? EMPTY_TILE_PACKED
              : NULL_PACKED;
    let tex = this.hexCache.get(key);
    if (!tex) {
      this.hexStage.draw(key === EMPTY_TILE_PACKED ? EMPTY_TILE_DEF : definition);
      tex = this.hexAtlas.allocate(this.hexStage);
      this.hexCache.set(key, tex);
    }
    return tex;
  }

  destroy(): void {
    this.rectAtlas.destroy();
    this.hexAtlas.destroy();
    this.rectStage.destroy();
    this.hexStage.destroy();
    for (const tex of this.rectCache.values()) tex.destroy();
    for (const tex of this.hexCache.values()) tex.destroy();
    this.rectCache.clear();
    this.hexCache.clear();
  }
}
