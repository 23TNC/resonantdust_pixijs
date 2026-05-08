import { Container, Graphics, Sprite, Texture } from "pixi.js";
import type { GameContext } from "../../../../GameContext";
import { LayoutNode } from "../../../layout/LayoutNode";
import type { Card as CardRow } from "../../../../server/spacetime/bindings/types";
import {
  decodeLooseXY,
  getStackedState,
  STACKED_LOOSE,
  type LooseXY,
} from "../../cardData";
// Magnetic-action subsystem is offline while ActionManager is stripped.
// Restore when actions return:
//   import {
//     FLAG_ACTION_CANCELED, FLAG_ACTION_COMPLETE, FLAG_ACTION_DEAD,
//     type CachedMagneticAction,
//   } from "../actions/ActionManager";
import { GameCard } from "../../game/CardGame";
import {
  hexPoints,
  HEX_HEIGHT,
  HEX_RADIUS,
  HEX_WIDTH,
} from "./HexVisual";
import { LayoutCard } from "../CardLayout";
// World helpers (unpackMacroZone, WORLD_LAYER) live in `server/data/packing`
// — re-import there when world tier is restored.

export { HEX_HEIGHT, HEX_RADIUS, HEX_WIDTH } from "./HexVisual";

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

const DEATH_FADE_LERP  = 0.15;
const DEATH_ALPHA_SNAP = 0.01;

export class GameHexCard extends GameCard {
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
  static readonly WIDTH  = HEX_WIDTH;
  static readonly HEIGHT = HEX_HEIGHT;

  private readonly visual        = new Container();
  private readonly hexSprite     = new Sprite(Texture.EMPTY);
  private readonly stateOverlay  = new Graphics();
  private currentPackedDefinition: number | null = null;
  private dying      = false;
  private deathAlpha = 1;
  private unsubDying: (() => void) | null = null;
  // Magnetic-action subsystem stripped — restore when actions return:
  //   private currentMagneticAction: CachedMagneticAction | null = null;
  //   private unsubMagnetic: (() => void) | null = null;
  //   private lastMagneticProgress = 0;
  //   private lastMagneticActionId: number | null = null;

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

    // Magnetic-action subscription stripped. Restore when actions return:
    //   if (ctx.actions) {
    //     this.unsubMagnetic = ctx.actions.subscribeMagneticCard(cardId, (action) => {
    //       this.currentMagneticAction = action;
    //       this.invalidate();
    //     });
    //   }

    this.visual.addChild(this.hexSprite);
    this.visual.addChild(this.stateOverlay);
    this.container.addChild(this.visual);
    // hexMount added after visual → mounted rect renders in front of the hex.
    this.hexMount = new HexMount();
    this.addChild(this.hexMount);
    this.setSize(HEX_WIDTH, HEX_HEIGHT);
  }

  applyData(row: CardRow): void {
    if (row.packedDefinition !== this.currentPackedDefinition) {
      this.currentPackedDefinition = row.packedDefinition;
      // TODO: stubbed pending wasm-built definitions.
      // Restore: const def = this.ctx.definitions.decode(row.packedDefinition) ?? null;
      const def = null;
      this.hexSprite.texture = this.ctx.textures.getHexTexture(def, row.packedDefinition);
      this.invalidate();
    }

    // World-tier positioning branch stripped — when world returns, route
    // `row.surface >= WORLD_LAYER` here (using `unpackMacroZone(row.macroZone)`
    // + the local-q/local-r fields packed into `row.microZone`).

    const stacked = getStackedState(row.microZone);
    if (stacked === STACKED_LOOSE) {
      const { x, y } = decodeLooseXY(row.microLocation);
      this.setTarget(x, y);
    }
    // Hex stacking (STACKED_ON_HEX) is not yet implemented.
  }

  protected override layout(): boolean | void {
    const cx = HEX_WIDTH  / 2;
    const cy = HEX_HEIGHT / 2;

    // Magnetic-action progress ring stripped along with the actions
    // subsystem. When actions return, restore: a Graphics child for the
    // progress bar, the action-row fetch + flag-bit suppression check,
    // recipe decode for ring colors, and a call into `_drawMagneticProgress`
    // (kept in git history) to render the per-side hex outline.

    this.stateOverlay.clear();
    if (this.state.selected) {
      const selPts = hexPoints(cx, cy, HEX_RADIUS);
      this.stateOverlay.poly(selPts).stroke({ color: 0xffff00, width: 3 });
    }
    if (this.state.hovered) {
      const hoverPts = hexPoints(cx, cy, HEX_RADIUS + 2);
      this.stateOverlay.poly(hoverPts).stroke({ color: 0xffffff, width: 1, alpha: 0.5 });
    }
    if (this.state.pending) {
      const pendingPts = hexPoints(cx, cy, HEX_RADIUS - 4);
      this.stateOverlay.poly(pendingPts).stroke({ color: 0xff8800, width: 3 });
    }

    if (this.dying) {
      this.deathAlpha += (0 - this.deathAlpha) * DEATH_FADE_LERP;
      if (this.deathAlpha < DEATH_ALPHA_SNAP) {
        this.deathAlpha = 0;
        this.dying = false;
        this.unsubDying?.();
        this.unsubDying = null;
        this.ctx.cards?.spliceCard(this.cardId);
        // TODO: `data.advanceCardDeath` is gone — wire to the new outbound
        // "death finished" signal once defined.
        // queueMicrotask(() => this.ctx.data.advanceCardDeath(this.cardId));
      }
    }
    this.visual.alpha = (this.state.dragging ? 0.7 : 1) * this.deathAlpha;

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
    return this.state.dragging || moving || this.dying;
  }

  override destroy(): void {
    this.unsubDying?.();
    this.unsubDying = null;
    // this.unsubMagnetic?.();        // magnetic stripped
    // this.unsubMagnetic = null;
    super.destroy();
  }
}
