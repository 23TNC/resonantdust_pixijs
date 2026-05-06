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
import { brighten } from "./RectangleCard";
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
  // Last progress arc fill we displayed for this card, plus the action key
  // it was tracking ("a:<id>" for a regular action, "m:<id>" for a magnetic
  // action). Used to blend toward the pending-aware target instead of
  // snapping when `pendingFireAt` arrives. Reset to 0 on key change.
  private lastProgress = 0;
  private lastProgressKey: string | null = null;
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
    // the arc isn't shown ticking during the dying window. We consult both
    // the client row and the server row: with the display buffer the client
    // copy can lag a server-side cancel by up to ~2 s, so we suppress as
    // soon as either copy has the bit set.
    const card = this.ctx.cards?.get(this.cardId);
    const actionId = card?.currentAction?.actionId;
    const rawActionRow = actionId !== undefined
      ? this.ctx.data.get("actions", actionId)
      : undefined;
    const serverActionRow = actionId !== undefined
      ? this.ctx.data.getServer("actions", actionId)
      : undefined;
    const cancelled =
      ((rawActionRow?.flags ?? 0) & FLAG_ACTION_CANCELED) !== 0 ||
      ((serverActionRow?.flags ?? 0) & FLAG_ACTION_CANCELED) !== 0;
    const actionRow = rawActionRow && !cancelled ? rawActionRow : undefined;
    const activeRecipePacked = actionRow?.recipe ?? this.currentMagneticAction?.recipe;
    const activeEnd          = actionRow?.end    ?? this.currentMagneticAction?.end;
    const recipeDef = activeRecipePacked !== undefined
      ? this.ctx.recipes.decode(activeRecipePacked)
      : undefined;
    // Blend memory: reset to 0 when the active key changes so the new bar
    // doesn't inherit the previous one's fill (regular ↔ magnetic switches,
    // recipe-completed-into-next-recipe, etc.).
    const currentProgressKey = actionRow
      ? `a:${actionRow.actionId}`
      : this.currentMagneticAction
        ? `m:${this.currentMagneticAction.magneticActionId}`
        : null;
    if (currentProgressKey !== this.lastProgressKey) {
      this.lastProgress = 0;
      this.lastProgressKey = currentProgressKey;
    }

    let progressFill = 0;
    const now = Date.now() / 1000;
    if (activeEnd !== undefined && recipeDef) {
      // Compute two progress targets:
      //   `progressNow`     — anchored in wall-clock at `flushedAt`
      //                       (regular) or `receivedAt` (magnetic), running
      //                       to the recipe's projected end.
      //   `progressPending` — anchored at the same start, running to the
      //                       queued UPDATE's `pendingFireAt` when one is in
      //                       flight (else equals `progressNow`).
      // Blend toward `pending` by a small per-frame fraction so a late or
      // early completion smoothly speeds up / slows down the arc instead of
      // snapping. Direction-preserve: if the arc was moving forward, never
      // step back, and always advance by at least `MIN_FORWARD` so motion
      // doesn't stall when the targets agree.
      let progressNow = 0;
      let progressPending = 0;
      if (actionRow && recipeDef.duration > 0) {
        const pendingFireAtMs = this.ctx.data.actions.pendingFireAt(actionRow.actionId);
        const flushedAt = this.ctx.data.actions.getFlushedAt(actionRow.actionId);
        const start = flushedAt ?? (activeEnd - recipeDef.duration);
        const projectedEnd = start + recipeDef.duration;
        const pendingEnd = pendingFireAtMs !== undefined
          ? pendingFireAtMs / 1000
          : projectedEnd;
        const projectedDuration = projectedEnd - start;
        const pendingDuration = pendingEnd - start;
        if (projectedDuration > 0) {
          progressNow = Math.min(1, Math.max(0, (now - start) / projectedDuration));
        }
        progressPending = pendingDuration > 0
          ? Math.min(1, Math.max(0, (now - start) / pendingDuration))
          : progressNow;
      } else if (this.currentMagneticAction) {
        // `receivedAt` here is flushed-to-client time (set in ActionManager
        // from `getFlushedAt`) — wall-clock anchor.
        const { magneticActionId, receivedAt } = this.currentMagneticAction;
        const pendingFireAtMs = this.ctx.data.magneticActions.pendingFireAt(magneticActionId);
        const projectedEnd = activeEnd;
        const pendingEnd = pendingFireAtMs !== undefined
          ? pendingFireAtMs / 1000
          : projectedEnd;
        const projectedDuration = projectedEnd - receivedAt;
        const pendingDuration = pendingEnd - receivedAt;
        if (projectedDuration > 0) {
          progressNow = Math.min(1, Math.max(0, (now - receivedAt) / projectedDuration));
        }
        progressPending = pendingDuration > 0
          ? Math.min(1, Math.max(0, (now - receivedAt) / pendingDuration))
          : progressNow;
      }

      const BLEND_SCALE = 0.45;
      const MIN_FORWARD = 0.001;
      let blended = progressNow + BLEND_SCALE * (progressPending - progressNow);
      if (this.lastProgress < progressNow) {
        blended = Math.max(blended, this.lastProgress + MIN_FORWARD);
      }
      progressFill = Math.min(1, Math.max(0, blended));
    }
    this.lastProgress = progressFill;
    const barStyle = recipeDef?.style ?? null;

    // Pending-action progress — when an action insert/update is buffered for
    // this card, count down the buffer on the outline arc so the player sees
    // something is on the way. Filled side is a brightened secondary; empty
    // side is the secondary itself. Mirrors the rect-card pending bar.
    let pendingFill = 0;
    if (progressFill === 0 && !this.currentMagneticAction) {
      for (const queued of this.ctx.data.actions.pendingValues()) {
        if (queued.cardId !== this.cardId) continue;
        if ((queued.flags & FLAG_ACTION_CANCELED) !== 0) continue;
        const receivedAt = this.ctx.data.actions.getReceivedAt(queued.actionId);
        const fireAtMs = this.ctx.data.actions.pendingFireAt(queued.actionId);
        if (receivedAt === undefined || fireAtMs === undefined) continue;
        const startMs = receivedAt * 1000;
        const duration = fireAtMs - startMs;
        if (duration <= 0) continue;
        pendingFill = Math.min(1, Math.max(0, (Date.now() - startMs) / duration));
        break;
      }
    }

    this.progressBar.clear();
    if (barStyle && (actionRow || this.currentMagneticAction)) {
      const clockwise = barStyle.direction !== "ccw";
      this._drawHexOutline(progressFill, barStyle.colorLeft, barStyle.colorRight, clockwise);
    } else if (pendingFill > 0) {
      const def = this.currentPackedDefinition !== null
        ? this.ctx.definitions.decode(this.currentPackedDefinition) ?? null
        : null;
      const secondary = def?.style[1] ?? "#7a7a8a";
      const left = `#${brighten(secondary, 0.4).toString(16).padStart(6, "0")}`;
      this._drawHexOutline(pendingFill, left, secondary, /* clockwise = */ true);
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
    return this.state.dragging || moving || this.dying || activeEnd !== undefined || pendingFill > 0;
  }

  // Walks the hex outline starting at the pointy top (vertex 4) in either
  // direction, drawing N completed segments + the in-progress partial in
  // `colorFilled`, then the remaining sides in `colorEmpty`. Each segment is
  // 1/6 of the perimeter, so `fullSegments = floor(progress * 6)` and
  // `partialT = (progress * 6) - fullSegments` carries the in-segment fill.
  // Each color gets its own stroke pair (`moveTo` + `lineTo`s + `stroke()`),
  // and we skip the call entirely when there's no geometry — a stroke on an
  // empty path can leave Pixi's GraphicsContext in a state where the next
  // sub-path picks up stray segments.
  private _drawHexOutline(progressFill: number, colorFilled: string, colorEmpty: string, clockwise: boolean): void {
    const cx = HEX_WIDTH  / 2;
    const cy = HEX_HEIGHT / 2;
    const pts = hexPoints(cx, cy, PROGRESS_RING_RADIUS);
    const fill = Math.min(1, Math.max(0, progressFill));

    // Step 0..6 walks vertex 4 → ... → vertex 4 (closed loop). The 7th entry
    // is the wrap back to top, used by the final segment.
    const order = clockwise ? [4, 5, 0, 1, 2, 3, 4] : [4, 3, 2, 1, 0, 5, 4];
    const vx = (step: number): number => pts[order[step] * 2];
    const vy = (step: number): number => pts[order[step] * 2 + 1];

    const fullSegments = Math.min(6, Math.floor(fill * 6));
    const partialT     = fill * 6 - fullSegments;

    // Split point: where the filled arc ends and the empty arc begins.
    const fromX  = vx(fullSegments);
    const fromY  = vy(fullSegments);
    const toX    = vx(Math.min(fullSegments + 1, 6));
    const toY    = vy(Math.min(fullSegments + 1, 6));
    const splitX = fromX + (toX - fromX) * partialT;
    const splitY = fromY + (toY - fromY) * partialT;

    // Filled arc — N full segments + the partial of the next.
    if (fullSegments > 0 || partialT > 0) {
      this.progressBar.moveTo(vx(0), vy(0));
      for (let i = 1; i <= fullSegments; i++) {
        this.progressBar.lineTo(vx(i), vy(i));
      }
      if (partialT > 0 && fullSegments < 6) {
        this.progressBar.lineTo(splitX, splitY);
      }
      this.progressBar.stroke({ color: colorFilled, width: PROGRESS_RING_WIDTH });
    }

    // Empty arc — split point → remaining vertices → back to top.
    if (fill < 1) {
      this.progressBar.moveTo(splitX, splitY);
      for (let i = fullSegments + 1; i <= 6; i++) {
        this.progressBar.lineTo(vx(i), vy(i));
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
