import { Container, type Texture } from "pixi.js";
import type { GameContext } from "../../../../GameContext";
import type { CardDefinition } from "../../../definitions/DefinitionManager";
import type { Card as CardRow } from "../../../../server/spacetime/bindings/types";
import type { LocalCard } from "../../../../server/data/DataManager";
import {
  decodeLooseXY,
  getStackDirection,
  getStackedState,
  STACK_DIRECTION_UP,
  STACKED_DEFERRED,
  STACKED_LOOSE,
  STACKED_ON_ROOT,
  STACKED_SLOT,
  type LooseXY,
} from "../../cardData";
import { GameHexCard, LayoutHexCard } from "../hexagon/HexCard";
import { WORLD_HEX_RADIUS } from "../../../world/hexSize";
import { GameCard } from "../../game/CardGame";
import { LayoutCard } from "../CardLayout";
import { isSlotHeld } from "../../../actions/chainState";
import { CardArt } from "../../CardArt";
import { getTextureRegistry } from "../../../definitions/TextureRegistry";
import { ownerFactionFolder } from "../../../../server/player/playerFlags";
import { DeathAnimation } from "../DeathAnimation";
import { MagneticBadge } from "./MagneticBadge";
import { ProgressBarLayer } from "./ProgressBarLayer";
import { RectCardVisual } from "./RectVisual";
import { SoulResourceMeter } from "./SoulResourceMeter";
import { StateOverlayLayer } from "./StateOverlayLayer";
import { WorldObjectOverlay } from "../WorldObjectOverlay";
import {
  MINI_ZONE_LAYER,
  WORLD_LAYER,
} from "../../../../server/data/packing";
import { macroOrigin } from "../../../world/worldCoords";

/** True iff `surface` lays cards out on a hex grid (macroZone +
 *  microZone bit fields) rather than bucket-style xy
 *  (microLocation). Mirrors the server's `surface == WORLD_LAYER
 *  || surface == MINI_ZONE_LAYER` conventions in
 *  `place.rs::resolve_loose_target`. */
function isHexGridSurface(surface: number): boolean {
  return (
    surface >= WORLD_LAYER ||
    surface === MINI_ZONE_LAYER
  );
}
import { debug } from "../../../../debug";

export const CARD_SCALE = 1;
export const RECT_CARD_WIDTH        = 72 * CARD_SCALE;
export const RECT_CARD_HEIGHT       = 96 * CARD_SCALE;
export const RECT_CARD_TITLE_HEIGHT = 24;

