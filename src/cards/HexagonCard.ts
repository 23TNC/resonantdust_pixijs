import { Container, Graphics, Text } from "pixi.js";
import type { CardDefinition } from "../definitions/DefinitionManager";
import type { GameContext } from "../GameContext";
import { LayoutNode } from "../layout/LayoutNode";
import type { Card as CardRow } from "../server/bindings/types";
import {
  decodeLooseXY,
  getStackedState,
  STACKED_LOOSE,
  type LooseXY,
} from "./cardData";
import { GameCard } from "./GameCard";
import { LayoutCard } from "./LayoutCard";

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

const FALLBACK_STYLE = ["#3a3a4a", "#7a7a8a", "#0b1426"] as const;
const FALLBACK_NAME = "?";

const DEATH_FADE_LERP = 0.15;
const DEATH_ALPHA_SNAP = 0.01;

export const HEX_RADIUS = 72;
export const HEX_WIDTH = Math.sqrt(3)*HEX_RADIUS;
export const HEX_HEIGHT = HEX_RADIUS * 2;

function hexPoints(cx: number, cy: number, radius: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i + Math.PI / 6;
    pts.push(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  }
  return pts;
}

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
  static readonly WIDTH = HEX_WIDTH;
  static readonly HEIGHT = HEX_HEIGHT;

  private readonly visual = new Container();
  private readonly bg = new Graphics();
  private readonly stateOverlay = new Graphics();
  private readonly nameText: Text;
  private definition: CardDefinition | null = null;
  private currentPackedDefinition: number | null = null;
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
        fontSize: 11,
        fontWeight: "700",
        align: "center",
        wordWrap: true,
        wordWrapWidth: HEX_WIDTH - 8,
      },
    });
    this.nameText.anchor.set(0.5);
    this.visual.addChild(this.bg);
    this.visual.addChild(this.nameText);
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
      const def = this.ctx.definitions.decode(row.packedDefinition);
      this.definition = def ?? null;
      this.nameText.text = def?.name ?? FALLBACK_NAME;
      this.nameText.style.fill = def?.style[2] ?? FALLBACK_STYLE[2];
      this.invalidate();
    }

    const stacked = getStackedState(row.microZone);
    if (stacked === STACKED_LOOSE) {
      const { x, y } = decodeLooseXY(row.microLocation);
      this.setTarget(x, y);
    }
    // Hex stacking (STACKED_ON_HEX) is not yet implemented.
  }

  protected override layout(): boolean | void {
    const style = this.definition?.style ?? FALLBACK_STYLE;
    const [primary, secondary, outline] = style;
    const cx = HEX_WIDTH / 2;
    const cy = HEX_HEIGHT / 2;

    const baseStrokeColor = this.state.selected ? 0xffff00 : outline;
    const baseStrokeWidth = this.state.selected ? 3 : 2;

    const pts = hexPoints(cx, cy, HEX_RADIUS - baseStrokeWidth / 2);

    this.bg.clear();
    this.bg.poly(pts).fill({ color: primary });
    this.bg.rect(cx - 36, cy - 48, 72, 96).fill({ color: secondary });
    this.bg.poly(pts).stroke({ color: baseStrokeColor, width: baseStrokeWidth });

    this.nameText.position.set(cx, cy);

    this.stateOverlay.clear();
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
    return this.state.dragging || moving || this.dying;
  }

  override destroy(): void {
    this.unsubDying?.();
    this.unsubDying = null;
    super.destroy();
  }
}
