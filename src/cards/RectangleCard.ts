import { Container, Graphics, ParticleContainer } from "pixi.js";
import type { GameContext } from "../GameContext";
import type { Card as CardRow } from "../server/bindings/types";
import { ParticleManager, type ParticleHandle } from "../assets/ParticleManager";
import {
  decodeLooseXY,
  getStackedState,
  STACKED_LOOSE,
  STACKED_ON_HEX,
  STACKED_ON_RECT_X,
  STACKED_ON_RECT_Y,
  type LooseXY,
} from "./cardData";
import { HEX_HEIGHT, HEX_RADIUS, HEX_WIDTH } from "./HexCardVisual";
import { GameCard } from "./GameCard";
import { LayoutCard } from "./LayoutCard";
import { RectCardVisual } from "./RectCardVisual";
import { unpackMacroZone } from "../world/worldCoords";

const DEATH_SPEED = 0.04;

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
  private readonly progressBar  = new Graphics();
  private readonly stateOverlay = new Graphics();
  private currentPackedDefinition: number | null = null;
  private titlePosition: RectCardTitlePosition = "top";
  private dying = false;
  private deathProgress = 0;
  private readonly deathMask = new Graphics();
  private unsubDying: (() => void) | null = null;
  private deathParticleContainer: ParticleContainer | null = null;
  private deathParticleHandle: ParticleHandle | null = null;

  constructor(cardId: number, ctx: GameContext) {
    super(cardId, ctx);
    this.unsubDying = ctx.data.subscribeKey("cards", cardId, (change) => {
      if (change.kind === "dying") {
        this.dying = true;
        this.deathProgress = 0;
        this.visual.mask = this.deathMask;
        this._spawnDeathEffect();
        this.invalidate();
      }
    });
    // rectVisual owns body fill + title bar fill + outline.
    // progressBar draws on top of the title bar fill.
    // nameText is re-parented here so it floats above the progress bar.
    // stateOverlay draws hover/pending indicators above everything.
    this.visual.addChild(this.rectVisual);
    this.visual.addChild(this.progressBar);
    this.visual.addChild(this.rectVisual.nameText);
    this.visual.addChild(this.stateOverlay);
    this.container.addChild(this.deathMask);
    this.container.addChild(this.visual);
    this.setSize(RECT_CARD_WIDTH, RECT_CARD_HEIGHT);
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

    const stacked = getStackedState(row.microZone);

    if (stacked === STACKED_LOOSE) {
      this.setTitlePosition("top");
      const { x, y } = decodeLooseXY(row.microLocation);
      this.setTarget(x, y);
    } else if (stacked === STACKED_ON_RECT_X || stacked === STACKED_ON_RECT_Y) {
      const parentId = row.microLocation;
      if (!this.ctx.data.get("cards", parentId)) {
        this.ctx.cards?.get(this.cardId)?.setPosition({
          kind: "loose",
          x: this.targetX,
          y: this.targetY,
        });
        return;
      }
      if (stacked === STACKED_ON_RECT_X) {
        this.setTitlePosition("top");
        this.setTarget(0, -RECT_CARD_TITLE_HEIGHT);
      } else {
        this.setTitlePosition("bottom");
        this.setTarget(0, +RECT_CARD_TITLE_HEIGHT);
      }
    } else if (stacked === STACKED_ON_HEX) {
      if (row.microLocation === 0) {
        // No parent card — position is encoded in macroZone + microZone bit fields.
        const { zoneQ, zoneR } = unpackMacroZone(row.macroZone);
        const q = zoneQ + ((row.microZone >> 5) & 0x7);
        const r = zoneR + ((row.microZone >> 2) & 0x7);
        const x = HEX_RADIUS * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r);
        const y = HEX_RADIUS * (3 / 2 * r);
        this.setTitlePosition("top");
        this.setTarget(x - RECT_CARD_WIDTH / 2, y - RECT_CARD_HEIGHT / 2);
      } else {
        const parentId = row.microLocation;
        if (!this.ctx.data.get("cards", parentId)) {
          this.ctx.cards?.get(this.cardId)?.setPosition({
            kind: "loose",
            x: this.targetX,
            y: this.targetY,
          });
          return;
        }
        this.setTitlePosition("top");
        this.setTarget(
          (HEX_WIDTH  - RECT_CARD_WIDTH)  / 2,
          (HEX_HEIGHT - RECT_CARD_HEIGHT) / 2,
        );
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

    this.rectVisual.draw(def, this.titlePosition);

    const titleY =
      this.titlePosition === "top"
        ? 0
        : Math.max(0, this.height - RECT_CARD_TITLE_HEIGHT);

    // Progress bar — draws over the title bar fill when an action is active.
    const card = this.ctx.cards?.get(this.cardId);
    const actionRow = card?.currentAction
      ? this.ctx.data.get("actions", card.currentAction.actionId)
      : undefined;
    const recipeDef = actionRow
      ? this.ctx.recipes.decode(actionRow.recipe)
      : undefined;
    let progressFill = 0;
    if (actionRow && recipeDef) {
      const now = Date.now() / 1000;
      if (recipeDef.duration > 0) {
        const start = actionRow.end - recipeDef.duration;
        progressFill = Math.min(1, Math.max(0, (now - start) / recipeDef.duration));
      } else {
        const receivedAt = this.ctx.data.actions.getReceivedAt(actionRow.actionId) ?? now;
        const duration = actionRow.end - receivedAt;
        if (duration > 0 && now <= actionRow.end) {
          progressFill = Math.min(1, Math.max(0, (now - receivedAt) / duration));
        }
      }
    }
    const barStyle = recipeDef?.style ?? null;

    this.progressBar.clear();
    if (barStyle && progressFill > 0) {
      const secondary = def?.style[1] ?? "#7a7a8a";
      const resolveColor = (c: string) => (c === "default" ? secondary : c);
      const left   = resolveColor(barStyle.colorLeft);
      const right  = resolveColor(barStyle.colorRight);
      const splitX =
        barStyle.direction === "ltr"
          ? progressFill * this.width
          : (1 - progressFill) * this.width;
      if (splitX > 0) {
        this.progressBar.rect(0, titleY, splitX, RECT_CARD_TITLE_HEIGHT).fill({ color: left });
      }
      if (splitX < this.width) {
        this.progressBar
          .rect(splitX, titleY, this.width - splitX, RECT_CARD_TITLE_HEIGHT)
          .fill({ color: right });
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

        this.ctx.cards?.spliceCard(this.cardId);
        queueMicrotask(() => this.ctx.data.advanceCardDeath(this.cardId));
      }
    }
    this.visual.alpha = this.state.dragging ? 0.7 : 1;

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
    return this.state.dragging || moving || this.dying || actionRow !== undefined;
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

  override destroy(): void {
    this.deathParticleHandle?.destroy();
    this.deathParticleHandle = null;
    this.unsubDying?.();
    this.unsubDying = null;
    super.destroy();
  }
}
