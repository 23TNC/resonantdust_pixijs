import { Graphics } from "pixi.js";
import type { LocalCard } from "../../../../server/data/DataManager";
import {
  RECT_CARD_TITLE_HEIGHT,
  type RectCardTitlePosition,
} from "./RectCard";

/** How far to shift the title-bar color toward black/white for the
 *  server-action progress fill. The fill picks brighter when the
 *  title-bar base is dark and darker when it's light, so the bar
 *  always contrasts against the unfilled remainder. */
const PROGRESS_LUMA_SHIFT = 0.35;

/** Parse a `#rrggbb` hex string into a 24-bit integer. Returns
 *  `0x7a7a8a` (the fallback title color) if the string is malformed.
 *
 *  Duplicated from `SoulResourceMeter` — both files need it for one
 *  call each, and a third caller would be the trigger to extract a
 *  shared util. */
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

/** One stacked progress bar in the title area. `fraction` is the fill
 *  in `[0, 1]`; `style` is the `progress_style` u3 (1 = ltr, 2 = rtl);
 *  `leftColor` is the fill color; `heightCap` (optional) is the
 *  maximum bar height as a fraction of `RECT_CARD_TITLE_HEIGHT`,
 *  shrinking the bar within its `1/N` slot when the cap is tighter. */
interface ProgressBarSpec {
  fraction: number;
  style: number;
  leftColor: number;
  heightCap?: number;
}

export interface ProgressBarInputs {
  /** Local-overlay row for this card. `progress` carries server-driven
   *  bars; absent rows produce no server-driven specs. */
  local: LocalCard | undefined;
  /** Client-side action-debounce fraction in `[0, 1]`, or `null`
   *  when no debounce is active. */
  debounceFraction: number | null;
  /** Server-aligned now in ms — `ReducerManager.serverNowMs()`. Used
   *  to derive server-driven bar fractions from `(startSecs, endSecs)`.
   *
   *  Why the server clock: `(startSecs, endSecs)` are server `valid_at`
   *  values; comparing against `Date.now()` when the client is behind
   *  the server makes the fraction negative (clamped to 0), freezing
   *  the bar until wall-clock catches up. `serverNowMs` interpolates
   *  from the last reducer-event timestamp so the bar starts filling
   *  immediately on action commit. */
  serverNowMs: number;
  /** Title-bar fill color from `def.style[1]` as a hex string. The
   *  layer derives the contrast-shifted server-fill via
   *  `shiftLuminance` so the bar reads against the unfilled
   *  remainder. */
  titleColor: string;
  titlePosition: RectCardTitlePosition;
  cardWidth: number;
  cardHeight: number;
}

/**
 * Stacked progress bars in the title area of a rect card. Server-
 * driven bars from `LocalCard.progress` paint first (one per future-
 * `valid_at` row), followed by the client-side action-debounce bar.
 * Bars share the title height evenly (`1/N` slots), stack from the
 * inside edge of the title (the edge against the card body)
 * outward.
 *
 * Stateless beyond its `Graphics` node — the host (`LayoutRectCard`)
 * passes the building inputs each layout pass and parents
 * `graphics` once at construction.
 *
 * `update` returns `true` when any bar is still mid-fill so the host
 * can include it in `layout()`'s "stay dirty next frame" return.
 */
export class ProgressBarLayer {
  readonly graphics = new Graphics();

  update(inputs: ProgressBarInputs): boolean {
    this.graphics.clear();

    const specs: ProgressBarSpec[] = [];
    const { local, debounceFraction, serverNowMs, titleColor } = inputs;

    // Server-driven bars: one per future-`valid_at` row carrying a
    // non-zero `progress_style`. Fill colour is the title-shifted
    // contrast (see `shiftLuminance`).
    if (local?.progress) {
      const serverFill = shiftLuminance(titleColor);
      for (const sp of local.progress) {
        const span = sp.endSecs - sp.startSecs;
        if (span <= 0) continue;
        const fraction = Math.max(0, Math.min(1, (serverNowMs - sp.startSecs) / span));
        specs.push({ fraction, style: sp.style, leftColor: serverFill });
      }
    }

    // Client-side action-debounce bar — white, 30%-tall, ltr.
    // Anchored on top of the server bars (added after, but stacks
    // outward from the title's inside edge below).
    if (debounceFraction !== null) {
      specs.push({
        fraction: debounceFraction,
        style: 1,
        leftColor: 0xffffff,
        heightCap: 0.3,
      });
    }

    if (specs.length === 0) return false;

    const { titlePosition, cardWidth, cardHeight } = inputs;
    const titleY = titlePosition === "top"
      ? 0
      : cardHeight - RECT_CARD_TITLE_HEIGHT;
    const slotHeight = RECT_CARD_TITLE_HEIGHT / specs.length;
    // Inside edge of the title bar = the edge facing the card body.
    // For top-position titles that's the bottom of the title bar;
    // for bottom-position titles it's the top.
    const insideEdge = titlePosition === "top"
      ? titleY + RECT_CARD_TITLE_HEIGHT
      : titleY;
    const stackDir = titlePosition === "top" ? -1 : 1;
    let offset = 0;
    for (const spec of specs) {
      const cap = spec.heightCap !== undefined
        ? RECT_CARD_TITLE_HEIGHT * spec.heightCap
        : slotHeight;
      const barHeight = Math.min(slotHeight, cap);
      // Anchor each bar to the inside edge of its slot.
      const slotInside = insideEdge + stackDir * offset;
      const barY = stackDir < 0 ? slotInside - barHeight : slotInside;
      const fillW = cardWidth * spec.fraction;
      if (fillW > 0 && barHeight > 0) {
        const fillX = spec.style === 2 ? cardWidth - fillW : 0;
        this.graphics
          .rect(fillX, barY, fillW, barHeight)
          .fill({ color: spec.leftColor });
      }
      offset += slotHeight;
    }

    return specs.some((s) => s.fraction < 1);
  }
}
