import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { GameContext } from "../../../../GameContext";
import type { CardDefinition } from "../../../definitions/DefinitionManager";
import { LayoutNode } from "../../../layout/LayoutNode";
import type { Card as CardRow } from "../../../../server/spacetime/bindings/types";
import type { LocalCard } from "../../../../server/data/DataManager";
import {
  decodeLooseXY,
  decodeMicro,
  microIsCard,
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
import { isSlotHeld } from "../../../actions/chainState";
import { LayoutCard } from "../CardLayout";
import { CardArt } from "../../CardArt";
import { getTextureRegistry } from "../../../definitions/TextureRegistry";
import { DeathAnimation } from "../DeathAnimation";
import { WorldObjectOverlay } from "../WorldObjectOverlay";
import { ownerFactionFolder } from "../../../../server/player/playerFlags";

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
export const HEX_CARD_WIDTH  = Math.sqrt(3) * HEX_CARD_RADIUS;
export const HEX_CARD_HEIGHT = HEX_CARD_RADIUS * 2;

/** Passthrough hit-host for a rect card mounted on top of a hex
 *  (rect is `STACKED_ON_ROOT` with `direction = HEX` under the
 *  unified card model). Always recurses into children; never returns
 *  itself — so clicks on the mounted rect's body are caught by the
 *  rect, not by this container. */
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

export class GameHexCard extends GameCard {
  static readonly RADIUS = HEX_GAME_RADIUS;
  static readonly WIDTH  = HEX_GAME_WIDTH;
  static readonly HEIGHT = HEX_GAME_HEIGHT;

  private isMember = false;
  private microLocation = 0;

  applyData(row: CardRow): void {
    this.isMember = microIsCard(row.flagsBk);
    this.microLocation = row.microLocation;
  }

  isLoose(): boolean {
    return !this.isMember;
  }

  getLoosePosition(): LooseXY | null {
    if (!this.isLoose()) return null;
    return decodeLooseXY(this.microLocation);
  }

  override whereAreYou(): { x: number; y: number } {
    return this.getLoosePosition() ?? { x: 0, y: 0 };
  }
}

// ════════════════════════════════════════════════════════════════════════
// LEGACY — non-generic render half. DISABLED: `Card.create` no longer
// instantiates this (every card uses LayoutGenericCard). MARKED FOR CLEANUP —
// delete once the generic pipeline is stable. NOTE: `GameHexCard` (the data /
// sim half) above is STILL LIVE (drag/drop/stacking interaction); keep it.
// ════════════════════════════════════════════════════════════════════════
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
  /** Card-art overlay via the shared `CardArt` helper — same wrapper
   *  used by `RectCard`, the wrench-panel blueprint slots, and the
   *  character-create blueprint preview. */
  private readonly cardArt = new CardArt();
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
  /** Mask-wipe + ascend-particle death animation. Same wrapper
   *  `LayoutRectCard` uses; the hex's silhouette still wipes away
   *  cleanly because the rect-shaped mask shrinks vertically
   *  through the hex's bounding box. See [../DeathAnimation.ts]. */
  private readonly deathAnimation: DeathAnimation;
  /** Carry-over for the legacy dying-event subscription; see the
   *  matching field on `LayoutRectCard`. */
  private unsubDying: (() => void) | null = null;

  /** Per-card "objects in front of this card" snapshot. Owns its RT,
   *  Sprite, current `(q, r, offset)`, and the auto-refresh
   *  subscriptions. Public so stacked rect children can read parent
   *  state (`parent.overlay.q` / `.r` / `.offsetX` / `.offsetY`) and
   *  derive their own. */
  readonly overlay: WorldObjectOverlay;
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
    // `CardArt` owns anchor / visibility — parent its sprite here so
    // the art draws above the hex base but below the state overlay.
    this.visual.addChild(this.cardArt.sprite);
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
    // In-front-objects overlay — drawn LAST inside `visual`, so it
    // tints body + art + state + magnetic + progress at 0.5 alpha.
    // `WorldObjectOverlay` owns the RT, sprite, q/r state, and the
    // object-load / tile-change auto-refresh subscriptions.
    this.overlay = new WorldObjectOverlay(
      ctx,
      {
        width: HEX_CARD_WIDTH,
        height: HEX_CARD_HEIGHT,
        alpha: 0.5,
      },
      () => this.worldView,
    );
    // Cascade overlay state to mounted rects (hexMount + stack hosts)
    // whenever it mutates. The walk lives on the card because the
    // overlay doesn't know about chain topology.
    this.overlay.onStateChange = () => this.invalidateStackedChildren();
    this.visual.addChild(this.overlay.sprite);
    // Death animation. Mask added to `container` (not `visual`)
    // because Pixi requires masks to be in the display tree but
    // outside the masked container; particles spawn from `container`
    // so they aren't clipped by the wipe.
    this.deathAnimation = new DeathAnimation({
      width: HEX_CARD_WIDTH,
      height: HEX_CARD_HEIGHT,
      target: this.visual,
      particleHost: this.container,
    });
    this.container.addChild(this.deathAnimation.mask);
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

    // Object-load + tile-change auto-refresh lives inside
    // `WorldObjectOverlay` — see its constructor. The card just
    // observes the resulting state changes via `overlay.onStateChange`.

    // Re-apply card art whenever a sprite finishes lazy-loading.
    // `applyCardArt` here is only invoked from `applyData` on a
    // `packedDefinition` change, so an `invalidate()` would not
    // re-resolve the art on its own — we have to call it directly
    // with the current def. Cache-hit fast path for sprites already
    // resolved; per-card cost is one decode + one Map lookup.
    this.unsubArtLoad = ctx.lodTextures.onLoad(() => {
      if (this.currentPackedDefinition === null) return;
      const def = ctx.definitions.decode(this.currentPackedDefinition) ?? null;
      this.applyCardArt(def);
      // Body texture may also have just landed — re-resolve and re-
      // bake the hex background. `getHex` cache hits on subsequent
      // calls once the (def, bodyTexture) key resolves the same way,
      // so this is one Map lookup per onLoad after the first.
      this.applyHexBackground(def);
    });
  }

  applyData(row: CardRow): void {
    if (row.packedDefinition !== this.currentPackedDefinition) {
      this.currentPackedDefinition = row.packedDefinition;
      const def = this.ctx.definitions.decode(row.packedDefinition) ?? null;
      this.applyHexBackground(def);
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
    this.magneticText.visible = this.ctx.definitions.hasCardFlag(row.flagsState, row.flagsBk, "magnetic");
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
    const slotHeldHex = isSlotHeld(this.ctx, row.cardId, row.flagsState, row.flagsBk);
    if ((row as LocalCard).dead === 1 && !this.deathAnimation.isRunning && !slotHeldHex) {
      const def = this.currentPackedDefinition !== null
        ? this.ctx.definitions.decode(this.currentPackedDefinition) ?? null
        : null;
      this.deathAnimation.start(def?.style[0] ?? "#3a3a4a");
      this.invalidate();
    }

    // Loose position is decided by the OWNING VIEWPORT'S GRID, not the
    // surface: a hex viewport centres the soul on its hex, a rect viewport on
    // its cell — `worldView.cellToPixel` applies the grid's own math. The cell
    // address is the chunk origin (`zoneQ/R`, 0 for a single-chunk inventory)
    // plus the loose cell.
    const micro = decodeMicro(row.microLocation, row.flagsBk);
    if (micro.kind === "loose") {
      const q = row.macroZone.zoneQ + micro.localQ;
      const r = row.macroZone.zoneR + micro.localR;
      const cell = this.worldView?.cellToPixel(q, r);
      // Whether to apply the within-cell `(x, y)` offset is decided by the
      // **card's own `stack_state`**, not by the viewport: LOOSE kinds use
      // the offset; SNAP kinds (`SNAP_HEX` / `SNAP_RECT`) render centred.
      const applyOffset = (micro.looseKind & 0b10) === 0;
      const ox = applyOffset ? micro.x : 0;
      const oy = applyOffset ? micro.y : 0;
      if (cell) {
        this.setTarget((cell.x + ox) - HEX_CARD_WIDTH / 2, (cell.y + oy) - HEX_CARD_HEIGHT / 2);
        // Object-occlusion overlay — allowed on any surface/grid; the view
        // returns nothing for a tile with no object.
        //
        // `(offsetX, offsetY)` is *the tile centre's displacement from the
        // card centre*, so negate the card's within-cell offset `(ox, oy)`.
        // Gating on the offset (not just q/r) covers a stale-offset case:
        // the per-frame mid-drag refresh at the bottom of `layout()` leaves
        // `overlay.offsetX/Y` non-zero, and dropping back onto the SAME tile
        // would skip the q/r gate, leaving the stale offset baked in.
        const wantOverlayX = -ox;
        const wantOverlayY = -oy;
        if (
          q !== this.overlay.q ||
          r !== this.overlay.r ||
          wantOverlayX !== this.overlay.offsetX ||
          wantOverlayY !== this.overlay.offsetY
        ) {
          this.overlay.refresh(q, r, wantOverlayX, wantOverlayY);
        }
      } else {
        // No grid view owns this card — hide any leftover overlay and fall
        // back to the raw within-cell pixel offset.
        this.overlay.clear();
        this.setTarget(micro.x, micro.y);
      }
      return;
    }
    this.overlay.clear();
    // Hex stacking — rect-on-hex via `STACKED_ON_ROOT` + `direction = HEX`
    // is wired through `RectCard.layout`; pure hex-on-hex chains are
    // not yet implemented.
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

    if (this.deathAnimation.isRunning) {
      const stillRunning = this.deathAnimation.tick();
      if (!stillRunning) {
        this.unsubDying?.();
        this.unsubDying = null;

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
    // hex changes. Gated on `overlay.q !== null` so it only runs for
    // cards that were already on a world surface (inventory cards
    // stay clear until they land, at which point applyData
    // refreshes). Uses the card's *global* position because during
    // drag the card is re-parented to the global drag overlay, so
    // its local effX/effY is no longer in the world-card-surface
    // frame — global coords work in both states.
    const worldView = this.worldView;
    if (
      this.overlay.q !== null &&
      worldView &&
      (this.state.dragging || moving)
    ) {
      const gp = this.container.getGlobalPosition();
      const hex = worldView.worldHexAt(gp.x + HEX_CARD_WIDTH / 2, gp.y + HEX_CARD_HEIGHT / 2);
      // Re-bake every frame while moving so the offset stays
      // up-to-date — the tile snapshot needs to slide with the
      // card's drift relative to the tile centre, not just snap on
      // tile-boundary crossings.
      this.overlay.refresh(hex.q, hex.r, hex.offsetX, hex.offsetY);
    }

    return this.state.dragging || moving || this.deathAnimation.isRunning || showingProgress;
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

  /** Push our current overlay state down to every rect child mounted
   *  on this hex (hexMount + the stack hosts). They use it plus their
   *  own static `chainDelta` to bake their own RT — same content,
   *  shifted to their position. Cascades automatically because the
   *  child's `inheritObjectOverlay` fires its own state-change
   *  callback. Invoked via `overlay.onStateChange` whenever our
   *  overlay refreshes or clears. */
  private invalidateStackedChildren(): void {
    const q = this.overlay.q;
    const r = this.overlay.r;
    const ox = this.overlay.offsetX;
    const oy = this.overlay.offsetY;
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

  /** Resolve and apply the card-art sprite for this hex card via
   *  the unified resolver — reads `def.object`, looks up the
   *  aspect's render metadata, and pulls the matching pack file
   *  from `LodTextureManager`. Per-row variance via `cardId`
   *  hash, pinned to a specific sprite by `def.object.index` when
   *  present. See docs/CARD_OBJECT_UNIFICATION.md. */
  private applyCardArt(def: CardDefinition | null): void {
    const faction =
      this.ctx.definitions.cardFactionOverride(def) ??
      ownerFactionFolder(this.ctx, this.cardId);
    this.cardArt.applyHex(
      this.ctx.lodTextures,
      getTextureRegistry(),
      def?.object ?? null,
      this.cardId,
      faction,
    );
  }

  /** Resolve `def.texture` (faction-aware) → atlas Texture, then ask
   *  `CardTextureManager.getHex` for the matching pre-baked hex
   *  background and swap it onto our sprite. Called from `applyData`
   *  on def change AND from the `onLoad` subscription when an asset
   *  finishes loading (the second path may upgrade the bake from a
   *  colour-only fallback to a texture-filled variant).
   *
   *  Always re-runs `setSize` after the texture swap — Pixi's sprite
   *  scale is derived from texture dimensions, and `getHex` may
   *  return a freshly-baked texture with a different intrinsic size. */
  private applyHexBackground(def: CardDefinition | null): void {
    let bodyTexture: Texture | null = null;
    const ref = def?.texture;
    if (ref) {
      const faction =
        this.ctx.definitions.cardFactionOverride(def) ??
        ownerFactionFolder(this.ctx, this.cardId);
      // Body-fill aspects are shape-driven — desired size is the
      // hex's bbox so the LOD picker grabs a bucket large enough
      // to cover-fit without upscaling. The aspect's own `size`
      // field doesn't apply here.
      bodyTexture = this.ctx.lodTextures.get(
        ref.name,
        Math.max(HEX_CARD_WIDTH, HEX_CARD_HEIGHT),
        this.cardId,
        ref.index,
        faction ?? undefined,
      );
    }
    this.hexSprite.texture = this.ctx.cardTextures.getHex(def, bodyTexture);
    this.hexSprite.setSize(HEX_CARD_WIDTH, HEX_CARD_HEIGHT);
  }

  override destroy(): void {
    this.deathAnimation.destroy();
    this.unsubDying?.();
    this.unsubDying = null;
    this.unsubArtLoad?.();
    this.unsubArtLoad = null;
    // `overlay` owns its sprite, RT, and the object-load /
    // tile-change subscriptions — `destroy` tears all three down.
    this.overlay.destroy();
    // this.unsubMagnetic?.();        // magnetic stripped
    // this.unsubMagnetic = null;
    super.destroy();
  }
}
