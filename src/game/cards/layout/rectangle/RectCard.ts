import { Container, Graphics, ParticleContainer, RenderTexture, Sprite, Text } from "pixi.js";
import type { GameContext } from "../../../../GameContext";
import type { CardDefinition, DefinitionManager } from "../../../definitions/DefinitionManager";
import type { Card as CardRow, Soul } from "../../../../server/spacetime/bindings/types";
import type { LocalCard } from "../../../../server/data/DataManager";
import { ParticleManager, type ParticleHandle } from "../../../../assets/ParticleManager";
import {
  decodeLooseXY,
  getStackDirection,
  getStackedState,
  STACK_DIRECTION_UP,
  STACKED_LOOSE,
  STACKED_ON_HEX,
  STACKED_ON_ROOT,
  STACKED_SLOT,
  type LooseXY,
} from "../../cardData";
import { GameHexCard, LayoutHexCard } from "../hexagon/HexCard";
import { WORLD_HEX_RADIUS } from "../../../world/hexSize";
import { GameCard } from "../../game/CardGame";
import { LayoutCard } from "../CardLayout";
import { RectCardVisual } from "./RectVisual";
import { unpackMacroZone, WORLD_LAYER } from "../../../../server/data/packing";
import { debug } from "../../../../debug";

const DEATH_SPEED = 0.04;

/** Card-art square sized to this fraction of the card body's shorter
 *  dimension. <1 keeps a margin so the art doesn't touch the title
 *  bar or card edges. Matches the value previously baked into
 *  `RectCardVisual.applySprite` before the art layer moved here. */
const ART_BODY_FRACTION = 0.85;

/** How far to shift the title-bar color toward black/white for the
 *  action-debounce progress fill. The fill picks brighter when the
 *  base is dark and darker when the base is light, so the bar
 *  always contrasts against the unfilled remainder. */
const PROGRESS_LUMA_SHIFT = 0.35;

/** Parse a `#rrggbb` hex string into a 24-bit integer. Returns
 *  `0x7a7a8a` (the fallback title color) if the string is malformed. */
function parseHexColor(hex: string): number {
  if (hex.length === 7 && hex[0] === "#") {
    const n = parseInt(hex.slice(1), 16);
    if (!Number.isNaN(n)) return n & 0xffffff;
  }
  return 0x7a7a8a;
}

/** Shift a color's luminance toward black or white by
 *  `PROGRESS_LUMA_SHIFT`. Brightens when the input is dark, darkens
 *  when it's light — the result always sits visibly off the original. */
function shiftLuminance(hex: string): number {
  const rgb = parseHexColor(hex);
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  // Rec. 709 luma (0..255).
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const target = luma < 128 ? 255 : 0;
  const t = PROGRESS_LUMA_SHIFT;
  const shift = (c: number) => Math.round(c + (target - c) * t);
  return (shift(r) << 16) | (shift(g) << 8) | shift(b);
}

export const CARD_SCALE = 1;
export const RECT_CARD_WIDTH        = 72 * CARD_SCALE;
export const RECT_CARD_HEIGHT       = 96 * CARD_SCALE;
export const RECT_CARD_TITLE_HEIGHT = 24;

/** Soul resource meter — four 2×5 square clusters anchored at the
 *  card-body corners. Each cluster reads one byte of `soul.stats`
 *  (live cards) and one byte of `soul.fatigued` (the `-` variants);
 *  squares fill column-major inward from the anchored corner, stats
 *  first then fatigue. Colors come from the matching card
 *  definition's `style[0]` (cached once per process).
 *
 *  Byte order on `soul.stats` / `soul.fatigued` / `soul.injured`
 *  follows the server-side packing in `spacetime/.../souls.rs`:
 *  byte 0 = corpus, 1 = anima, 2 = sollertia, 3 = aether (same
 *  across all three fields). Cluster *layout* uses a different
 *  visual ordering (corpus / sollertia / aether / anima around the
 *  card corners), so we map cluster → byte via `STAT_BYTE`. */
const RESOURCE_KEYS = ["corpus", "sollertia", "aether", "anima"] as const;
type ResourceKey = (typeof RESOURCE_KEYS)[number];

/** Byte index inside `soul.stats` / `soul.fatigued` / `soul.injured`
 *  for each cluster. Mirrors the Rust-side packing — keep in sync
 *  with the `stat_map` block in `souls.rs`. */
const STAT_BYTE: Record<ResourceKey, number> = {
  corpus:    0,
  anima:     1,
  sollertia: 2,
  aether:    3,
};

const METER_SQUARE        = 5;
const METER_STRIDE        = 7;
const METER_INSET         = 2;
const METER_CAP_PER_CLUSTER = 10;

/** Each cluster lives in a corner. `cornerX/cornerY` are the body-
 *  relative pixel coords of the *corner-most* square (col 0, row 0
 *  in the cluster's own basis). `dxCol/dxRow` step away from that
 *  corner: cols stride horizontally toward the card center, rows
 *  stride vertically toward the card center. Fill is column-major
 *  (col 0 fully, then col 1) per the user's spec. */
interface ClusterLayout {
  cornerX: number;
  cornerY: number;
  dxCol: number;
  dxRow: number;
  dyCol: number;
  dyRow: number;
}

