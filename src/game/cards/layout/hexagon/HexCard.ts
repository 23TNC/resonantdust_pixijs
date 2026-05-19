import { Container, Graphics, ParticleContainer, RenderTexture, Sprite, Text, Texture } from "pixi.js";
import type { GameContext } from "../../../../GameContext";
import type { CardDefinition } from "../../../definitions/DefinitionManager";
import { LayoutNode } from "../../../layout/LayoutNode";
import type { Card as CardRow } from "../../../../server/spacetime/bindings/types";
import type { LocalCard } from "../../../../server/data/DataManager";
import { ParticleManager, type ParticleHandle } from "../../../../assets/ParticleManager";
import {
  decodeLooseXY,
  getStackedState,
  STACKED_LOOSE,
  type LooseXY,
} from "../../cardData";
// Magnetic-action progress rendering used to live here against a
// dedicated `MagneticAction` server table. That table was retired by
// the magnetic rewrite (see docs/MAGNETIC_REWRITE.md). The magnetic
// progress bar now renders against the magnetic card row's
// future-stamped completion row in the cards table — see
// `progress_style` handling in the card-data layer.
import { GameCard } from "../../game/CardGame";
import { hexPoints } from "./HexVisual";
import { WORLD_HEX_RADIUS } from "../../../world/hexSize";
import { LayoutCard } from "../CardLayout";
import {
  unpackMacroZone,
  unpackMicroZone,
  WORLD_LAYER,
} from "../../../../server/data/packing";

/** Size of the hex card's *physical* footprint — the rectangle used by
 *  inventory push-collision (`GameInventory.tryPush`). Owned by
 *  `GameHexCard`; surfaced as `GameHexCard.WIDTH` / `HEIGHT`. */
const HEX_GAME_RADIUS = 72;
const HEX_GAME_WIDTH  = Math.sqrt(3) * HEX_GAME_RADIUS;
const HEX_GAME_HEIGHT = HEX_GAME_RADIUS * 2;

/** Size of the hex card's *graphical* footprint — the layout-node bbox,
 *  overlay geometry, magnetic-text centering, and death-mask extent.
 *  Owned by `LayoutHexCard`; surfaced as `LayoutHexCard.RADIUS` /
 *  `WIDTH` / `HEIGHT`. */
const HEX_CARD_RADIUS = 72;
const HEX_CARD_WIDTH  = Math.sqrt(3) * HEX_CARD_RADIUS;
const HEX_CARD_HEIGHT = HEX_CARD_RADIUS * 2;

/** Card-art square sized to this fraction of the hex's shorter
 *  bounding-box axis (= inscribed-circle diameter). <1 keeps the
 *  art tucked inside the hex outline so no per-card mask is needed. */
const HEX_ART_FRACTION = 0.7;

/** Passthrough hit-host for a rect card mounted on top of a hex (STACKED_ON_HEX).
 *  Always recurses into children; never returns itself — so clicks on the
 *  mounted rect's body are caught by the rect, not by this container. */
class HexMount extends LayoutNode {
  override hitTestLayout(parentX: number, parentY: number): LayoutNode | null {
    const localX = parentX - this.x;
    const localY = parentY - this.y;
    for (let i = this.children.length - 1; i >= 0; i--) {
      const hit = this.children[i].hitTestLayout(localX, localY);
      if (hit) return hit;
    }
    return null;
  }
}

/** Per-frame increment for the death wipe; mirrors `RectCard`'s
 *  `DEATH_SPEED` so the two shapes die at the same visual cadence.
 *  `deathProgress` runs `0 → 1` for the mask wipe, then continues to
 *  `4` to let the ascend particles play out before splice runs. */
const DEATH_SPEED = 0.04;

export class GameHexCard extends GameCard {
  static readonly RADIUS = HEX_GAME_RADIUS;
  static readonly WIDTH  = HEX_GAME_WIDTH;
  static readonly HEIGHT = HEX_GAME_HEIGHT;

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

export class LayoutHexCard extends LayoutCard {
  static readonly RADIUS = HEX_CARD_RADIUS;
  static readonly WIDTH  = HEX_CARD_WIDTH;
  static readonly HEIGHT = HEX_CARD_HEIGHT;

