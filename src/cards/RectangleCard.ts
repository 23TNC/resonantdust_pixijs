import { Container, Graphics, Text } from "pixi.js";
import type { CardDefinition } from "../definitions/DefinitionManager";
import type { GameContext } from "../GameContext";
import type { Card as CardRow } from "../server/bindings/types";
import {
  decodeLooseXY,
  getStackedState,
  STACKED_LOOSE,
  STACKED_ON_RECT_X,
  STACKED_ON_RECT_Y,
  type LooseXY,
} from "./cardData";
import { GameCard } from "./GameCard";
import { LayoutCard } from "./LayoutCard";

const FALLBACK_STYLE = ["#3a3a4a", "#7a7a8a", "#0b1426"] as const;
const FALLBACK_NAME = "?";

const DEATH_FADE_LERP = 0.15;
const DEATH_ALPHA_SNAP = 0.01;

export const RECT_CARD_WIDTH = 72;
export const RECT_CARD_HEIGHT = 96;
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
  private deathAlpha = 1;
  private unsubDying: (() => void) | null = null;

  constructor(cardId: number, ctx: GameContext) {
    super(cardId, ctx);
    this.unsubDying = ctx.data.subscribeKey("cards", cardId, (change) => {
      if (change.kind === "dying") {
        this.dying = true;
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
    this.nameText.position.set(
      this.width / 2,
      titleY + RECT_CARD_TITLE_HEIGHT / 2,
    );

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

  override destroy(): void {
    this.unsubDying?.();
    this.unsubDying = null;
    super.destroy();
  }
}
