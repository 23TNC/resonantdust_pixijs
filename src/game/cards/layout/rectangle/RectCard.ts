import { Container, Graphics, ParticleContainer } from "pixi.js";
import type { GameContext } from "../../../../GameContext";
import type { Card as CardRow } from "../../../../server/spacetime/bindings/types";
import type { LocalCard } from "../../../../server/data/DataManager";
import { ParticleManager, type ParticleHandle } from "../../../../assets/ParticleManager";
import {
  decodeLooseXY,
  getStackDirection,
  getStackedState,
  STACK_DIRECTION_UP,
  STACKED_LOOSE,
  STACKED_ON_HEX,
  STACKED_ON_ROOT,
  STACKED_SLOT,
  type LooseXY,
} from "../../cardData";
import { HEX_HEIGHT, HEX_RADIUS, HEX_WIDTH } from "../hexagon/HexVisual";
import { GameCard } from "../../game/CardGame";
import { LayoutCard } from "../CardLayout";
import { RectCardVisual } from "./RectVisual";
import { unpackMacroZone } from "../../../../server/data/packing";

const DEATH_SPEED = 0.04;

/** How far to shift the title-bar color toward black/white for the
 *  action-debounce progress fill. The fill picks brighter when the
 *  base is dark and darker when the base is light, so the bar
 *  always contrasts against the unfilled remainder. */
const PROGRESS_LUMA_SHIFT = 0.35;

/** Parse a `#rrggbb` hex string into a 24-bit integer. Returns
 *  `0x7a7a8a` (the fallback title color) if the string is malformed. */
function parseHexColor(hex: string): number {
  if (hex.length === 7 && hex[0] === "#") {
    const n = parseInt(hex.slice(1), 16);
    if (!Number.isNaN(n)) return n & 0xffffff;
  }
  return 0x7a7a8a;
}

/** Shift a color's luminance toward black or white by
 *  `PROGRESS_LUMA_SHIFT`. Brightens when the input is dark, darkens
 *  when it's light — the result always sits visibly off the original. */
function shiftLuminance(hex: string): number {
  const rgb = parseHexColor(hex);
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  // Rec. 709 luma (0..255).
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const target = luma < 128 ? 255 : 0;
  const t = PROGRESS_LUMA_SHIFT;
  const shift = (c: number) => Math.round(c + (target - c) * t);
  return (shift(r) << 16) | (shift(g) << 8) | shift(b);
}

export const CARD_SCALE = 1;
export const RECT_CARD_WIDTH        = 72 * CARD_SCALE;
export const RECT_CARD_HEIGHT       = 96 * CARD_SCALE;
export const RECT_CARD_TITLE_HEIGHT = 24;

export type RectCardTitlePosition = "top" | "bottom";

/** One stacked progress bar in the title area. `fraction` is the fill
 *  amount in `[0, 1]`; `style` is the `progress_style` u3 (1 = ltr,
 *  2 = rtl); `leftColor` is the fill color; `heightCap` (optional) is
 *  the maximum bar height as a fraction of `RECT_CARD_TITLE_HEIGHT`,
 *  shrinking the bar within its `1/N` slot when the cap is tighter. */