  private readonly visual        = new Container();
  private readonly hexSprite     = new Sprite(Texture.EMPTY);
  /** Per-instance card art sprite. Texture is resolved on demand
   *  from `CardTextureManager.getCardArt(name)`, atlas-packed once
   *  per filename. Sits above `hexSprite` (the baked hex
   *  background) so different cards sharing one def can show
   *  different art without re-baking the hex. Hidden when the def
   *  declares no sprite. */
  private readonly artSprite     = new Sprite();
  private readonly stateOverlay  = new Graphics();
  /** Magnetic-phase progress bar — thin filled strip along the
   *  bottom edge of the hex's bounding box. Driven the same way as
   *  `LayoutRectCard.progressBar`: each entry in `LocalCard.progress`
   *  paints one fill. For the despair magnetic anchor this shows the
   *  install → `duration_at` countdown; for other future use cases
   *  whose `progress_style` lands on a hex card, the bar appears
   *  identically. */
  private readonly progressBar   = new Graphics();
  /** Magnetic-anchor indicator — see the same field on LayoutRectCard
   *  for the full doc. Bit 12 of `cards.flags`; registry name
   *  `"magnetic"` (the Rust constant is `FLAG_LIFECYCLE_PENDING`).
   *  The despair hex anchor is the canonical case. */
  private readonly magneticText: Text;
  private currentPackedDefinition: number | null = null;
  /** Death-animation state — mirrors `LayoutRectCard`. The hex uses
   *  the same rect-shaped mask wipe (top-down shrink of the
   *  bounding-box mask) so the visual cadence matches across card
   *  shapes; the hex's silhouette still wipes away cleanly because
   *  the mask shrinks vertically through the hex's bounding box. */
  private dying = false;
  private deathProgress = 0;
  private readonly deathMask = new Graphics();
  private deathParticleContainer: ParticleContainer | null = null;
  private deathParticleHandle: ParticleHandle | null = null;
  private unsubDying: (() => void) | null = null;

  /** Per-card "objects in front of this card" snapshot. Lazily created
   *  for hex cards landing on world surfaces; baked from LayoutWorld
   *  via `ctx.worldOverlay` and refreshed when the card moves or when
   *  an object texture pack finishes loading. Drawn on top of the
   *  card at 50% alpha so the user perceives the nearby trees / rocks
   *  as occluding the card without any scene-graph reshuffling.
   *
   *  Public so stacked rect children can read it directly and wrap a
   *  sub-Texture around the same RT — saves baking the same content
   *  per child. */
  overlayTexture: RenderTexture | null = null;
  overlaySprite: Sprite | null = null;
  overlayQ: number | null = null;
  overlayR: number | null = null;
  overlayOffsetX = 0;
  overlayOffsetY = 0;
  private unsubObjectLoad: (() => void) | null = null;
  private unsubTileChange: (() => void) | null = null;
  private unsubArtLoad: (() => void) | null = null;

