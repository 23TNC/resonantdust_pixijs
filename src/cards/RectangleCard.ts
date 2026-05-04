import { Container, Graphics, ParticleContainer, Text } from "pixi.js";
import type { CardDefinition } from "../definitions/DefinitionManager";
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
import { HEX_HEIGHT, HEX_WIDTH } from "./HexagonCard";
import { GameCard } from "./GameCard";
import { LayoutCard } from "./LayoutCard";

const FALLBACK_STYLE = ["#3a3a4a", "#7a7a8a", "#0b1426"] as const;
const FALLBACK_NAME = "?";

const DEATH_FADE_LERP = 0.15;
const DEATH_ALPHA_SNAP = 0.01;

export const CARD_SCALE = 1;
export const RECT_CARD_WIDTH = 72 * CARD_SCALE;
export const RECT_CARD_HEIGHT = 96 * CARD_SCALE;
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
  static readonly WIDTH = RECT_CARD_WIDTH;
  static readonly HEIGHT = RECT_CARD_HEIGHT;

  private readonly visual = new Container();
  private readonly bg = new Graphics();
  private readonly stateOverlay = new Graphics();
  private readonly nameText: Text;
  private definition: CardDefinition | null = null;
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
    this.nameText = new Text({
      text: FALLBACK_NAME,
      style: {
        fill: FALLBACK_STYLE[2],
        fontFamily: "Segoe UI",
        fontSize: Math.max(8, Math.floor(RECT_CARD_TITLE_HEIGHT * 0.55)),
        fontWeight: "700",
        align: "center",
        wordWrap: true,
        wordWrapWidth: RECT_CARD_WIDTH - 4,
      },
    });
    this.nameText.anchor.set(0.5);
    // stackHost was added by LayoutCard's constructor as the first child so
    // it draws *behind* these — stacked children peek out from behind us.
    // visual wraps only this card's own pixels so death-fade alpha does not
    // bleed into stackHost (and therefore into stacked children).
    this.visual.addChild(this.bg);
    this.visual.addChild(this.nameText);
    this.visual.addChild(this.stateOverlay);
    this.container.addChild(this.deathMask);
    this.container.addChild(this.visual);
    // Card size is constant; position is owned by the tween in layout().
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
      const def = this.ctx.definitions.decode(row.packedDefinition);
      this.definition = def ?? null;
      this.nameText.text = def?.name ?? FALLBACK_NAME;
      this.nameText.style.fill = def?.style[2] ?? FALLBACK_STYLE[2];
      this.invalidate();
    }

    // Self-position from row. When loose, target = decoded inventory xy.
    // When top-stacked (state 1), we're parented into the parent's stackHost
    // (Card.onDataChange handled the re-parent). We sit *behind* the parent
    // at local y = -titleHeight so our own titlebar peeks out above the
    // parent's top edge. Stack chains accumulate naturally — each child is
    // -titleHeight from its own parent, so child2 ends up at -2*titleHeight
    // from the root parent.
    const stacked = getStackedState(row.microZone);
    if (stacked === STACKED_LOOSE) {
      this.setTitlePosition("top");
      const { x, y } = decodeLooseXY(row.microLocation);
      this.setTarget(x, y);
    } else if (stacked === STACKED_ON_RECT_X || stacked === STACKED_ON_RECT_Y) {
      const parentId = row.microLocation;
      if (!this.ctx.data.get("cards", parentId)) {
        // Parent gone — fall back to loose at current visual position.
        this.ctx.cards?.get(this.cardId)?.setPosition({
          kind: "loose",
          x: this.targetX,
          y: this.targetY,
        });
        return;
      }
      if (stacked === STACKED_ON_RECT_X) {
        // Top stack: behind parent, titlebar peeking out above.
        this.setTitlePosition("top");
        this.setTarget(0, -RECT_CARD_TITLE_HEIGHT);
      } else {
        // Bottom stack: behind parent, titlebar peeking out below.
        this.setTitlePosition("bottom");
        this.setTarget(0, +RECT_CARD_TITLE_HEIGHT);
      }
    } else if (stacked === STACKED_ON_HEX) {
      const parentId = row.microLocation;
      if (!this.ctx.data.get("cards", parentId)) {
        this.ctx.cards?.get(this.cardId)?.setPosition({
          kind: "loose",
          x: this.targetX,
          y: this.targetY,
        });
        return;
      }
      // Mounted on top of a hex — center the rect over the hex face.
      this.setTitlePosition("top");
      this.setTarget(
        (HEX_WIDTH - RECT_CARD_WIDTH) / 2,
        (HEX_HEIGHT - RECT_CARD_HEIGHT) / 2,
      );
    }
  }

  /**
   * When stacked, only our peeking titlebar is visible — the rest of our
   * rect is hidden behind the parent. Restrict self-hits to the titlebar
   * strip so clicks landing on the parent's visible body fall through to
   * the parent. Loose cards keep the default full-rect behavior.
   */
  protected override intersects(localX: number, localY: number): boolean {
    if (!this.isStacked) return super.intersects(localX, localY);
    if (localX < 0 || localX >= this.width) return false;
    const titleY =
      this.titlePosition === "top" ? 0 : this.height - RECT_CARD_TITLE_HEIGHT;
    return localY >= titleY && localY < titleY + RECT_CARD_TITLE_HEIGHT;
  }

  protected override layout(): boolean | void {
    const style = this.definition?.style ?? FALLBACK_STYLE;
    const [primary, secondary, outline] = style;
    const baseStrokeColor = this.state.selected ? 0xffff00 : outline;
    const baseStrokeWidth = this.state.selected ? 3 : 2;

    const titleY =
      this.titlePosition === "top"
        ? 0
        : Math.max(0, this.height - RECT_CARD_TITLE_HEIGHT);

    // Resolve progress bar from current action.
    const card = this.ctx.cards?.get(this.cardId);
    const actionRow = card?.currentAction
      ? this.ctx.data.get("actions", card.currentAction.actionId)
      : undefined;
    const recipeDef = actionRow
      ? this.ctx.recipes.getByIndex(actionRow.recipe)
      : undefined;
    let progressFill = 0;
    if (actionRow && recipeDef && recipeDef.duration > 0) {
      const now = Date.now() / 1000;
      const start = actionRow.end - recipeDef.duration;
      progressFill = Math.min(1, Math.max(0, (now - start) / recipeDef.duration));
    }
    const barStyle = recipeDef?.style ?? null;

    this.bg.clear();
    // Body — full card filled with primary.
    this.bg.rect(0, 0, this.width, this.height).fill({ color: primary });
    // Title bar — split into left/right for progress, or solid secondary.
    if (barStyle && progressFill > 0) {
      const resolveColor = (c: string) => (c === "default" ? secondary : c);
      const left = resolveColor(barStyle.colorLeft);
      const right = resolveColor(barStyle.colorRight);
      const splitX =
        barStyle.direction === "ltr"
          ? progressFill * this.width
          : (1 - progressFill) * this.width;
      if (splitX > 0) {
        this.bg.rect(0, titleY, splitX, RECT_CARD_TITLE_HEIGHT).fill({ color: left });
      }
      if (splitX < this.width) {
        this.bg
          .rect(splitX, titleY, this.width - splitX, RECT_CARD_TITLE_HEIGHT)
          .fill({ color: right });
      }
    } else {
      this.bg
        .rect(0, titleY, this.width, RECT_CARD_TITLE_HEIGHT)
        .fill({ color: secondary });
    }
    // Outline around the whole card.
    this.bg
      .rect(0, 0, this.width, this.height)
      .stroke({ color: baseStrokeColor, width: baseStrokeWidth });

    // Name centered within the title bar.
    this.nameText.position.set(this.width / 2, titleY + RECT_CARD_TITLE_HEIGHT / 2);

    this.stateOverlay.clear();
    if (this.state.hovered) {
      this.stateOverlay
        .rect(-2, -2, this.width + 4, this.height + 4)
        .stroke({ color: 0xffffff, width: 1, alpha: 0.5 });
    }
    if (this.state.pending) {
      this.stateOverlay
        .rect(0, 0, this.width, 3)
        .fill({ color: 0xff8800 });
    }
    if (this.dying) {
      this.deathProgress += (1 - this.deathProgress) * DEATH_FADE_LERP;
      const maskH = (1 - this.deathProgress) * this.height;
      this.deathMask.clear().rect(0, 0, this.width, maskH).fill(0xffffff);
      this.deathParticleContainer?.position.set(this.width / 2, maskH);
      if (maskH < DEATH_ALPHA_SNAP) {
        this.dying = false;
        this.visual.mask = null;
        this.deathMask.clear();
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

    // Tween toward the effective target. While dragging the cursor wins
    // (parent surface is the canvas-aligned overlay, so pointer coords map
    // 1:1 to local coords); otherwise the data-driven target set in
    // applyData wins. While dragging, stay dirty even after reaching the
    // target so cursor moves continue to drive layout.
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
    this.deathParticleHandle = pm.createEmitter(pc, "ascend");
  }

  override destroy(): void {
    this.deathParticleHandle?.destroy();
    this.deathParticleHandle = null;
    this.unsubDying?.();
    this.unsubDying = null;
    super.destroy();
  }
}