interface ProgressBarSpec {
  fraction: number;
  style: number;
  leftColor: number;
  heightCap?: number;
}

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
    // rectVisual owns body fill + title bar fill + outline.
    // progressBar paints over the title bar to show the
    // ActionManager debounce countdown — between rectVisual (so it
    // covers the title fill) and nameText (so the name stays
    // readable). cardOutline and nameText are re-parented above the
    // progress bars so the outline isn't overlapped at the title-bar
    // edges. stateOverlay draws hover/pending indicators above
    // everything.
    this.visual.addChild(this.rectVisual);
    this.visual.addChild(this.progressBar);
    this.visual.addChild(this.rectVisual.nameText);
    this.visual.addChild(this.rectVisual.cardOutline);
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

    // `dead === 1` is set by `DataManager.mirrorCard` when the server row's
    // FLAG_ACTION_DEAD bit is observed. Start the death animation once on
    // that transition; `this.dying` guards re-entry, and once we write back
    // `dead: 2` (in the layout completion branch) the mirror preserves the
    // 2 across further pushes so we don't replay.
    if ((row as LocalCard).dead === 1 && !this.dying) {
      this.dying = true;
      this.deathProgress = 0;
      this.visual.mask = this.deathMask;
      this._spawnDeathEffect();
      this.invalidate();
    }

    const stacked = getStackedState(row.microZone);

    if (stacked === STACKED_LOOSE) {
      this.setTitlePosition("top");
      const { x, y } = decodeLooseXY(row.microLocation);
      this.setTarget(x, y);
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
      if (!this.ctx.data.cardsLocal.get(parentId)) {
        // Defensive — `mirrorCard` already rewrites orphan state-1 at
        // the mirror boundary, but if a parent vanishes after the row
        // landed (mid-tween destroy), fall back to inventory loose.
        this.ctx.cards?.get(this.cardId)?.setPosition({
          kind: "inventory",
          x: this.targetX,
          y: this.targetY,
        });
        return;
      }
      if (getStackDirection(row.microZone) === STACK_DIRECTION_UP) {
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
        if (!this.ctx.data.cardsLocal.get(parentId)) {
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

    // Progress bars: stack server-side recipe indicators (from the
    // local row's `progress` array, populated by `mirrorCard` from
    // future `progress_style`-bearing rows in `cards.server`) followed
    // by the client-side action-debounce indicator. Each bar gets an
    // equal `1/N` slot of the title bar height; a per-bar `heightCap`
    // shrinks an individual bar within its slot (the unused space at
    // the slot's outer edge falls back to the title-bar color
    // underneath). Bars stack from the inside edge of the title (the
    // edge against the card body) outward, so the first spec sits
    // closest to the body.
    //
    // Style codes (`progress_style` u3 from `flags`):
    //   1 = ltr / cw default — fill from left to right
    //   2 = rtl / ccw default — fill from right to left
    // 3..=7 are reserved for future variants.
    this.progressBar.clear();
    const titleColor = def?.style[1] ?? "#7a7a8a";
    const specs: ProgressBarSpec[] = [];
    const local = this.ctx.data.cardsLocal.get(this.cardId);
    if (local?.progress) {
      const nowSecs = Date.now() / 1000;
      const serverFill = shiftLuminance(titleColor);
      for (const sp of local.progress) {
        const span = sp.endSecs - sp.startSecs;
        if (span <= 0) continue;
        const fraction = Math.max(0, Math.min(1, (nowSecs - sp.startSecs) / span));
        specs.push({ fraction, style: sp.style, leftColor: serverFill });
      }
    }
    const debounce = this.ctx.actions?.progressFor(this.cardId) ?? null;
    if (debounce !== null) {
      specs.push({
        fraction: debounce,
        style: 1,
        leftColor: 0xffffff,
        heightCap: 0.3,
      });
    }
    if (specs.length > 0) {
      const titleY = this.titlePosition === "top"
        ? 0
        : this.height - RECT_CARD_TITLE_HEIGHT;
      const slotHeight = RECT_CARD_TITLE_HEIGHT / specs.length;
      // Inside edge of the title bar = the edge facing the card body.
      // For top-position titles that's the bottom of the title bar; for
      // bottom-position titles it's the top.
      const insideEdge = this.titlePosition === "top"
        ? titleY + RECT_CARD_TITLE_HEIGHT
        : titleY;
      const stackDir = this.titlePosition === "top" ? -1 : 1;
      let offset = 0;
      for (const spec of specs) {
        const cap = spec.heightCap !== undefined
          ? RECT_CARD_TITLE_HEIGHT * spec.heightCap
          : slotHeight;
        const barHeight = Math.min(slotHeight, cap);
        // Anchor each bar to the inside edge of its slot.
        const slotInside = insideEdge + stackDir * offset;
        const barY = stackDir < 0 ? slotInside - barHeight : slotInside;
        const fillW = this.width * spec.fraction;
        if (fillW > 0 && barHeight > 0) {
          const fillX = spec.style === 2 ? this.width - fillW : 0;
          this.progressBar
            .rect(fillX, barY, fillW, barHeight)
            .fill({ color: spec.leftColor });
        }
        offset += slotHeight;
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

        // Mark the local row as "animation complete" BEFORE splice runs.
        // Splice's chain-walking via `stackParentOf` filters out
        // `dead === 2` cards so this dying row doesn't show up as a
        // sibling candidate for any survivor's parent lookup. Writing
        // dead=2 first also means the splice doesn't have to detach
        // the dying card to a loose 0,0 position — keeping it in
        // place avoids InventoryGame.tryPush kicking it across the
        // board before the server reaps. The mirror preserves
        // `dead: 2` even when the server row still carries
        // FLAG_ACTION_DEAD, so we don't replay this branch on the
        // next push.
        const cur = this.ctx.data.cardsLocal.get(this.cardId);
        if (cur) this.ctx.data.setLocalCard(this.cardId, { ...cur, dead: 2 });
        this.ctx.cards?.spliceCard(this.cardId);
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
    // Re-run next frame while any progress is mid-fill so the bars
    // animate smoothly rather than only updating on data changes.
    const showingProgress = specs.some((s) => s.fraction < 1);
    return this.state.dragging || moving || this.dying || showingProgress;
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