  constructor(cardId: number, ctx: GameContext) {
    super(cardId, ctx);
    // TODO: re-wire death detection. The old `change.kind === "dying"` event
    // was emitted by ShadowedStore — gone with the rewrite. New mechanism TBD.
    //
    // this.unsubDying = ctx.data.cards.subscribeKey(cardId, (change) => {
    //   if (change.kind === "dying") {
    //     this.dying = true;
    //     this.invalidate();
    //   }
    // });

    this.visual.addChild(this.hexSprite);
    // Card art sits directly above the baked hex (background +
    // outline) and below stateOverlay so hover / pending overlays
    // still read on top of the art.
    this.artSprite.anchor.set(0.5, 0.5);
    this.artSprite.visible = false;
    this.visual.addChild(this.artSprite);
    this.visual.addChild(this.stateOverlay);
    // Magnetic indicator — centered on the hex, hidden until the
    // `magnetic` flag is observed. Added to `visual` so it fades
    // along with the death animation's alpha.
    this.magneticText = new Text({
      text: "🧲",
      style: { fontSize: 16 },
    });
    this.magneticText.anchor.set(0.5);
    this.magneticText.position.set(HEX_CARD_WIDTH / 2, HEX_CARD_HEIGHT / 2);
    this.magneticText.visible = false;
    this.visual.addChild(this.magneticText);
    // Progress bar rendered above stateOverlay so the hover/pending
    // outlines don't occlude it. Lives on `visual` so it fades with
    // the death animation alpha (mask wipe also crops it).
    this.visual.addChild(this.progressBar);
    // deathMask added to container BEFORE visual so the visual can
    // reference it as a mask (Pixi requires the mask to be in the
    // scene graph). Mirror of `LayoutRectCard`'s setup.
    this.container.addChild(this.deathMask);
    this.container.addChild(this.visual);
    // hexMount added after visual → mounted rect renders in front of the hex.
    this.hexMount = new HexMount();
    this.addChild(this.hexMount);
    // Re-parent the stack hosts (inherited from LayoutCard) to render
    // *in front of* the hex visual. The base class adds them first so
    // rect chain children peek out from behind a rect parent's body
    // — for a hex parent we want the opposite: pulled magnetic leaves
    // sit on top of the hex, the way a rect mounted on the hex via
    // `hexMount` does. Without this, the dread pulled by a despair
    // magnetic renders behind the despair hex graphic.
    this.removeChild(this.stackBottomHost);
    this.removeChild(this.stackTopHost);
    this.addChild(this.stackBottomHost);
    this.addChild(this.stackTopHost);
    this.setSize(HEX_CARD_WIDTH, HEX_CARD_HEIGHT);

    // Refresh the in-front-objects overlay whenever an object texture
    // pack finishes loading; the first snapshot a card builds at
    // placement time can miss sprites whose pack was still loading.
    this.unsubObjectLoad = ctx.objectTextures.onLoad(() => {
      if (this.overlayQ !== null && this.overlayR !== null) {
        this.refreshObjectOverlay(this.overlayQ, this.overlayR);
      }
    });
    // Re-bake when world tile data lands or updates — keeps our
    // snapshot in sync with new trees, terrain changes, etc.
    this.unsubTileChange = ctx.onTilesChanged?.(() => {
      if (this.overlayQ !== null && this.overlayR !== null) {
        this.refreshObjectOverlay(this.overlayQ, this.overlayR, this.overlayOffsetX, this.overlayOffsetY);
      }
    }) ?? null;

    // Re-apply card art whenever a sprite finishes lazy-loading.
    // `applyCardArt` here is only invoked from `applyData` on a
    // `packedDefinition` change, so an `invalidate()` would not
    // re-resolve the art on its own — we have to call it directly
    // with the current def. Cache-hit fast path for sprites already
    // resolved; per-card cost is one decode + one Map lookup.
    this.unsubArtLoad = ctx.cardTextures.onArtLoad(() => {
      if (this.currentPackedDefinition === null) return;
      const def = ctx.definitions.decode(this.currentPackedDefinition) ?? null;
      this.applyCardArt(def);
    });
  }