const CLUSTER_LAYOUTS: Record<ResourceKey, ClusterLayout> = {
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

/** Cluster color pair: `stats` is the bare resource's body color
 *  (`def("corpus").style[0]`), `fatigued` is the `-` variant's body
 *  color (`def("corpus-").style[0]`). Cached at module scope on
 *  first access — the content definitions are immutable for a
 *  session, and the lookup goes through wasm so we don't want to
 *  repeat it per render. */
interface ClusterColors {
  stats: number;
  fatigued: number;
}

const FALLBACK_COLOR = 0x7a7a8a;

let clusterColorCache: Record<ResourceKey, ClusterColors> | null = null;

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

export type RectCardTitlePosition = "top" | "bottom";

/** One stacked progress bar in the title area. `fraction` is the fill
 *  amount in `[0, 1]`; `style` is the `progress_style` u3 (1 = ltr,
 *  2 = rtl); `leftColor` is the fill color; `heightCap` (optional) is
 *  the maximum bar height as a fraction of `RECT_CARD_TITLE_HEIGHT`,
 *  shrinking the bar within its `1/N` slot when the cap is tighter. */
interface ProgressBarSpec {
  fraction: number;
  style: number;
  leftColor: number;
  heightCap?: number;
}

export class GameRectCard extends GameCard {
  private stackedState = 0;
  private microLocation = 0;

  applyData(row: CardRow): void {
    this.stackedState = getStackedState(row.microZone);
    this.microLocation = row.microLocation;
  }

  isLoose(): boolean {
    return this.stackedState === STACKED_LOOSE;
  }

  getLoosePosition(): LooseXY | null {
    if (!this.isLoose()) return null;
    return decodeLooseXY(this.microLocation);
  }

  override whereAreYou(): { x: number; y: number } {
    return this.getLoosePosition() ?? { x: 0, y: 0 };
  }
}

export class LayoutRectCard extends LayoutCard {
  static readonly WIDTH  = RECT_CARD_WIDTH;
  static readonly HEIGHT = RECT_CARD_HEIGHT;

  private readonly visual       = new Container();
  private readonly rectVisual   = new RectCardVisual();
  /** Per-instance card art sprite. Texture is resolved on demand
   *  from `CardTextureManager.getCardArt(name)` so the atlas-packed
   *  texture is shared across every card referencing the same art
   *  filename (e.g. all "axe" cards share one `128_requisite_8`
   *  texture; the 16 human portraits each get one texture regardless
   *  of how many soul cards exist). Sized to a fraction of the card
   *  body in `layout()`; hidden when the def declares no sprite. */
  private readonly artSprite    = new Sprite();
  private readonly progressBar  = new Graphics();
  private readonly stateOverlay = new Graphics();
  /** Magnetic-anchor indicator — a tiny 🧲 in the corner of the card,
   *  shown when `row.flags` has the `magnetic` bit (bit 12, declared
   *  in `content/cards/flags.json`). Set by the server's
   *  `magnetic::install` path on the anchor of an installed
   *  on_create.magnetic recipe; signals "this card is acting as a
   *  magnetic anchor and is pulling cards onto itself." Purely
   *  cosmetic; the chain pulled by the magnetic action renders via
   *  the normal rect-chain path (state-2 OnRoot, microLocation =
   *  anchor_id) so no other rendering changes are needed.
   *
   *  Naming note: the Rust constant is `FLAG_LIFECYCLE_PENDING`, but the
   *  registry name in `flags.json` is `"magnetic"`. `hasCardFlag` is
   *  keyed off the registry. */
  private readonly magneticText: Text;
  /** Soul-card resource meter — four 2×5 clusters of squares, one
   *  per faculty type (`corpus` top-left, `sollertia` top-right,
   *  `aether` bottom-left, `anima` bottom-right). Each cluster reads
   *  one byte of `soul.stats` (live cards, painted in the base
   *  color) followed by one byte of `soul.fatigued` (the `-`
   *  variants, painted in the variant color). Squares fill
   *  column-major inward from the anchored corner; the cluster caps
   *  at 10 total visible squares.
   *
   *  Visible whenever a Soul row exists in `soulsLocal` for this
   *  card's id — works for any soul card in scope (the local
   *  player's, and remote players' once their world zone is
   *  subscribed). For non-soul rect cards the Graphics is cleared
   *  each frame and draws nothing.
   *
   *  Update path: a per-key `subscribeLocalSoulKey(this.cardId)`
   *  listener invalidates on every Soul row change. Counts come
   *  straight off the row (just bit-shifts on `stats` / `fatigued`),
   *  so no walk is needed — the dirty-flag pattern that the
   *  cardsLocal version used is gone. */
  private readonly resourceMeter = new Graphics();
  private unsubResourceMeter: (() => void) | null = null;
  private currentPackedDefinition: number | null = null;
  /** Last-seen `row.flags`. Cached so `layout()` can derive the soul
   *  portrait sprite (top-nibble `portrait_id`) without re-fetching
   *  the row, and so we can invalidate on the rare flag change that
   *  actually affects rendering (portrait shouldn't change after
   *  spawn, but tracking flags keeps `applyData` honest in case
   *  future features add render-relevant fields). */
  private currentFlags = 0;
  private titlePosition: RectCardTitlePosition = "top";
  private dying = false;
  private deathProgress = 0;
  private readonly deathMask = new Graphics();
  private unsubDying: (() => void) | null = null;
  private deathParticleContainer: ParticleContainer | null = null;
  private deathParticleHandle: ParticleHandle | null = null;

  /** Per-card "objects in front of this card" snapshot. Same idea as
   *  LayoutHexCard's overlay — lazily created when a rect card lands
   *  on a world tile (STACKED_ON_HEX with no parent), refreshed when
   *  the tile changes or when an object texture pack finishes loading. */
  /** Own RenderTexture for the in-front-objects overlay. Each card
   *  bakes its own — chain rects pull `(q, r, offset)` from their
   *  parent and bake into their own RT (no sub-Texture sharing,
   *  which caused alignment + scene-tree-cycle problems).
   *
   *  Public so stacked children can read parent state and derive
   *  their own (q, r, offset) without going through `cardsLocal`. */
  private overlayTexture: RenderTexture | null = null;
  private overlaySprite: Sprite | null = null;
  overlayQ: number | null = null;
  overlayR: number | null = null;
  overlayOffsetX = 0;
  overlayOffsetY = 0;
  /** Displacement of our centre from our parent's centre, in world
   *  pixels (parent's frame == card frame here since stacking doesn't
   *  scale). Set in applyData based on stack direction. Combined with
   *  the parent's `(overlayOffsetX, overlayOffsetY)` to derive our
   *  own offset when the parent pushes via `inheritObjectOverlay`. */
  private chainDeltaX = 0;
  private chainDeltaY = 0;
  private unsubObjectLoad: (() => void) | null = null;
  private unsubTileChange: (() => void) | null = null;
  private unsubArtLoad: (() => void) | null = null;

  constructor(cardId: number, ctx: GameContext) {
    super(cardId, ctx);
    // TODO: re-wire death detection. The old `change.kind === "dying"` event
    // was emitted by ShadowedStore on a flag-bit transition — gone with the
    // rewrite. New mechanism TBD (likely a card-flag bit watched here, or a
    // dedicated "dying" event surface on DataManager).
    //
    // this.unsubDying = ctx.data.cards.subscribeKey(cardId, (change) => {
    //   if (change.kind === "dying") {
    //     this.dying = true;
    //     this.deathProgress = 0;
    //     this.visual.mask = this.deathMask;
    //     this._spawnDeathEffect();
    //     this.invalidate();
    //   }
    // });
    // Z-order (back to front):
    //   1. rectVisual  — owns the body fill (re-parented children
    //                    below are pulled out into `visual`)
    //   2. artSprite   — per-instance card art / portrait
    //   3. titleBar    — title-bar fill, re-parented out of rectVisual
    //   4. progressBar — debounce countdown, paints over the title fill
    //   5. nameText    — title label, above progressBar so it stays
    //                    readable while a bar is filling
    //   6. cardOutline — card border, above everything readable so a
    //                    progress bar doesn't notch its title-bar edge
    //   7. stateOverlay — hover / pending decoration
    //
    // `refreshObjectOverlay` later splices the in-front-objects
    // sprite between (2) and (3) by re-adding (3..6) on top of it —
    // keeps the body / art behind the overlay (so trees occlude them
    // as intended) while the title fill, label, and outline stay
    // readable through the 75%-alpha overlay.
    this.visual.addChild(this.rectVisual);
    this.artSprite.anchor.set(0.5, 0.5);
    this.artSprite.visible = false;
    this.visual.addChild(this.artSprite);
    this.visual.addChild(this.rectVisual.titleBar);
    this.visual.addChild(this.progressBar);
    this.visual.addChild(this.rectVisual.nameText);
    this.visual.addChild(this.rectVisual.cardOutline);
    this.visual.addChild(this.stateOverlay);
    // Magnetic indicator — top-right anchored, hidden until the
    // `magnetic` flag (bit 12) is observed on the row. Sits above
    // stateOverlay so hover/pending outlines don't occlude it.
    this.magneticText = new Text({
      text: "🧲",
      style: { fontSize: 14 },
    });
    this.magneticText.anchor.set(1, 0);
    this.magneticText.visible = false;
    this.visual.addChild(this.magneticText);
    // Soul resource meter. Added above stateOverlay so hover/pending
    // outlines don't occlude it; below magneticText/cardOutline for
    // z-order consistency with other rect-card decorations.
    this.visual.addChild(this.resourceMeter);
    this.container.addChild(this.deathMask);
    this.container.addChild(this.visual);
    this.setSize(RECT_CARD_WIDTH, RECT_CARD_HEIGHT);

    // Invalidate on every Soul row change in scope, not just this
    // card's. The per-key variant `subscribeLocalSoulKey(cardId, …)`
    // is theoretically tighter but missed live stat updates in
    // practice — adding/removing inventory cards triggers
    // `apply_slot_delta` server-side, which writes a fresh soul
    // row, which fires mirrorSoul on the client; in normal play we
    // only saw the listener fire after movement-driven soul updates.
    // The global variant routes around any key-match subtlety in the
    // mirror path. Cost is one `invalidate` per soul update; for
    // non-soul rect cards the layout's `soulsLocal.get(cardId)` lookup
    // returns `undefined` and the meter draws nothing, so the extra
    // invalidate is essentially free.
    this.unsubResourceMeter = ctx.data.subscribeLocalSoul(() => {
      this.invalidate();
    });

    // Refresh the in-front-objects overlay whenever an object texture
    // pack finishes loading — the first snapshot a card builds when
    // placed can miss sprites whose pack was still loading.
    this.unsubObjectLoad = ctx.objectTextures.onLoad(() => {
      if (this.overlayQ !== null && this.overlayR !== null) {
        this.refreshObjectOverlay(this.overlayQ, this.overlayR);
      }
    });
    // Re-bake when world tile data lands or updates so the overlay
    // tracks new trees / terrain changes underneath.
    this.unsubTileChange = ctx.onTilesChanged?.(() => {
      if (this.overlayQ !== null && this.overlayR !== null) {
        this.refreshObjectOverlay(this.overlayQ, this.overlayR, this.overlayOffsetX, this.overlayOffsetY);
      }
    }) ?? null;

    // Re-apply card art whenever a sprite finishes lazy-loading. A
    // card whose def references a sprite outside `corePreloadUrls`
    // gets `null` from `getCardArt` on the first frame and hides the
    // art layer; the load completes asynchronously and fires
    // `onArtLoad`, at which point we re-resolve. The listener is a
    // broadcast (no per-name filter) — re-running `applyCardArt`
    // hits the cache for sprites we've already resolved, and the
    // per-card cost is one Map lookup. Marks the layout dirty so the
    // next layout pass picks up the new texture (`layout()` calls
    // `applyCardArt(def)` itself).
    this.unsubArtLoad = ctx.cardTextures.onArtLoad(() => {
      this.invalidate();
    });
  }

  setTitlePosition(position: RectCardTitlePosition): void {
    if (this.titlePosition === position) return;
    this.titlePosition = position;
    this.invalidate();
  }

  applyData(row: CardRow): void {
    if (row.packedDefinition !== this.currentPackedDefinition) {
      this.currentPackedDefinition = row.packedDefinition;
      this.invalidate();
    }
    if (row.flags !== this.currentFlags) {
      this.currentFlags = row.flags;
      this.invalidate();
    }

    // Magnetic anchor indicator visibility — toggled here so it reacts
    // immediately to `magnetic` (bit 12) flips on the server row.
    // Position is set in `layout()` once `titlePosition` is known.
    const wasMagneticVisible = this.magneticText.visible;
    this.magneticText.visible = this.ctx.definitions.hasCardFlag(row.flags, "magnetic");
    if (wasMagneticVisible !== this.magneticText.visible) this.invalidate();

    // `dead === 1` is set by `DataManager.mirrorCard` when the server row's
    // FLAG_ACTION_DEAD bit is observed. Start the death animation once on
    // that transition; `this.dying` guards re-entry, and once we write back
    // `dead: 2` (in the layout completion branch) the mirror preserves the
    // 2 across further pushes so we don't replay.
    //
    // Deferral on `slot_hold`: if the dead row ALSO carries slot_hold,
    // a concurrent recipe is still holding this card. Forward-prop
    // layered slot_hold onto the death row from a later chain_stitch
    // (e.g. a task claimed a fleeting card whose lifecycle had
    // pre-scheduled its death). The holding recipe's
    // `action_completion` will eventually write a new row clearing
    // slot_hold, mirrored back to the client — applyData re-runs and
    // the condition becomes true. Until then we sit in "pending
    // death" visually alive, so the player sees the card live
    // through the recipe rather than dying mid-task.
    // `isSlotHeld` unions `slot_hold` with the client-only
    // `predict_slot_hold` set by `ActionManager` during the propose
    // round-trip — covers the window where the server's slot_hold
    // hasn't arrived yet but we've already committed to a recipe.
    const slotHeld = this.ctx.definitions.isSlotHeld(row.flags);
    if ((row as LocalCard).dead === 1 && !this.dying && !slotHeld) {
      this.dying = true;
      this.deathProgress = 0;
      this.visual.mask = this.deathMask;
      this._spawnDeathEffect();
      this.invalidate();
    }

    const stacked = getStackedState(row.microZone);

    if (stacked === STACKED_LOOSE) {
      this.setTitlePosition("top");
      if (row.surface >= WORLD_LAYER) {
        // LOOSE on a world surface — the hex address lives in
        // `macroZone` (chunk q/r) + `microZone` (local q/r bit
        // fields, bits 2..=7 since state=Free zeros the low 2 bits).
        // `microLocation` is unused here (it's 0). Position the
        // card's centre on the hex centre (subtract half-w/h to
        // place the top-left corner) so the soul / loose world card
        // visually sits on its tile rather than top-left-anchored.
        const { zoneQ, zoneR } = unpackMacroZone(row.macroZone);
        const q = zoneQ + ((row.microZone >> 5) & 0x7);
        const r = zoneR + ((row.microZone >> 2) & 0x7);
        const x = WORLD_HEX_RADIUS * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r);
        const y = WORLD_HEX_RADIUS * (3 / 2 * r);
        this.setTarget(x - RECT_CARD_WIDTH / 2, y - RECT_CARD_HEIGHT / 2);
        if (q !== this.overlayQ || r !== this.overlayR) {
          this.refreshObjectOverlay(q, r);
        }
      } else {
        const { x, y } = decodeLooseXY(row.microLocation);
        this.setTarget(x, y);
        this.clearObjectOverlay();
      }
    } else if (stacked === STACKED_ON_ROOT || stacked === STACKED_SLOT) {
      // Both modes draw at the same offset from the parent — Pixi
      // parent-child does the heavy lifting via `Card.stackParentOf`,
      // which returns the immediate predecessor for state-1 (Slot,
      // parent-pointer) and the chain root or position-1 sibling for
      // state-2 (OnRoot, distance-from-root). The visual hierarchy is
      // identical: the layout card is parented to the predecessor's
      // top/bottom stack host, so a single offset places it correctly
      // for either mode.
      const parentId = row.microLocation;
      const parentCard = this.ctx.cards?.get(parentId) ?? null;
      if (!this.ctx.data.cardsLocal.get(parentId)) {
        // Defensive — `mirrorCard` already rewrites orphan state-1 at
        // the mirror boundary, but if a parent vanishes after the row
        // landed (mid-tween destroy), fall back to inventory loose.
        this.ctx.cards?.get(this.cardId)?.setPosition({
          kind: "inventory",
          x: this.targetX,
          y: this.targetY,
        });
        return;
      }
      // Parent-shape-aware offset. For rect parents the chain peeks
      // out from behind the parent body by one title-bar height
      // (above for UP, below for DOWN), and the stack hosts are
      // behind the parent so only the titlebar is visible. For hex
      // parents the rect sits ON TOP of the hex centered on it —
      // mimicking how a rect mounted via `hexMount` (state-3 OnHex)
      // looks, but reached through the state-2 OnRoot path that
      // magnetic-pulled cards land at. HexCard re-parents the stack
      // hosts to render in front of the hex visual; here we just
      // need the correct centering offset.
      const parentIsHex = parentCard?.gameCard instanceof GameHexCard;
      // Record this card's chain-delta — the displacement of our
      // centre from the parent's centre in world pixels. Parent's
      // push (inheritObjectOverlay) adds this to the parent's offset
      // to derive our own overlay offset, so our snapshot aligns
      // with the trees at our actual world position.
      if (parentIsHex) {
        this.setTitlePosition("top");
        this.setTarget(
          (LayoutHexCard.WIDTH - RECT_CARD_WIDTH) / 2,
          (LayoutHexCard.HEIGHT - RECT_CARD_HEIGHT) / 2,
        );
        this.chainDeltaX = 0;
        this.chainDeltaY = 0;
      } else if (getStackDirection(row.microZone) === STACK_DIRECTION_UP) {
        this.setTitlePosition("top");
        this.setTarget(0, -RECT_CARD_TITLE_HEIGHT);
        this.chainDeltaX = 0;
        this.chainDeltaY = RECT_CARD_TITLE_HEIGHT;
      } else {
        this.setTitlePosition("bottom");
        this.setTarget(0, +RECT_CARD_TITLE_HEIGHT);
        this.chainDeltaX = 0;
        this.chainDeltaY = -RECT_CARD_TITLE_HEIGHT;
      }
      // Pull parent's current overlay state so we have something to
      // show before the next time the parent re-bakes.
      const parentLayout = parentCard?.layoutCard;
      if (parentLayout instanceof LayoutHexCard || parentLayout instanceof LayoutRectCard) {
        this.inheritObjectOverlay(
          parentLayout.overlayQ,
          parentLayout.overlayR,
          parentLayout.overlayOffsetX,
          parentLayout.overlayOffsetY,
        );
      } else {
        this.clearObjectOverlay();
      }
    } else if (stacked === STACKED_ON_HEX) {
      if (row.microLocation === 0) {
        // No parent card — position is encoded in macroZone + microZone bit fields.
        const { zoneQ, zoneR } = unpackMacroZone(row.macroZone);
        const q = zoneQ + ((row.microZone >> 5) & 0x7);
        const r = zoneR + ((row.microZone >> 2) & 0x7);
        const x = WORLD_HEX_RADIUS * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r);
        const y = WORLD_HEX_RADIUS * (3 / 2 * r);
        this.setTitlePosition("top");
        this.setTarget(x - RECT_CARD_WIDTH / 2, y - RECT_CARD_HEIGHT / 2);
        if (q !== this.overlayQ || r !== this.overlayR) {
          this.refreshObjectOverlay(q, r);
        }
      } else {
        const parentId = row.microLocation;
        if (!this.ctx.data.cardsLocal.get(parentId)) {
          this.ctx.cards?.get(this.cardId)?.setPosition({
            kind: "loose",
            x: this.targetX,
            y: this.targetY,
          });
          return;
        }
        this.setTitlePosition("top");
        this.setTarget(
          (LayoutHexCard.WIDTH  - RECT_CARD_WIDTH)  / 2,
          (LayoutHexCard.HEIGHT - RECT_CARD_HEIGHT) / 2,
        );
        // Mounted centred on a hex parent — chain delta is zero, our
        // centre coincides with the parent's. Pull parent's current
        // overlay state; parent's subsequent re-bakes push to us.
        this.chainDeltaX = 0;
        this.chainDeltaY = 0;
        const parentLayout = (this.ctx.cards?.get(parentId) ?? null)?.layoutCard;
        if (parentLayout instanceof LayoutHexCard || parentLayout instanceof LayoutRectCard) {
          this.inheritObjectOverlay(
            parentLayout.overlayQ,
            parentLayout.overlayR,
            parentLayout.overlayOffsetX,
            parentLayout.overlayOffsetY,
          );
        } else {
          this.clearObjectOverlay();
        }
      }
    }
  }

  protected override intersects(localX: number, localY: number): boolean {
    if (!this.isStacked) return super.intersects(localX, localY);
    if (localX < 0 || localX >= this.width) return false;
    const titleY =
      this.titlePosition === "top" ? 0 : this.height - RECT_CARD_TITLE_HEIGHT;
    return localY >= titleY && localY < titleY + RECT_CARD_TITLE_HEIGHT;
  }

  protected override layout(): boolean | void {
    const def = this.currentPackedDefinition !== null
      ? this.ctx.definitions.decode(this.currentPackedDefinition) ?? null
      : null;
    const label = this.currentPackedDefinition !== null
      ? this.ctx.definitions.label(this.currentPackedDefinition)
      : undefined;

    this.rectVisual.draw(def, this.titlePosition, label);
    this.applyCardArt(def);

    // Magnetic indicator: top-right of the card *body*, just below the
    // title bar when title is on top, or just below the top edge when
    // title is on bottom. Keeps it visible regardless of titlePosition
    // and avoids overlapping the title bar / progress bars.
    if (this.magneticText.visible) {
      const bodyTopY = this.titlePosition === "top" ? RECT_CARD_TITLE_HEIGHT : 0;
      this.magneticText.position.set(RECT_CARD_WIDTH - 2, bodyTopY + 2);
    }

    // Progress bars: stack server-side recipe indicators (from the
    // local row's `progress` array, populated by `mirrorCard` from
    // future `progress_style`-bearing rows in `cards.server`) followed
    // by the client-side action-debounce indicator. Each bar gets an
    // equal `1/N` slot of the title bar height; a per-bar `heightCap`
    // shrinks an individual bar within its slot (the unused space at
    // the slot's outer edge falls back to the title-bar color
    // underneath). Bars stack from the inside edge of the title (the
    // edge against the card body) outward, so the first spec sits
    // closest to the body.
    //
    // Style codes (`progress_style` u3 from `flags`):
    //   1 = ltr / cw default — fill from left to right
    //   2 = rtl / ccw default — fill from right to left
    // 3..=7 are reserved for future variants.
    this.progressBar.clear();
    const titleColor = def?.style[1] ?? "#7a7a8a";
    const specs: ProgressBarSpec[] = [];
    const local = this.ctx.data.cardsLocal.get(this.cardId);
    if (local?.progress) {
      // Use the server-aligned clock — `sp.startSecs` / `sp.endSecs`
      // are server `valid_at` values (now in unix MS, despite the
      // legacy field names); comparing them to `Date.now()` when the
      // client is behind the server makes the fraction negative
      // (clamped to 0) until wall-clock catches up, freezing the bar
      // visually. `ReducerManager.serverNowMs()` interpolates from
      // the last reducer-event timestamp forward, so the bar starts
      // filling immediately on action commit.
      const nowMs = this.ctx.reducers.serverNowMs();
      const serverFill = shiftLuminance(titleColor);
      for (const sp of local.progress) {
        const span = sp.endSecs - sp.startSecs;
        if (span <= 0) continue;
        const fraction = Math.max(0, Math.min(1, (nowMs - sp.startSecs) / span));
        specs.push({ fraction, style: sp.style, leftColor: serverFill });
      }
    }
    const debounce = this.ctx.actions?.progressFor(this.cardId) ?? null;
    if (debounce !== null) {
      specs.push({
        fraction: debounce,
        style: 1,
        leftColor: 0xffffff,
        heightCap: 0.3,
      });
    }
    if (specs.length > 0) {
      const titleY = this.titlePosition === "top"
        ? 0
        : this.height - RECT_CARD_TITLE_HEIGHT;
      const slotHeight = RECT_CARD_TITLE_HEIGHT / specs.length;
      // Inside edge of the title bar = the edge facing the card body.
      // For top-position titles that's the bottom of the title bar; for
      // bottom-position titles it's the top.
      const insideEdge = this.titlePosition === "top"
        ? titleY + RECT_CARD_TITLE_HEIGHT
        : titleY;
      const stackDir = this.titlePosition === "top" ? -1 : 1;
      let offset = 0;
      for (const spec of specs) {
        const cap = spec.heightCap !== undefined
          ? RECT_CARD_TITLE_HEIGHT * spec.heightCap
          : slotHeight;
        const barHeight = Math.min(slotHeight, cap);
        // Anchor each bar to the inside edge of its slot.
        const slotInside = insideEdge + stackDir * offset;
        const barY = stackDir < 0 ? slotInside - barHeight : slotInside;
        const fillW = this.width * spec.fraction;
        if (fillW > 0 && barHeight > 0) {
          const fillX = spec.style === 2 ? this.width - fillW : 0;
          this.progressBar
            .rect(fillX, barY, fillW, barHeight)
            .fill({ color: spec.leftColor });
        }
        offset += slotHeight;
      }
    }

    this.stateOverlay.clear();
    if (this.state.selected) {
      this.stateOverlay
        .rect(0, 0, this.width, this.height)
        .stroke({ color: 0xffff00, width: 3 });
    }
    if (this.state.hovered) {
      this.stateOverlay
        .rect(-2, -2, this.width + 4, this.height + 4)
        .stroke({ color: 0xffffff, width: 1, alpha: 0.5 });
    }
    if (this.state.pending) {
      this.stateOverlay.rect(0, 0, this.width, 3).fill({ color: 0xff8800 });
    }

    // Soul resource meter. Drawn for any rect card that has a
    // matching Soul row in `soulsLocal` — works for the local
    // player's soul AND any remote soul whose world zone is in
    // scope. Non-soul rect cards never have an entry, so the
    // Graphics is just cleared and stays empty.
    this.resourceMeter.clear();
    const soulRow = this.ctx.data.soulsLocal.get(this.cardId);
    if (soulRow) {
      this.drawSoulResourceMeter(soulRow);
    }

    if (this.dying) {
      this.deathProgress += DEATH_SPEED;
      const maskH = Math.max(0, (1 - this.deathProgress) * this.height);
      this.deathMask.clear().rect(0, 0, this.width, maskH).fill(0xffffff);
      this.deathParticleHandle?.setPosition(this.width / 2, maskH);

      if (this.deathProgress >= 1 && this.visual.visible) {
        this.visual.visible = false;
        this.visual.mask = null;
        this.deathMask.clear();
        this.deathParticleHandle?.stop();
        debug.log(["splice"], `[splice] death-anim hit progress>=1 card=${this.cardId}`, 0);
      }

      if (this.deathProgress >= 4) {
        debug.log(["splice"], `[splice] death-anim complete card=${this.cardId} progress=${this.deathProgress.toFixed(2)} — about to splice`, 0);
        this.dying = false;
        this.unsubDying?.();
        this.unsubDying = null;

        this.deathParticleHandle?.destroy();
        this.deathParticleHandle = null;
        if (this.deathParticleContainer) {
          this.container.removeChild(this.deathParticleContainer);
          this.deathParticleContainer.destroy({ children: true });
          this.deathParticleContainer = null;
        }

        // Order matters: splice FIRST, then mark dead=2.
        //
        // `CardManager.subscribeLocalCard` listens for the
        // dead===1→dead===2 transition and immediately destroys the
        // Card composite (removes from `cards` map, tears down PIXI
        // containers). If we wrote dead=2 first, that destroy would
        // synchronously fire before our spliceCard call returned,
        // and `spliceCard`'s `this.cards.get(cardId)` lookup would
        // return undefined → silent early-out, no chain repair.
        //
        // Splice itself doesn't need dead=2 to be set on the dying
        // card's row: it operates on the dying card's known position
        // fields (microZone / microLocation) and re-parents children
        // via fresh local-row writes. The downstream filter in
        // `Card.stackParentOf` that skips `dead === 2` siblings
        // applies to survivors looking *back* at the dying row —
        // that filter does need dead=2 eventually, but only on the
        // NEXT chain walk, which happens after we write dead=2 below.
        this.ctx.cards?.spliceCard(this.cardId);
        const cur = this.ctx.data.cardsLocal.get(this.cardId);
        if (cur) {
          // setLocalCard fires listeners synchronously — the dead===1→2
          // transition triggers CardManager.destroy → layoutCard.destroy,
          // which nulls our PIXI container.position. Bail before tweenTo
          // tries to write through it.
          this.ctx.data.setLocalCard(this.cardId, { ...cur, dead: 2 });
          return false;
        }
        debug.log(["splice"], `[splice] WARN card=${this.cardId} no local row, cannot set dead=2`, 0);
      }
    }

    let effX = this.targetX;
    let effY = this.targetY;
    if (this.state.dragging) {
      const ptr = this.ctx.input?.lastPointer;
      if (ptr) {
        effX = ptr.x - this.dragOffsetX;
        effY = ptr.y - this.dragOffsetY;
      }
    }
    const moving = this.tweenTo(effX, effY);

    // While the card's visual position is changing (drag or tween),
    // refresh the in-front-objects overlay when the underlying world
    // hex changes. Only re-bakes when (q, r) actually shifts. Gated
    // on `overlayQ !== null` so it only runs for cards that were
    // already on a world surface — inventory cards stay clear until
    // they land, at which point applyData refreshes. Uses the card's
    // *global* position because during drag the card is re-parented
    // to the global drag overlay, so its local effX/effY is no
    // longer in the world-card-surface frame — global coords work in
    // both states.
    if (
      this.overlayQ !== null &&
      this.ctx.worldHexAt &&
      (this.state.dragging || moving)
    ) {
      const gp = this.container.getGlobalPosition();
      const hex = this.ctx.worldHexAt(gp.x + RECT_CARD_WIDTH / 2, gp.y + RECT_CARD_HEIGHT / 2);
      // Re-bake every frame while moving so the offset stays
      // up-to-date — the tile snapshot slides with the card's drift
      // relative to the tile centre rather than only snapping on
      // tile-boundary crossings.
      this.refreshObjectOverlay(hex.q, hex.r, hex.offsetX, hex.offsetY);
    }

    // Re-run next frame while any progress is mid-fill so the bars
    // animate smoothly rather than only updating on data changes.
    const showingProgress = specs.some((s) => s.fraction < 1);
    return this.state.dragging || moving || this.dying || showingProgress;
  }

  /** Paint the four resource clusters from a Soul row's packed
   *  `stats` / `fatigued` u32s. Each cluster reads its own byte
   *  (see `STAT_BYTE`) and draws stats squares first (base color),
   *  then fatigue squares (variant color), capped at
   *  `METER_CAP_PER_CLUSTER` combined. Caller has cleared
   *  `resourceMeter` and confirmed a Soul row exists for this card.
   *
   *  Cost per call: 8 bit-shifts + up to 40 rect ops total. No walk
   *  over `cardsLocal`; per-frame invalidation is cheap. */
  /** Resolve and apply the card-art sprite for this card. Source of
   *  the art name:
   *  - Soul cards (`def.cardType === cardTypeId("soul")`) derive the
   *    name from the row's `portrait_id` nibble (`Card.flags` bits
   *    28..=31, set at spawn by `character_creation::create_character`)
   *    and the soul def's `key`: `256_<key>_<portraitId + 1>`. Pack
   *    files at `public/textures/cards/soul/<key>/256_<key>_pack/`
   *    are 1-indexed, hence the `+ 1`.
   *  - Every other card uses `def.sprite` directly (the static
   *    per-definition sprite filename from the card's JSON).
   *
   *  The texture is fetched via `cardTextures.getCardArt`, which
   *  atlas-packs once per filename and caches across all cards
   *  sharing the same art — so the cache grows as `O(distinct sprite
   *  files)`, independent of card-instance count. */
  private applyCardArt(def: CardDefinition | null): void {
    let artName: string | null = null;
    if (def !== null) {
      if (def.cardType === this.ctx.definitions.cardTypeId("soul")) {
        const portraitId = this.ctx.definitions.cardFlagFieldValue(this.currentFlags, "portrait_id") ?? 0;
        artName = `256_${def.key}_${portraitId + 1}`;
      } else if (def.sprite) {
        artName = def.sprite;
      }
    }
    if (!artName) {
      this.artSprite.visible = false;
      return;
    }
    const tex = this.ctx.cardTextures.getCardArt(artName);
    if (!tex) {
      this.artSprite.visible = false;
      return;
    }
    this.artSprite.texture = tex;
    const bodyHeight = RECT_CARD_HEIGHT - RECT_CARD_TITLE_HEIGHT;
    const bodyCenterY = this.titlePosition === "top"
      ? RECT_CARD_TITLE_HEIGHT + bodyHeight / 2
      : bodyHeight / 2;
    const target = ART_BODY_FRACTION * Math.min(RECT_CARD_WIDTH, bodyHeight);
    const scale = target / Math.max(tex.width, tex.height);
    this.artSprite.scale.set(scale);
    this.artSprite.position.set(RECT_CARD_WIDTH / 2, bodyCenterY);
    this.artSprite.visible = true;
  }

  private drawSoulResourceMeter(soul: Soul): void {
    const colors = getClusterColors(this.ctx.definitions);
    // Body origin in card-local pixels. For souls we expect `top`
    // titles but compute from `titlePosition` so the meter behaves
    // correctly if the layout ever flips direction.
    const bodyTop =
      this.titlePosition === "top" ? RECT_CARD_TITLE_HEIGHT : 0;

    for (const key of RESOURCE_KEYS) {
      const byteIdx = STAT_BYTE[key];
      const statsCount    = (soul.stats    >>> (byteIdx * 8)) & 0xff;
      const fatigueCount  = (soul.fatigued >>> (byteIdx * 8)) & 0xff;
      if (statsCount === 0 && fatigueCount === 0) continue;

      const layout = CLUSTER_LAYOUTS[key];
      const clusterColors = colors[key];
      // Stats first, then fatigue, sharing the 10-square cap. If
      // stats alone already fills the cluster, fatigue gets no
      // slots; otherwise fatigue takes whatever remains.
      const statsToDraw   = Math.min(statsCount, METER_CAP_PER_CLUSTER);
      const fatigueToDraw = Math.min(fatigueCount, METER_CAP_PER_CLUSTER - statsToDraw);

      let slot = 0;
      for (let i = 0; i < statsToDraw; i++) {
        this.drawClusterSquare(layout, bodyTop, slot++, clusterColors.stats);
      }
      for (let i = 0; i < fatigueToDraw; i++) {
        this.drawClusterSquare(layout, bodyTop, slot++, clusterColors.fatigued);
      }
    }
  }

  /** Place one 5×5 square at column-major slot `slot` of a cluster.
   *  Column 0 is the corner-most column; rows fill top-down (top
   *  clusters) or bottom-up (bottom clusters) per the layout's
   *  `dyRow` sign. 5 rows per column → col = `floor(slot/5)`,
   *  row = `slot % 5`. */
  private drawClusterSquare(
    layout: ClusterLayout,
    bodyTop: number,
    slot: number,
    color: number,
  ): void {
    const col = Math.floor(slot / 5);
    const row = slot % 5;
    const x = layout.cornerX + col * layout.dxCol + row * layout.dxRow;
    const y = bodyTop + layout.cornerY + col * layout.dyCol + row * layout.dyRow;
    this.resourceMeter.rect(x, y, METER_SQUARE, METER_SQUARE).fill({ color });
  }

  private _spawnDeathEffect(): void {
    const pm = ParticleManager.getInstance();
    if (!pm) return;
    const pc = new ParticleContainer();
    pc.position.set(this.width / 2, this.height);
    this.container.addChild(pc);
    this.deathParticleContainer = pc;
    const def = this.currentPackedDefinition !== null
      ? this.ctx.definitions.decode(this.currentPackedDefinition) ?? null
      : null;
    const primary = def?.style[0] ?? "#3a3a4a";
    this.deathParticleHandle = pm.createEmitter(pc, "ascend", { startColor: primary });
  }

  /** Re-bake the in-front-objects snapshot into our own RenderTexture.
   *  `(q, r)` is the world tile underneath the card; `(offsetX,
   *  offsetY)` is the displacement of the tile centre from the card
   *  centre, so a chained rect sitting above its parent passes a
   *  positive offsetY to slide the snapshot down. */
  refreshObjectOverlay(q: number, r: number, offsetX = 0, offsetY = 0): void {
    const overlay = this.ctx.worldOverlay;
    if (!overlay) return;
    if (!this.overlayTexture) {
      this.overlayTexture = RenderTexture.create({
        width:      RECT_CARD_WIDTH,
        height:     RECT_CARD_HEIGHT,
        resolution: Math.min(window.devicePixelRatio, 2),
      });
    }
    if (!this.overlaySprite) {
      this.overlaySprite = new Sprite(this.overlayTexture);
      this.overlaySprite.alpha = 0.75;
    }
    // Re-add every refresh — addChild on an existing child moves it
    // to the end of `visual.children`. The title-bar fill stays at
    // its constructor position (below the overlay) so the overlay
    // tints it the same way it tints the body / art — only the
    // *label*, progress bars, and outline pop above. Net z: body,
    // art, titleBar, overlay, progressBar, nameText, cardOutline,
    // stateOverlay (re-added last so hover / pending feedback isn't
    // buried by the freshly-added overlay).
    this.visual.addChild(this.overlaySprite);
    this.visual.addChild(this.progressBar);
    this.visual.addChild(this.rectVisual.nameText);
    this.visual.addChild(this.rectVisual.cardOutline);
    this.visual.addChild(this.stateOverlay);
    this.overlayQ = q;
    this.overlayR = r;
    this.overlayOffsetX = offsetX;
    this.overlayOffsetY = offsetY;
    this.overlaySprite.visible = overlay(q, r, this.overlayTexture, RECT_CARD_WIDTH, RECT_CARD_HEIGHT, offsetX, offsetY);
    this.pushObjectOverlayToStacked();
  }

  /** Parent-pushed overlay state. We add our own static `chainDelta`
   *  (set in applyData based on stack direction) to the parent's
   *  offset, then bake into our own RT. */
  override inheritObjectOverlay(
    parentQ: number | null,
    parentR: number | null,
    parentOffsetX: number,
    parentOffsetY: number,
  ): void {
    if (parentQ === null || parentR === null) {
      this.clearObjectOverlay();
      return;
    }
    this.refreshObjectOverlay(
      parentQ,
      parentR,
      parentOffsetX + this.chainDeltaX,
      parentOffsetY + this.chainDeltaY,
    );
  }

  /** Cascade our overlay state to any rect children stacked on us.
   *  Mirrors what LayoutHexCard does — each chain link inherits and
   *  re-pushes, so a rect on a rect on a hex on a world tile ends up
   *  correctly aligned without any per-frame invalidation. */
  private pushObjectOverlayToStacked(): void {
    const q = this.overlayQ;
    const r = this.overlayR;
    const ox = this.overlayOffsetX;
    const oy = this.overlayOffsetY;
    for (const child of this.stackTopHost.children) {
      if (child instanceof LayoutCard) child.inheritObjectOverlay(q, r, ox, oy);
    }
    for (const child of this.stackBottomHost.children) {
      if (child instanceof LayoutCard) child.inheritObjectOverlay(q, r, ox, oy);
    }
  }

  private clearObjectOverlay(): void {
    this.overlayQ = null;
    this.overlayR = null;
    this.overlayOffsetX = 0;
    this.overlayOffsetY = 0;
    if (this.overlaySprite) this.overlaySprite.visible = false;
    // Also tell our own stacked children to clear.
    for (const child of this.stackTopHost.children) {
      if (child instanceof LayoutCard) child.inheritObjectOverlay(null, null, 0, 0);
    }
    for (const child of this.stackBottomHost.children) {
      if (child instanceof LayoutCard) child.inheritObjectOverlay(null, null, 0, 0);
    }
  }

  override destroy(): void {
    this.deathParticleHandle?.destroy();
    this.deathParticleHandle = null;
    this.unsubDying?.();
    this.unsubDying = null;
    this.unsubResourceMeter?.();
    this.unsubResourceMeter = null;
    this.unsubObjectLoad?.();
    this.unsubObjectLoad = null;
    this.unsubTileChange?.();
    this.unsubTileChange = null;
    this.unsubArtLoad?.();
    this.unsubArtLoad = null;
    if (this.overlaySprite) {
      this.overlaySprite.destroy();
      this.overlaySprite = null;
    }
    if (this.overlayTexture) {
      this.overlayTexture.destroy(true);
      this.overlayTexture = null;
    }
    super.destroy();
  }
}