export type RectCardTitlePosition = "top" | "bottom";

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
  /** Card-art overlay via the shared `CardArt` helper. Same wrapper
   *  used by `HexCard`, the wrench-panel blueprint slots, and the
   *  character-create blueprint preview — keeps anchor / scale /
   *  null-handling consistent across all card surfaces. */
  private readonly cardArt = new CardArt();
  /** Stacked progress bars in the title area — server-driven from
   *  `LocalCard.progress` plus the client action-debounce strip.
   *  See [./ProgressBarLayer.ts]. */
  private readonly progressBar = new ProgressBarLayer();
  /** Hover / selected / pending decoration — paints rectangles
   *  framing the card based on `LayoutCard.state`. See
   *  [./StateOverlayLayer.ts]. */
  private readonly stateOverlay = new StateOverlayLayer();
  /** Magnetic-anchor indicator (🧲). Shown when the row's `magnetic`
   *  flag (bit 12, registry name in `content/cards/flags.json`) is
   *  set — purely cosmetic; the magnetic action's chain renders via
   *  the normal rect-chain path. See [./MagneticBadge.ts]. */
  private readonly magneticBadge = new MagneticBadge();
  /** Soul-card resource meter — four 2×5 clusters of squares, one
   *  per faculty type (corpus / sollertia / aether / anima at the
   *  four corners), painted from the `Soul` row's packed `stats` /
   *  `fatigued` u32s. Drawn for any rect card whose `cardId` has a
   *  matching row in `soulsLocal`; non-soul cards pass `null` and
   *  the meter clears.
   *
   *  Owns its own `Graphics` (parented into `visual` below).
   *  Repainted every layout pass — `unsubResourceMeter` invalidates
   *  on any Soul row change so the per-frame `update(soul,
   *  titlePosition)` picks up fresh counts. See
   *  [./SoulResourceMeter.ts]. */
  private readonly resourceMeter: SoulResourceMeter;
  private unsubResourceMeter: (() => void) | null = null;
  private currentPackedDefinition: number | null = null;
  /** Last-seen `row.flags`. Cached so `layout()` can derive the soul
   *  portrait sprite (top-nibble `portrait_id`) without re-fetching
   *  the row, and so we can invalidate on the rare flag change that
   *  actually affects rendering (portrait shouldn't change after
   *  spawn, but tracking flags keeps `applyData` honest in case
   *  future features add render-relevant fields). */
  private currentFlagsState = 0;
  private titlePosition: RectCardTitlePosition = "top";
  /** Mask-wipe + ascend-particle death animation. Owns its mask
   *  `Graphics`, particle container, and emitter handle. Triggered
   *  by `applyData` when the row first carries `FLAG_ACTION_DEAD`
   *  (and `slot_hold` is clear); driven by `layout()` calling
   *  `tick()` each frame until completion. See [../DeathAnimation.ts]. */
  private readonly deathAnimation: DeathAnimation;
  /** Carry-over for the legacy dying-event subscription. Today no
   *  callers actually subscribe (`FLAG_ACTION_DEAD` polling via the
   *  row's `dead` field replaces the prior `change.kind === "dying"`
   *  event), but the cleanup point at animation completion is kept
   *  so a re-wired subscription drops cleanly. */
  private unsubDying: (() => void) | null = null;

  /** Per-card "objects in front of this card" snapshot. Owns its RT,
   *  Sprite, current `(q, r, offset)`, and the auto-refresh
   *  subscriptions. Public so stacked children can read parent state
   *  (`parent.overlay.q` / `.r` / `.offsetX` / `.offsetY`) without
   *  going through `cardsLocal`. */
  readonly overlay: WorldObjectOverlay;
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
    //   1. rectVisual         — owns the body fill (children below
    //                           are re-parented out of rectVisual)
    //   2. artSprite          — per-instance card art / portrait
    //   3. titleBar           — title-bar fill, re-parented out of rectVisual
    //   4. overlay.sprite     — in-front-objects occluder snapshot
    //                           (eager add — covers body/art/titleBar at
    //                           0.75 alpha; progressBar/nameText/
    //                           cardOutline/stateOverlay sit above it
    //                           so the title text + bar stay readable)
    //   5. progressBar        — debounce countdown, over title fill
    //   6. nameText           — title label, above progressBar
    //   7. cardOutline        — card border, above progressBar
    //   8. stateOverlay       — hover / pending decoration
    this.visual.addChild(this.rectVisual);
    // `CardArt` owns the sprite's anchor / visibility — we just
    // parent it here so it draws above the body but below the title /
    // overlays added next.
    this.visual.addChild(this.cardArt.sprite);
    this.visual.addChild(this.rectVisual.titleBar);
    this.overlay = new WorldObjectOverlay(ctx, {
      width: RECT_CARD_WIDTH,
      height: RECT_CARD_HEIGHT,
      alpha: 0.75,
    });
    // Cascade overlay state to stacked children whenever it
    // mutates (refresh / inheritFrom / clear). The walk over the
    // stack hosts lives on the card because the overlay doesn't
    // know about chain topology.
    this.overlay.onStateChange = () => this.pushObjectOverlayToStacked();
    this.visual.addChild(this.overlay.sprite);
    this.visual.addChild(this.progressBar.graphics);
    this.visual.addChild(this.rectVisual.nameText);
    this.visual.addChild(this.rectVisual.cardOutline);
    this.visual.addChild(this.stateOverlay.graphics);
    // Magnetic badge sits above stateOverlay so hover/pending
    // outlines don't occlude the 🧲 indicator. Owns its own Text;
    // visibility + position are driven from `layout()`.
    this.visual.addChild(this.magneticBadge.text);
    // Soul resource meter. Added above stateOverlay so hover/pending
    // outlines don't occlude it; below magneticText/cardOutline for
    // z-order consistency with other rect-card decorations.
    this.resourceMeter = new SoulResourceMeter(ctx.definitions);
    this.visual.addChild(this.resourceMeter.graphics);
    // Death animation. `deathAnimation.mask` is added to `container`
    // (not `visual`) because Pixi requires masks to be in the
    // display tree but NOT inside the masked container — when the
    // animation starts it sets `this.visual.mask = deathAnimation.mask`.
    // Particles spawn from `container` so they aren't clipped by the
    // mask wipe itself.
    this.deathAnimation = new DeathAnimation({
      width: RECT_CARD_WIDTH,
      height: RECT_CARD_HEIGHT,
      target: this.visual,
      particleHost: this.container,
    });
    this.container.addChild(this.deathAnimation.mask);
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

    // Object-load + tile-change auto-refresh lives inside
    // `WorldObjectOverlay` — see its constructor. The card just
    // observes the resulting state changes via `overlay.onStateChange`.

    // Re-apply card art whenever a pack finishes lazy-loading. A
    // card whose def references a pack outside the eager-preload
    // slice gets the white fallback from `lodTextures.get` on the first
    // frame and hides the art layer; the load completes
    // asynchronously and fires `onLoad`, at which point we
    // re-resolve. Marks the layout dirty so the next pass picks
    // up the new texture (`layout()` calls `applyCardArt(def)`
    // itself).
    this.unsubArtLoad = ctx.lodTextures.onLoad(() => {
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
    if (row.flagsState !== this.currentFlagsState) {
      this.currentFlagsState = row.flagsState;
      this.invalidate();
    }

    // Magnetic-anchor visibility + state-overlay decoration are
    // applied in `layout()` from `currentFlagsState` / `state` — the
    // flag-change invalidate above is enough to refresh the badge
    // on `magnetic` (bit 12) flips.

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
    const slotHeld = isSlotHeld(this.ctx, row.cardId, row.flagsState, row.flagsBk);
    if ((row as LocalCard).dead === 1 && !this.deathAnimation.isRunning && !slotHeld) {
      const def = this.currentPackedDefinition !== null
        ? this.ctx.definitions.decode(this.currentPackedDefinition) ?? null
        : null;
      this.deathAnimation.start(def?.style[0] ?? "#3a3a4a");
      this.invalidate();
    }

    const stacked = getStackedState(row.microZone);

    if (stacked === STACKED_LOOSE) {
      this.setTitlePosition("top");
      if (isHexGridSurface(row.surface)) {
        // LOOSE on a hex-grid surface (world / mini-zone) — the hex
        // address lives in `macroZone` (chunk q/r)
        // + `microZone` (local q/r bit fields, bits 2..=7 since
        // state=Free zeros the low 2 bits). `microLocation` is
        // unused here (it's 0). Position the card's centre on the
        // hex centre (subtract half-w/h to place the top-left
        // corner) so the loose card visually sits on its tile
        // rather than top-left-anchored.
        const { zoneQ, zoneR } = macroOrigin(row.macro);
        const q = zoneQ + ((row.microZone >> 5) & 0x7);
        const r = zoneR + ((row.microZone >> 2) & 0x7);
        const x = WORLD_HEX_RADIUS * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r);
        const y = WORLD_HEX_RADIUS * (3 / 2 * r);
        this.setTarget(x - RECT_CARD_WIDTH / 2, y - RECT_CARD_HEIGHT / 2);
        if (q !== this.overlay.q || r !== this.overlay.r) {
          this.overlay.refresh(q, r);
        }
      } else {
        const { x, y } = decodeLooseXY(row.microLocation);
        this.setTarget(x, y);
        this.overlay.clear();
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
        // The card's current `macroZone` is the soul bucket it lives
        // in; reuse it so the orphan stays in the same inventory.
        this.ctx.cards?.get(this.cardId)?.setPosition({
          kind: "inventory",
          soulCardId: row.macroZone,
          surface: row.surface,
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
        this.overlay.setChainDelta(0, 0);
      } else if (getStackDirection(row.microZone) === STACK_DIRECTION_UP) {
        this.setTitlePosition("top");
        this.setTarget(0, -RECT_CARD_TITLE_HEIGHT);
        this.overlay.setChainDelta(0, RECT_CARD_TITLE_HEIGHT);
      } else {
        this.setTitlePosition("bottom");
        this.setTarget(0, +RECT_CARD_TITLE_HEIGHT);
        this.overlay.setChainDelta(0, -RECT_CARD_TITLE_HEIGHT);
      }
      // Pull parent's current overlay state so we have something to
      // show before the next time the parent re-bakes.
      const parentLayout = parentCard?.layoutCard;
      if (parentLayout instanceof LayoutHexCard || parentLayout instanceof LayoutRectCard) {
        this.inheritObjectOverlay(
          parentLayout.overlay.q,
          parentLayout.overlay.r,
          parentLayout.overlay.offsetX,
          parentLayout.overlay.offsetY,
        );
      } else {
        this.overlay.clear();
      }
    } else if (stacked === STACKED_DEFERRED) {
      // Deferred placement gap render. The row should've been
      // resolved by `mirrorCard` into state 1/2 before reaching the
      // layout, but if it's still state 3 (subscription gap, host
      // not loaded yet), render at the fallback (q, r) baked into
      // `microZone`. `microLocation` is the host_id (resolution
      // anchor, not a chain parent) and is ignored for layout —
      // we don't try to render relative to the host because the
      // host might be a rect, hex, or anything else.
      const { zoneQ, zoneR } = macroOrigin(row.macro);
      const q = zoneQ + ((row.microZone >> 5) & 0x7);
      const r = zoneR + ((row.microZone >> 2) & 0x7);
      const x = WORLD_HEX_RADIUS * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r);
      const y = WORLD_HEX_RADIUS * (3 / 2 * r);
      this.setTitlePosition("top");
      this.setTarget(x - RECT_CARD_WIDTH / 2, y - RECT_CARD_HEIGHT / 2);
      if (q !== this.overlay.q || r !== this.overlay.r) {
        this.overlay.refresh(q, r);
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

    this.rectVisual.draw(def, this.titlePosition, label, this.resolveBodyTexture(def));
    this.applyCardArt(def);

    // Magnetic-anchor badge — visibility derived from the `magnetic`
    // bit on `currentFlagsState`, position depends on `titlePosition`
    // (badge anchors to the body's top edge regardless of chain
    // direction). See [./MagneticBadge.ts].
    this.magneticBadge.update(
      // `magnetic` lives in `flags_state`. Pass `0` for `flags_bk`
      // since the field router won't route there.
      this.ctx.definitions.hasCardFlag(this.currentFlagsState, 0, "magnetic"),
      this.titlePosition,
    );

    // Stacked progress bars in the title area — server-driven from
    // `LocalCard.progress` plus the client action-debounce strip.
    // The layer paints both and returns whether any bar is still
    // mid-fill so we keep the layout dirty next frame. See
    // [./ProgressBarLayer.ts] for the bar-stacking + style decoding.
    const showingProgress = this.progressBar.update({
      local: this.ctx.data.cardsLocal.get(this.cardId),
      debounceFraction: this.ctx.actions?.progressFor(this.cardId) ?? null,
      serverNowMs: this.ctx.reducers.serverNowMs(),
      titleColor: def?.style[1] ?? "#7a7a8a",
      titlePosition: this.titlePosition,
      cardWidth: this.width,
      cardHeight: this.height,
    });

    // Hover / selected / pending decoration. See
    // [./StateOverlayLayer.ts].
    this.stateOverlay.update(this.state, this.width, this.height);

    // Soul resource meter. Repainted every layout pass for any rect
    // card that has a matching Soul row in `soulsLocal` (the local
    // player's soul AND any remote soul whose world zone is in
    // scope). Non-soul cards pass `null` and the meter clears.
    this.resourceMeter.update(
      this.ctx.data.soulsLocal.get(this.cardId) ?? null,
      this.titlePosition,
    );

    if (this.deathAnimation.isRunning) {
      const stillRunning = this.deathAnimation.tick();
      if (!stillRunning) {
        debug.log(["splice"], `[splice] death-anim complete card=${this.cardId} — about to splice`, 0);
        this.unsubDying?.();
        this.unsubDying = null;

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
    // on `overlay.q !== null` so it only runs for cards that were
    // already on a world surface — inventory cards stay clear until
    // they land, at which point applyData refreshes. Uses the card's
    // *global* position because during drag the card is re-parented
    // to the global drag overlay, so its local effX/effY is no
    // longer in the world-card-surface frame — global coords work in
    // both states.
    if (
      this.overlay.q !== null &&
      this.ctx.worldHexAt &&
      (this.state.dragging || moving)
    ) {
      const gp = this.container.getGlobalPosition();
      const hex = this.ctx.worldHexAt(gp.x + RECT_CARD_WIDTH / 2, gp.y + RECT_CARD_HEIGHT / 2);
      // Re-bake every frame while moving so the offset stays
      // up-to-date — the tile snapshot slides with the card's drift
      // relative to the tile centre rather than only snapping on
      // tile-boundary crossings.
      this.overlay.refresh(hex.q, hex.r, hex.offsetX, hex.offsetY);
    }

    // `showingProgress` is set by the `progressBar.update` call
    // above — keeps us dirty next frame while any bar is mid-fill so
    // the fills animate smoothly rather than only updating on data
    // changes.
    return this.state.dragging || moving || this.deathAnimation.isRunning || showingProgress;
  }

  /** Resolve and apply the card-art sprite for this card via the
   *  unified resolver. Reads `def.object` (the
   *  `{ aspect, index? }` reference), looks up the aspect's
   *  render metadata in `TextureRegistry`, and pulls the matching
   *  pack file from `LodTextureManager`.
   *
   *  Variance source: `card_id`. Same def in two rows can render
   *  different sprites unless `def.object.index` pins one — that's
   *  how soul portraits get per-instance variety from a shared
   *  pack. See docs/CARD_OBJECT_UNIFICATION.md. */
  private applyCardArt(def: CardDefinition | null): void {
    const faction =
      this.ctx.definitions.cardFactionOverride(def) ??
      ownerFactionFolder(this.ctx, this.cardId);
    this.cardArt.applyRect(
      this.ctx.lodTextures,
      getTextureRegistry(),
      def?.object ?? null,
      this.cardId,
      this.titlePosition,
      faction,
    );
  }

  /** Resolve `def.texture` (faction-aware) to an atlas Texture for
   *  the body fill. Returns `null` when the def has no texture ref;
   *  otherwise always returns a Texture (the LOD picker's white
   *  fallback covers the load-pending case). Our existing
   *  `lodTextures.onLoad` subscription re-runs `applyData` once a
   *  higher-LOD upgrade lands. Body-fill aspects are shape-driven
   *  — desired size is the card body's bbox so the picker grabs
   *  an LOD large enough to cover-fit without upscaling. */
  private resolveBodyTexture(def: CardDefinition | null): Texture | null {
    const ref = def?.texture;
    if (!ref) return null;
    const faction =
      this.ctx.definitions.cardFactionOverride(def) ??
      ownerFactionFolder(this.ctx, this.cardId);
    return this.ctx.lodTextures.get(
      ref.name,
      Math.max(RECT_CARD_WIDTH, RECT_CARD_HEIGHT),
      this.cardId,
      ref.index,
      faction ?? undefined,
    );
  }

  /** Parent-pushed overlay state. Delegates to `WorldObjectOverlay`,
   *  which adds our own static `chainDelta` (set in `applyData` based
   *  on stack direction) to the parent's offset before re-baking. */
  override inheritObjectOverlay(
    parentQ: number | null,
    parentR: number | null,
    parentOffsetX: number,
    parentOffsetY: number,
  ): void {
    this.overlay.inheritFrom(parentQ, parentR, parentOffsetX, parentOffsetY);
    // `overlay.onStateChange` cascades to stacked children — wired
    // in the constructor.
  }

  /** Cascade our overlay state to any rect children stacked on us.
   *  Mirrors what LayoutHexCard does — each chain link inherits and
   *  re-pushes, so a rect on a rect on a hex on a world tile ends up
   *  correctly aligned without any per-frame invalidation. Invoked
   *  via `overlay.onStateChange` whenever our overlay refreshes,
   *  inherits, or clears. */
  private pushObjectOverlayToStacked(): void {
    const q = this.overlay.q;
    const r = this.overlay.r;
    const ox = this.overlay.offsetX;
    const oy = this.overlay.offsetY;
    for (const child of this.stackTopHost.children) {
      if (child instanceof LayoutCard) child.inheritObjectOverlay(q, r, ox, oy);
    }
    for (const child of this.stackBottomHost.children) {
      if (child instanceof LayoutCard) child.inheritObjectOverlay(q, r, ox, oy);
    }
  }

  override destroy(): void {
    this.deathAnimation.destroy();
    this.unsubDying?.();
    this.unsubDying = null;
    this.unsubResourceMeter?.();
    this.unsubResourceMeter = null;
    this.unsubArtLoad?.();
    this.unsubArtLoad = null;
    // `overlay` owns its sprite, RT, and the object-load / tile-change
    // subscriptions — `destroy` tears all three down.
    this.overlay.destroy();
    super.destroy();
  }
}
