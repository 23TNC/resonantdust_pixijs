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
import { FLAG_ACTION_CANCELED, FLAG_ACTION_COMPLETE, FLAG_ACTION_DEAD, type CachedMagneticAction } from "../actions/ActionManager";
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

  private readonly visual        = new Container();
  private readonly hexSprite     = new Sprite(Texture.EMPTY);
  private readonly progressBar   = new Graphics();
  private readonly stateOverlay  = new Graphics();
  private currentPackedDefinition: number | null = null;
  private dying      = false;
  private deathAlpha = 1;
  private unsubDying: (() => void) | null = null;
  private currentMagneticAction: CachedMagneticAction | null = null;
  private unsubMagnetic: (() => void) | null = null;
  private lastMagneticProgress = 0;
  private lastMagneticActionId: number | null = null;

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

    // Magnetic action progress ring.
    // Suppress if the row is canceled, complete, or dead on the client, or
    // canceled on the server (server can lag the client by ~2 s).
    const CLIENT_SUPPRESS = FLAG_ACTION_CANCELED | FLAG_ACTION_COMPLETE | FLAG_ACTION_DEAD;
    const magneticId = this.currentMagneticAction?.magneticActionId;
    const rawMagneticRow = magneticId !== undefined
      ? this.ctx.data.get("magnetic_actions", magneticId)
      : undefined;
    const serverMagneticRow = magneticId !== undefined
      ? this.ctx.data.getServer("magnetic_actions", magneticId)
      : undefined;
    const SERVER_SUPPRESS = FLAG_ACTION_CANCELED | FLAG_ACTION_COMPLETE | FLAG_ACTION_DEAD;
    const magneticSuppressed =
      (magneticId !== undefined && serverMagneticRow === undefined) ||
      ((rawMagneticRow?.flags ?? 0) & CLIENT_SUPPRESS) !== 0 ||
      ((serverMagneticRow?.flags ?? 0) & SERVER_SUPPRESS) !== 0;
    const magneticAction = this.currentMagneticAction && !magneticSuppressed
      ? this.currentMagneticAction
      : null;

    // Reset floor when the action changes (or disappears).
    if ((magneticAction?.magneticActionId ?? null) !== this.lastMagneticActionId) {
      this.lastMagneticProgress = 0;
      this.lastMagneticActionId = magneticAction?.magneticActionId ?? null;
    }

    this.progressBar.clear();
    if (magneticAction) {
      const recipeDef = this.ctx.recipes.decode(magneticAction.recipe);
      const barStyle = recipeDef?.style ?? null;
      if (barStyle) {
        const { magneticActionId } = magneticAction;
        const now = Date.now() / 1000;
        const activeEnd = magneticAction.end;
        const flushedAt = this.ctx.data.magneticActions.getFlushedAt(magneticActionId);
        const start = flushedAt ?? (activeEnd - (recipeDef?.duration ?? 0));
        const pendingFireAtMs = this.ctx.data.magneticActions.pendingFireAt(magneticActionId);
        const effectiveEnd = pendingFireAtMs !== undefined
          ? pendingFireAtMs / 1000
          : activeEnd;
        const duration = effectiveEnd - start;
        const raw = duration > 0
          ? Math.min(1, Math.max(0, (now - start) / duration))
          : 0;
        // Floor only applies while pending data is in flight (prevents the
        // optimistic prediction from jittering backwards). Once the pending
        // commits, fall back to calculated progress so the bar tracks the
        // server's true `end` instead of staying pinned at the prediction.
        const progressFill = pendingFireAtMs !== undefined
          ? Math.max(raw, this.lastMagneticProgress)
          : raw;
        this.lastMagneticProgress = progressFill;
        const cardDef = this.currentPackedDefinition !== null
          ? this.ctx.definitions.decode(this.currentPackedDefinition) ?? null
          : null;
        const secondary = cardDef?.style[1] ?? "#7a7a8a";
        const resolveColor = (c: string) => (c === "default" ? secondary : c);
        const clockwise = barStyle.direction !== "ccw";
        this._drawMagneticProgress(
          progressFill,
          resolveColor(barStyle.colorLeft),
          resolveColor(barStyle.colorRight),
          clockwise,
        );
      }
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
    return this.state.dragging || moving || this.dying || magneticAction !== null;
  }

  // Draws the hex outline as 6 discrete sides: the first `litSides` in
  // `colorFilled`, the rest in `colorEmpty`. A side lights up as soon as
  // progress crosses its lower threshold (ceil semantics), so side 1 lights
  // at any progress > 0, side 2 at >= 1/6, etc. — each side stays lit for
  // roughly 1/6 of the total duration.
  private _drawMagneticProgress(
    fill: number,
    colorFilled: string,
    colorEmpty: string,
    clockwise: boolean,
  ): void {
    const cx  = HEX_WIDTH  / 2;
    const cy  = HEX_HEIGHT / 2;
    const pts = hexPoints(cx, cy, PROGRESS_RING_RADIUS);

    const litSides = Math.ceil(Math.min(1, Math.max(0, fill)) * 6);
    const order = clockwise ? [4, 5, 0, 1, 2, 3, 4] : [4, 3, 2, 1, 0, 5, 4];
    const vx = (i: number): number => pts[order[i] * 2];
    const vy = (i: number): number => pts[order[i] * 2 + 1];

    if (litSides > 0) {
      for (let i = 0; i < litSides; i++) {
        this.progressBar.moveTo(vx(i), vy(i));
        this.progressBar.lineTo(vx(i + 1), vy(i + 1));
      }
      this.progressBar.stroke({ color: colorFilled, width: PROGRESS_RING_WIDTH });
    }
    if (litSides < 6) {
      for (let i = litSides; i < 6; i++) {
        this.progressBar.moveTo(vx(i), vy(i));
        this.progressBar.lineTo(vx(i + 1), vy(i + 1));
      }
      this.progressBar.stroke({ color: colorEmpty, width: PROGRESS_RING_WIDTH });
    }
  }

  override destroy(): void {
    this.unsubDying?.();
    this.unsubDying = null;
    this.unsubMagnetic?.();
    this.unsubMagnetic = null;
    super.destroy();
  }
}
