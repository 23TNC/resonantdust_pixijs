import { Container, Graphics, Sprite, Texture } from "pixi.js";
import type { GameContext } from "../GameContext";
import { LayoutNode } from "../layout/LayoutNode";
import type { Card as CardRow } from "../server/bindings/types";
import {
  decodeLooseXY,
  getStackedState,
  STACKED_LOOSE,
  type LooseXY,
} from "./cardData";
import { FLAG_ACTION_CANCELED, type CachedMagneticAction } from "../actions/ActionManager";
import { GameCard } from "./GameCard";
import {
  hexPoints,
  HEX_HEIGHT,
  HEX_RADIUS,
  HEX_WIDTH,
} from "./HexCardVisual";
import { LayoutCard } from "./LayoutCard";
import { unpackMacroZone, WORLD_LAYER } from "../world/worldCoords";

export { HEX_HEIGHT, HEX_RADIUS, HEX_WIDTH } from "./HexCardVisual";

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

// Inset ring drawn inside the hex boundary — outer edge sits 5px inside the
// vertex circle so it never overlaps an adjacent tile's stroke.
const PROGRESS_RING_WIDTH  = 4;
const PROGRESS_RING_RADIUS = HEX_RADIUS - 7;

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

  private readonly visual       = new Container();
  private readonly hexSprite    = new Sprite(Texture.EMPTY);
  private readonly progressBar  = new Graphics();
  private readonly stateOverlay = new Graphics();
  private currentPackedDefinition: number | null = null;
  private dying      = false;
  private deathAlpha = 1;
  private unsubDying: (() => void) | null = null;
  private currentMagneticAction: CachedMagneticAction | null = null;
  private unsubMagnetic: (() => void) | null = null;

  constructor(cardId: number, ctx: GameContext) {
    super(cardId, ctx);
    this.unsubDying = ctx.data.subscribeKey("cards", cardId, (change) => {
      if (change.kind === "dying") {
        this.dying = true;
        this.invalidate();
      }
    });
    if (ctx.actions) {
      this.unsubMagnetic = ctx.actions.subscribeMagneticCard(cardId, (action) => {
        this.currentMagneticAction = action;
        this.invalidate();
      });
    }
    this.visual.addChild(this.hexSprite);
    this.visual.addChild(this.progressBar);
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
      const def = this.ctx.definitions.decode(row.packedDefinition) ?? null;
      this.hexSprite.texture = this.ctx.textures.getHexTexture(def, row.packedDefinition);
      this.invalidate();
    }

    if (row.layer >= WORLD_LAYER) {
      const { zoneQ, zoneR } = unpackMacroZone(row.macroZone);
      const q = zoneQ + ((row.microZone >> 5) & 0x7);
      const r = zoneR + ((row.microZone >> 2) & 0x7);
      const x = HEX_RADIUS * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r);
      const y = HEX_RADIUS * (3 / 2 * r);
      this.setTarget(x - HEX_WIDTH / 2, y - HEX_HEIGHT / 2);
      return;
    }

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

    // Progress bar arc — drawn between hexSprite and stateOverlay.
    // Use the regular action if present; fall back to a magnetic action.
    // Cancelled actions (FLAG_ACTION_CANCELED, bit 1) suppress progress so
    // the arc isn't shown ticking during the dying window.
    const card = this.ctx.cards?.get(this.cardId);
    const rawActionRow = card?.currentAction
      ? this.ctx.data.get("actions", card.currentAction.actionId)
      : undefined;
    const actionRow = rawActionRow && (rawActionRow.flags & FLAG_ACTION_CANCELED) === 0
      ? rawActionRow
      : undefined;
    const activeRecipePacked = actionRow?.recipe ?? this.currentMagneticAction?.recipe;
    const activeEnd          = actionRow?.end    ?? this.currentMagneticAction?.end;
    const recipeDef = activeRecipePacked !== undefined
      ? this.ctx.recipes.decode(activeRecipePacked)
      : undefined;
    let progressFill = 0;
    const now = Date.now() / 1000;
    if (activeEnd !== undefined && recipeDef) {
      if (actionRow && recipeDef.duration > 0) {
        const start = activeEnd - recipeDef.duration;
        progressFill = Math.min(1, Math.max(0, (now - start) / recipeDef.duration));
      } else if (this.currentMagneticAction) {
        const { receivedAt } = this.currentMagneticAction;
        const duration = activeEnd - receivedAt;
        if (duration > 0 && now <= activeEnd) {
          progressFill = Math.min(1, Math.max(0, (now - receivedAt) / duration));
        }
      }
    }
    const barStyle = recipeDef?.style ?? null;

    this.progressBar.clear();
    if (barStyle && (actionRow || this.currentMagneticAction)) {
      const clockwise = barStyle.direction !== "ccw";
      this._drawHexOutline(progressFill, barStyle.colorLeft, barStyle.colorRight, clockwise);
    }

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
        queueMicrotask(() => this.ctx.data.advanceCardDeath(this.cardId));
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
    return this.state.dragging || moving || this.dying || activeEnd !== undefined;
  }

  // Vertex 4 = top point. CW order walks right-ward; CCW walks left-ward.
  // Draws the full hex outline split into a filled arc (colorFilled, from the
  // top for progressFill fraction) and an empty arc (colorEmpty, the rest).
  // Exactly one side may carry both colors at the transition point.
  private _drawHexOutline(progressFill: number, colorFilled: string, colorEmpty: string, clockwise: boolean): void {
    const cx = HEX_WIDTH  / 2;
    const cy = HEX_HEIGHT / 2;
    const pts = hexPoints(cx, cy, PROGRESS_RING_RADIUS);
    const fill = Math.min(1, Math.max(0, progressFill));

    const order = clockwise ? [4, 5, 0, 1, 2, 3] : [4, 3, 2, 1, 0, 5];

    const px = (i: number) => pts[i * 2];
    const py = (i: number) => pts[i * 2 + 1];
    const vx = (step: number) => px(order[step % 6]);
    const vy = (step: number) => py(order[step % 6]);

    const splitStep    = fill * 6;
    const splitSideIdx = Math.min(Math.floor(splitStep), 5);
    const splitT       = splitStep - splitSideIdx;

    const fromV  = order[splitSideIdx];
    const toV    = order[(splitSideIdx + 1) % 6];
    const splitX = px(fromV) + (px(toV) - px(fromV)) * splitT;
    const splitY = py(fromV) + (py(toV) - py(fromV)) * splitT;

    // Filled arc: top vertex → split point.
    this.progressBar.moveTo(vx(0), vy(0));
    for (let i = 1; i <= splitSideIdx; i++) this.progressBar.lineTo(vx(i), vy(i));
    if (splitT > 0) this.progressBar.lineTo(splitX, splitY);
    this.progressBar.stroke({ color: colorFilled, width: PROGRESS_RING_WIDTH });

    // Empty arc: split point → top vertex (completing the outline).
    this.progressBar.moveTo(splitX, splitY);
    for (let i = splitSideIdx + 1; i <= 6; i++) this.progressBar.lineTo(vx(i), vy(i));
    this.progressBar.stroke({ color: colorEmpty, width: PROGRESS_RING_WIDTH });
  }

  override destroy(): void {
    this.unsubDying?.();
    this.unsubDying = null;
    this.unsubMagnetic?.();
    this.unsubMagnetic = null;
    super.destroy();
  }
}
