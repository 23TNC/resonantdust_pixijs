// ════════════════════════════════════════════════════════════════════════
// LEGACY — non-generic render pipeline. DISABLED: no longer instantiated now
// that every card renders through the generic PrimList pipeline (LayoutGenericCard
// + the `^`-prim DSL builders). Kept for reference; MARKED FOR CLEANUP — delete
// once the generic pipeline is fully stable.
// ════════════════════════════════════════════════════════════════════════
import { Graphics } from "pixi.js";
import type { DefinitionManager } from "../../../definitions/DefinitionManager";
import type { Soul } from "../../../../server/spacetime/bindings/types";
import {
  RECT_CARD_HEIGHT,
  RECT_CARD_TITLE_HEIGHT,
  RECT_CARD_WIDTH,
  type RectCardTitlePosition,
} from "./RectCard";

/** Visual ordering of the four resource clusters around the card
 *  body corners — top-left → top-right → bottom-left → bottom-right.
 *  Distinct from the byte-packing order in `soul.stats` /
 *  `soul.fatigued` / `soul.injured` (corpus / anima / sollertia /
 *  aether — bytes 0..3), so we map cluster → byte via `STAT_BYTE`. */
const RESOURCE_KEYS = ["corpus", "sollertia", "aether", "anima"] as const;
type ResourceKey = (typeof RESOURCE_KEYS)[number];

/** Byte index inside the Soul u32 packs. Mirrors the Rust-side
 *  packing — keep in sync with the `stat_map` block in `souls.rs`. */
const STAT_BYTE: Record<ResourceKey, number> = {
  corpus:    0,
  anima:     1,
  sollertia: 2,
  aether:    3,
};

const METER_SQUARE          = 5;
const METER_STRIDE          = 7;
const METER_INSET           = 2;
const METER_CAP_PER_CLUSTER = 10;
const FALLBACK_COLOR        = 0x7a7a8a;

/** Each cluster lives in a corner. `cornerX/cornerY` are the body-
 *  relative pixel coords of the *corner-most* square (col 0, row 0
 *  in the cluster's own basis). `dxCol/dxRow` step away from that
 *  corner: cols stride horizontally toward the card centre, rows
 *  stride vertically toward the card centre. Fill is column-major
 *  (col 0 fully, then col 1). */
interface ClusterLayout {
  cornerX: number;
  cornerY: number;
  dxCol: number;
  dxRow: number;
  dyCol: number;
  dyRow: number;
}

/** Lazy cache for the four cluster layouts. We can't initialise the
 *  table at module scope because the corner coordinates depend on
 *  `RECT_CARD_WIDTH` / `RECT_CARD_HEIGHT` / `RECT_CARD_TITLE_HEIGHT`
 *  from `RectCard.ts`, and the two modules import each other —
 *  reading those constants during top-level evaluation hits the
 *  ESM cycle's TDZ. By the time `update()` first runs (layout
 *  time), both modules are fully loaded and the constants are
 *  defined. Built once, reused forever. */
let clusterLayoutsCache: Record<ResourceKey, ClusterLayout> | null = null;

function getClusterLayouts(): Record<ResourceKey, ClusterLayout> {
  if (clusterLayoutsCache) return clusterLayoutsCache;
  clusterLayoutsCache = {
    // top-left, col→right, row→down
    corpus:    { cornerX: METER_INSET,
                 cornerY: METER_INSET,
                 dxCol:  METER_STRIDE, dyCol: 0,
                 dxRow:  0,            dyRow:  METER_STRIDE },
    // top-right, col→left, row→down
    sollertia: { cornerX: RECT_CARD_WIDTH - METER_INSET - METER_SQUARE,
                 cornerY: METER_INSET,
                 dxCol: -METER_STRIDE, dyCol: 0,
                 dxRow:  0,            dyRow:  METER_STRIDE },
    // bottom-left, col→right, row→up
    aether:    { cornerX: METER_INSET,
                 cornerY: (RECT_CARD_HEIGHT - RECT_CARD_TITLE_HEIGHT) - METER_INSET - METER_SQUARE,
                 dxCol:  METER_STRIDE, dyCol: 0,
                 dxRow:  0,            dyRow: -METER_STRIDE },
    // bottom-right, col→left, row→up
    anima:     { cornerX: RECT_CARD_WIDTH - METER_INSET - METER_SQUARE,
                 cornerY: (RECT_CARD_HEIGHT - RECT_CARD_TITLE_HEIGHT) - METER_INSET - METER_SQUARE,
                 dxCol: -METER_STRIDE, dyCol: 0,
                 dxRow:  0,            dyRow: -METER_STRIDE },
  };
  return clusterLayoutsCache;
}

/** Cluster color pair: `stats` is the bare resource's body color
 *  (`def("corpus").style[0]`), `fatigued` is the `-` variant's body
 *  color. Cached at module scope on first access — content
 *  definitions are immutable for a session and the lookup crosses a
 *  wasm boundary. */