  applyData(row: CardRow): void {
    if (row.packedDefinition !== this.currentPackedDefinition) {
      this.currentPackedDefinition = row.packedDefinition;
      const def = this.ctx.definitions.decode(row.packedDefinition) ?? null;
      this.hexSprite.texture = this.ctx.cardTextures.getHex(def);
      // Texture is baked at HEX_TEXTURE_* (TextureManager-owned); rescale
      // to this card's graphical size every time the texture is swapped,
      // since Pixi's sprite scale is computed from texture dimensions.
      this.hexSprite.setSize(HEX_CARD_WIDTH, HEX_CARD_HEIGHT);
      // Refresh the per-instance art layer alongside the def-keyed
      // background — sprite name is static for hex cards (no
      // per-row override today), so the only thing that can change
      // it is a packedDefinition swap.
      this.applyCardArt(def);
      this.invalidate();
    }

    // Magnetic anchor indicator. Position is fixed (center of hex),
    // so only visibility needs flipping per row push.
    const wasMagneticVisible = this.magneticText.visible;
    this.magneticText.visible = this.ctx.definitions.hasCardFlag(row.flags, "magnetic");
    if (wasMagneticVisible !== this.magneticText.visible) this.invalidate();

    // `dead === 1` — first time we see FLAG_ACTION_DEAD on the row
    // (DataManager.mirrorCard sets this). Start the rect-style death
    // animation: apply the mask, kick the ascend-particle emitter,
    // and flag `dying` so `layout()` advances `deathProgress` each
    // frame. `dead: 2` is written by `layout()` once the wipe + tail
    // finish; the mirror's preserve gate keeps the `2` across
    // further server pushes so we don't replay.
    //
    // Deferral on slot_hold: a dead row carrying slot_hold is an
    // in-flight death — some concurrent recipe is still holding
    // this card and forward-prop layered slot_hold onto the death
    // row. Wait for the holding recipe's completion to write a new
    // row clearing slot_hold before animating. See the matching
    // gate in `RectCard.applyData`.
    const slotHeldHex = this.ctx.definitions.isSlotHeld(row.flags);
    if ((row as LocalCard).dead === 1 && !this.dying && !slotHeldHex) {
      this.dying = true;
      this.deathProgress = 0;
      this.visual.mask = this.deathMask;
      this._spawnDeathEffect();
      this.invalidate();
    }

    // World-surface positioning: hex cards on `surface >= WORLD_LAYER`
    // sit at world hex `(zoneQ + localQ, zoneR + localR)`. The `macro_zone`
    // u32 packs the chunk coordinates; `micro_zone` carries local q/r
    // in its legacy u3 fields. Convert to the pixel offset from the
    // world origin (which is where `LayoutWorld.worldCardSurface` is
    // positioned), then center the card on its hex by subtracting
    // half-width / half-height.
    if (row.surface >= WORLD_LAYER) {
      const { zoneQ, zoneR } = unpackMacroZone(row.macroZone);
      const { localQ, localR } = unpackMicroZone(row.microZone);
      const q = zoneQ + localQ;
      const r = zoneR + localR;
      const px = WORLD_HEX_RADIUS * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
      const py = WORLD_HEX_RADIUS * ((3 / 2) * r);
      // Centre the card (graphical size, `HEX_CARD_*`) on the world
      // hex's pixel centre. When the card's own size diverges from
      // the world tile size, this still yields card-center == hex-center.
      this.setTarget(px - HEX_CARD_WIDTH / 2, py - HEX_CARD_HEIGHT / 2);
      if (q !== this.overlayQ || r !== this.overlayR) {
        this.refreshObjectOverlay(q, r);
      }
      return;
    }
    // Non-world surfaces: ensure any leftover overlay from a previous
    // world placement is hidden so an inventoried card doesn't drag
    // its world-tile snapshot along with it.
    this.clearObjectOverlay();

    const stacked = getStackedState(row.microZone);
    if (stacked === STACKED_LOOSE) {
      const { x, y } = decodeLooseXY(row.microLocation);
      this.setTarget(x, y);
    }
    // Hex stacking (STACKED_ON_HEX) is not yet implemented.
  }