interface ClusterColors {
  stats: number;
  fatigued: number;
}

let clusterColorCache: Record<ResourceKey, ClusterColors> | null = null;

function parseHexColor(hex: string): number {
  if (hex.length === 7 && hex[0] === "#") {
    const n = parseInt(hex.slice(1), 16);
    if (!Number.isNaN(n)) return n & 0xffffff;
  }
  return FALLBACK_COLOR;
}

function getClusterColors(defs: DefinitionManager): Record<ResourceKey, ClusterColors> {
  if (clusterColorCache) return clusterColorCache;
  const colorOf = (key: string): number => {
    const packed = defs.findPackedByKey(key);
    if (packed === undefined) return FALLBACK_COLOR;
    const def = defs.decode(packed);
    if (!def) return FALLBACK_COLOR;
    return parseHexColor(def.style[0]);
  };
  clusterColorCache = {
    corpus:    { stats: colorOf("corpus"),    fatigued: colorOf("corpus-") },
    sollertia: { stats: colorOf("sollertia"), fatigued: colorOf("sollertia-") },
    aether:    { stats: colorOf("aether"),    fatigued: colorOf("aether-") },
    anima:     { stats: colorOf("anima"),     fatigued: colorOf("anima-") },
  };
  return clusterColorCache;
}

/**
 * Per-soul resource meter — four 2×5 corner clusters of 5×5 squares
 * reading `soul.stats` / `soul.fatigued` u32s (bytes corpus / anima /
 * sollertia / aether). Stats squares paint first in the cluster's
 * base color; fatigue squares paint after in the `-` variant color,
 * sharing the 10-square cap per cluster.
 *
 * Stateless beyond its `Graphics` node — the host (`LayoutRectCard`)
 * pulls the `Soul` row from `data.soulsLocal` each layout pass and
 * passes it to `update(soul, titlePosition)`. Non-soul cards pass
 * `null` and the graphics stay cleared.
 *
 * Color resolution caches at module scope on first call so the
 * per-frame `update` doesn't re-cross the wasm boundary for the
 * eight cluster colours.
 */
export class SoulResourceMeter {
  readonly graphics = new Graphics();
  private readonly definitions: DefinitionManager;

  constructor(definitions: DefinitionManager) {
    this.definitions = definitions;
  }

  /** Repaint for the given Soul row. `null` clears the meter — call
   *  this every layout pass on rect cards regardless of soul/non-soul
   *  status; non-soul cards just hit the early-return path. */
  update(soul: Soul | null, titlePosition: RectCardTitlePosition = "top"): void {
    this.graphics.clear();
    if (!soul) return;
    const colors = getClusterColors(this.definitions);
    // Body origin in card-local pixels. For souls we expect `top`
    // titles but compute from `titlePosition` so the meter follows
    // the card if the layout ever flips direction (chain DOWN cards
    // have their title bar on the bottom).
    const bodyTop = titlePosition === "top" ? RECT_CARD_TITLE_HEIGHT : 0;
    const layouts = getClusterLayouts();

    for (const key of RESOURCE_KEYS) {
      const byteIdx = STAT_BYTE[key];
      const statsCount   = (soul.stats    >>> (byteIdx * 8)) & 0xff;
      const fatigueCount = (soul.fatigued >>> (byteIdx * 8)) & 0xff;
      if (statsCount === 0 && fatigueCount === 0) continue;

      const layout = layouts[key];
      const clusterColors = colors[key];
      // Stats first, then fatigue, sharing the 10-square cap.
      const statsToDraw   = Math.min(statsCount, METER_CAP_PER_CLUSTER);
      const fatigueToDraw = Math.min(fatigueCount, METER_CAP_PER_CLUSTER - statsToDraw);

      let slot = 0;
      for (let i = 0; i < statsToDraw; i++) {
        this.drawSquare(layout, bodyTop, slot++, clusterColors.stats);
      }
      for (let i = 0; i < fatigueToDraw; i++) {
        this.drawSquare(layout, bodyTop, slot++, clusterColors.fatigued);
      }
    }
  }

  /** Place one 5×5 square at column-major `slot` of a cluster. Col 0
   *  is the corner-most column; rows fill top-down (top clusters) or
   *  bottom-up (bottom clusters) per the layout's `dyRow` sign. 5
   *  rows per column → col = `floor(slot/5)`, row = `slot % 5`. */
  private drawSquare(
    layout: ClusterLayout,
    bodyTop: number,
    slot: number,
    color: number,
  ): void {
    const col = Math.floor(slot / 5);
    const row = slot % 5;
    const x = layout.cornerX + col * layout.dxCol + row * layout.dxRow;
    const y = bodyTop + layout.cornerY + col * layout.dyCol + row * layout.dyRow;
    this.graphics.rect(x, y, METER_SQUARE, METER_SQUARE).fill({ color });
  }
}