  protected override layout(): boolean | void {
    const cx = HEX_CARD_WIDTH  / 2;
    const cy = HEX_CARD_HEIGHT / 2;

    // Magnetic-phase progress ring rendering moved off the retired
    // MagneticAction table to the card row's own progress_style
    // field — see the bar render below for the new derivation.

    this.stateOverlay.clear();
    if (this.state.selected) {
      const selPts = hexPoints(cx, cy, HEX_CARD_RADIUS);
      this.stateOverlay.poly(selPts).stroke({ color: 0xffff00, width: 3 });
    }
    if (this.state.hovered) {
      const hoverPts = hexPoints(cx, cy, HEX_CARD_RADIUS + 2);
      this.stateOverlay.poly(hoverPts).stroke({ color: 0xffffff, width: 1, alpha: 0.5 });
    }
    if (this.state.pending) {
      const pendingPts = hexPoints(cx, cy, HEX_CARD_RADIUS - 4);
      this.stateOverlay.poly(pendingPts).stroke({ color: 0xff8800, width: 3 });
    }

    // Magnetic-phase progress bar — drawn as a ring around the hex
    // outline. Filled portion uses `color1`, remaining portion uses
    // `color2`. The 6 sides are walked in either CW or CCW order
    // (`progress_style`: 1 = cw/ltr default, 2 = ccw/rtl); for a
    // fraction `f` the ring has `N = floor(f*6)` full color1 sides,
    // one split side (color1 for the first `(f*6 - N)` of its length
    // then color2), then `M = 6 - N - 1` color2 sides. At `f=0` all
    // six are color2; at `f=1` all six are color1.
    //
    // Each `LocalCard.progress` entry paints one ring; today the
    // array carries at most one. `startSecs` / `endSecs` come from
    // `mirrorCard.scanProgress` with the continuity-carry, so the
    // ring doesn't reset across intermediate row writes. Uses
    // `ReducerManager.serverNowMs` so server-clock skew doesn't
    // freeze the fill. (Note: `sp.startSecs` / `sp.endSecs` now hold
    // unix MS — field names are legacy.)
    this.progressBar.clear();
    const local = this.ctx.data.cardsLocal.get(this.cardId);
    let showingProgress = false;
    if (local?.progress) {
      const nowMs = this.ctx.reducers.serverNowMs();
      for (const sp of local.progress) {
        const span = sp.endSecs - sp.startSecs;
        if (span <= 0) continue;
        const fraction = Math.max(0, Math.min(1, (nowMs - sp.startSecs) / span));
        this.drawHexProgressRing(fraction, sp.style === 2, cx, cy, HEX_CARD_RADIUS, 0xffffff, 0x444444, 4);
        if (fraction < 1) showingProgress = true;
      }
    }

    // Client-side queue-debounce indicator: while `ActionManager` is
    // counting down to `proposeAction`, paint a second ring at a
    // slightly inset radius so it nests inside any server-side ring
    // and stays visible distinctly. Bar fills `ltr` (cw) and clears
    // when the action submits.
    const debounce = this.ctx.actions?.progressFor(this.cardId) ?? null;
    if (debounce !== null) {
      this.drawHexProgressRing(debounce, /* ccw */ false, cx, cy, HEX_CARD_RADIUS - 5, 0xffffff, 0x222222, 2);
      if (debounce < 1) showingProgress = true;
    }

    // Rect-style mask-wipe death. `deathProgress` runs `0 → 1` while
    // the bounding-box mask shrinks (top stays, bottom wipes away);
    // continues to `4` to let the ascend-particle tail play out
    // before `dead: 2` is written and splice runs. Mirrors
    // `LayoutRectCard.layout`.
    if (this.dying) {
      this.deathProgress += DEATH_SPEED;
      const maskH = Math.max(0, (1 - this.deathProgress) * HEX_CARD_HEIGHT);
      this.deathMask.clear().rect(0, 0, HEX_CARD_WIDTH, maskH).fill(0xffffff);
      this.deathParticleHandle?.setPosition(HEX_CARD_WIDTH / 2, maskH);

      if (this.deathProgress >= 1 && this.visual.visible) {
        this.visual.visible = false;
        this.visual.mask = null;
        this.deathMask.clear();
        this.deathParticleHandle?.stop();
      }

      if (this.deathProgress >= 4) {
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

        // Splice FIRST, then mark dead=2 — see the matching comment in
        // `RectCard.layout` for the full rationale. The `dead: 2` write
        // synchronously fires `CardManager.destroy`, which removes this
        // Card from the registry and tears down our PIXI container; if
        // we wrote `dead: 2` first, `spliceCard`'s `this.cards.get`
        // lookup would return undefined and skip chain repair, and any
        // code after this branch (tweenTo) would crash on a nulled
        // container. Return immediately on the dead=2 path.
        this.ctx.cards?.spliceCard(this.cardId);
        const cur = this.ctx.data.cardsLocal.get(this.cardId);
        if (cur) {
          this.ctx.data.setLocalCard(this.cardId, { ...cur, dead: 2 });
          return false;
        }
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
    // hex changes. Gated on `overlayQ !== null` so it only runs for
    // cards that were already on a world surface (inventory cards
    // stay clear until they land, at which point applyData
    // refreshes). Uses the card's *global* position because during
    // drag the card is re-parented to the global drag overlay, so
    // its local effX/effY is no longer in the world-card-surface
    // frame — global coords work in both states.
    if (
      this.overlayQ !== null &&
      this.ctx.worldHexAt &&
      (this.state.dragging || moving)
    ) {
      const gp = this.container.getGlobalPosition();
      const hex = this.ctx.worldHexAt(gp.x + HEX_CARD_WIDTH / 2, gp.y + HEX_CARD_HEIGHT / 2);
      // Re-bake every frame while moving so the offset stays
      // up-to-date — the tile snapshot needs to slide with the
      // card's drift relative to the tile centre, not just snap on
      // tile-boundary crossings.
      this.refreshObjectOverlay(hex.q, hex.r, hex.offsetX, hex.offsetY);
    }

    return this.state.dragging || moving || this.dying || showingProgress;
  }

  /** Draw a progress ring along the hex's 6-side outline. See the
   *  call site in `layout()` for the conceptual breakdown — N full
   *  `color1` sides, one split side (color1 → color2 along its
   *  length), M full `color2` sides.
   *
   *  Side ordering: `hexPoints(cx, cy, r)` returns vertices at
   *  angles `30°, 90°, 150°, 210°, 270°, 330°` which, in Pixi's
   *  y-down screen space, places them at `lower-right, bottom,
   *  lower-left, upper-left, top, upper-right` going clockwise.
   *  We anchor at the top vertex (index 4) and walk forward for CW
   *  or backward for CCW. The 7-element `seq` includes the start
   *  vertex twice (first and last) so 6 sides are drawn between
   *  consecutive pairs.
   *
   *  When the partial fraction is exactly 0 (i.e. progress just
   *  crossed a side boundary), the split side is skipped entirely
   *  — N full sides + M full sides = 6, no zero-length stub. */
  private drawHexProgressRing(
    fraction: number,
    ccw: boolean,
    cx: number,
    cy: number,
    radius: number,
    color1: number,
    color2: number,
    lineWidth: number,
  ): void {
    const verts: [number, number][] = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      verts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
    }
    const seq = ccw
      ? [4, 3, 2, 1, 0, 5, 4]
      : [4, 5, 0, 1, 2, 3, 4];
    const ordered = seq.map((i) => verts[i]);

    const totalSides = 6;
    const filled = fraction * totalSides;
    const fullSides = Math.min(Math.floor(filled), totalSides);
    const partial = filled - fullSides;

    // N full sides of color1.
    for (let i = 0; i < fullSides; i++) {
      const [x1, y1] = ordered[i];
      const [x2, y2] = ordered[i + 1];
      this.progressBar
        .moveTo(x1, y1)
        .lineTo(x2, y2)
        .stroke({ color: color1, width: lineWidth });
    }

    // Split side: only if there's a partial fraction (i.e. progress
    // landed mid-side, not exactly on a vertex).
    let splitConsumed = 0;
    if (fullSides < totalSides && partial > 0) {
      const [x1, y1] = ordered[fullSides];
      const [x2, y2] = ordered[fullSides + 1];
      const sx = x1 + (x2 - x1) * partial;
      const sy = y1 + (y2 - y1) * partial;
      this.progressBar
        .moveTo(x1, y1)
        .lineTo(sx, sy)
        .stroke({ color: color1, width: lineWidth });
      this.progressBar
        .moveTo(sx, sy)
        .lineTo(x2, y2)
        .stroke({ color: color2, width: lineWidth });
      splitConsumed = 1;
    }

    // M full sides of color2 (the remainder).
    for (let i = fullSides + splitConsumed; i < totalSides; i++) {
      const [x1, y1] = ordered[i];
      const [x2, y2] = ordered[i + 1];
      this.progressBar
        .moveTo(x1, y1)
        .lineTo(x2, y2)
        .stroke({ color: color2, width: lineWidth });
    }
  }

  /** Re-bake the in-front-objects snapshot for this card's current
   *  world hex. Creates the overlay RT and Sprite on first call; on
   *  subsequent calls reuses them. Hides the sprite if the world's
   *  snapshot service reports no overlapping objects (empty tile, or
   *  all neighbour packs still loading). */
  private refreshObjectOverlay(q: number, r: number, offsetX = 0, offsetY = 0): void {
    const overlay = this.ctx.worldOverlay;
    if (!overlay) return;
    if (!this.overlayTexture) {
      this.overlayTexture = RenderTexture.create({
        width:      HEX_CARD_WIDTH,
        height:     HEX_CARD_HEIGHT,
        resolution: Math.min(window.devicePixelRatio, 2),
      });
    }
    if (!this.overlaySprite) {
      this.overlaySprite = new Sprite(this.overlayTexture);
      this.overlaySprite.alpha = 0.5;
    }
    // Re-add every refresh so the overlay stays the last child of
    // `visual` (addChild on an existing child moves it to the end).
    this.visual.addChild(this.overlaySprite);
    this.overlayQ = q;
    this.overlayR = r;
    this.overlayOffsetX = offsetX;
    this.overlayOffsetY = offsetY;
    this.overlaySprite.visible = overlay(q, r, this.overlayTexture, HEX_CARD_WIDTH, HEX_CARD_HEIGHT, offsetX, offsetY);
    this.invalidateStackedChildren();
  }

  /** Hide the overlay and forget the cached tile. The RT and Sprite
   *  stay around for reuse if the card re-enters a world surface. */
  private clearObjectOverlay(): void {
    this.overlayQ = null;
    this.overlayR = null;
    this.overlayOffsetX = 0;
    this.overlayOffsetY = 0;
    if (this.overlaySprite) this.overlaySprite.visible = false;
    this.invalidateStackedChildren();
  }

  /** Push our current overlay state down to every rect child mounted
   *  on this hex (hexMount + the stack hosts). They use it plus their
   *  own static `chainDelta` to bake their own RT — same content,
   *  shifted to their position. Cascades automatically because the
   *  child's `refreshObjectOverlay` calls its own push at the end. */
  private invalidateStackedChildren(): void {
    const q = this.overlayQ;
    const r = this.overlayR;
    const ox = this.overlayOffsetX;
    const oy = this.overlayOffsetY;
    if (this.hexMount) {
      for (const child of this.hexMount.children) {
        if (child instanceof LayoutCard) child.inheritObjectOverlay(q, r, ox, oy);
      }
    }
    for (const child of this.stackTopHost.children) {
      if (child instanceof LayoutCard) child.inheritObjectOverlay(q, r, ox, oy);
    }
    for (const child of this.stackBottomHost.children) {
      if (child instanceof LayoutCard) child.inheritObjectOverlay(q, r, ox, oy);
    }
  }

  /** Spawn the ascend-particle emitter at the bottom-center of the
   *  hex's bounding box. Mirrors `LayoutRectCard._spawnDeathEffect`;
   *  the bottom-center emission point matches because the mask wipe
   *  shrinks from the bottom upward, so particles trail the wipe
   *  edge. Uses the card definition's primary style color so the
   *  particles inherit the dying card's palette. */
  /** Resolve and apply the card-art sprite for this hex card.
   *  Reads `def.sprite` (the static per-definition sprite filename
   *  from the card's JSON) and fetches the texture through
   *  `cardTextures.getCardArt`, same atlas-packed cache used by
   *  rect cards — every hex card sharing a sprite filename
   *  references one texture. No sprite → hide the art layer.
   *
   *  Centred on the hex bounding box, scaled so the art's longer
   *  side spans [`HEX_ART_FRACTION`] of the inscribed circle's
   *  diameter (the short axis of the hex bounding box) — keeps
   *  the art inside the hex outline without per-card masking. */
  private applyCardArt(def: CardDefinition | null): void {
    const artName = def?.sprite ?? null;
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
    // Hex bounding box: width = sqrt(3) * r, height = 2 * r — so
    // `min(w, h) = w`. The inscribed-circle diameter equals the
    // bounding box's shorter axis; scaling art to a fraction of
    // that keeps every corner inside the outline regardless of the
    // sprite's aspect ratio.
    const target = HEX_ART_FRACTION * Math.min(HEX_CARD_WIDTH, HEX_CARD_HEIGHT);
    const scale = target / Math.max(tex.width, tex.height);
    this.artSprite.scale.set(scale);
    this.artSprite.position.set(HEX_CARD_WIDTH / 2, HEX_CARD_HEIGHT / 2);
    this.artSprite.visible = true;
  }

  private _spawnDeathEffect(): void {
    const pm = ParticleManager.getInstance();
    if (!pm) return;
    const pc = new ParticleContainer();
    pc.position.set(HEX_CARD_WIDTH / 2, HEX_CARD_HEIGHT);
    this.container.addChild(pc);
    this.deathParticleContainer = pc;
    const def = this.currentPackedDefinition !== null
      ? this.ctx.definitions.decode(this.currentPackedDefinition) ?? null
      : null;
    const primary = def?.style[0] ?? "#3a3a4a";
    this.deathParticleHandle = pm.createEmitter(pc, "ascend", { startColor: primary });
  }

  override destroy(): void {
    this.deathParticleHandle?.destroy();
    this.deathParticleHandle = null;
    this.unsubDying?.();
    this.unsubDying = null;
    this.unsubObjectLoad?.();
    this.unsubObjectLoad = null;
    this.unsubArtLoad?.();
    this.unsubArtLoad = null;
    this.unsubTileChange?.();
    this.unsubTileChange = null;
    if (this.overlaySprite) {
      this.overlaySprite.destroy();
      this.overlaySprite = null;
    }
    if (this.overlayTexture) {
      this.overlayTexture.destroy(true);
      this.overlayTexture = null;
    }
    // this.unsubMagnetic?.();        // magnetic stripped
    // this.unsubMagnetic = null;
    super.destroy();
  }
}
