import { NOTO_EMOJI_FAMILY } from "../../assets/fonts";

/**
 * Inline style constants for `DomPanel`. Lifted out of the main
 * class file because they're pure data — no behaviour, no
 * coupling — and at ~150 lines they were dominating the file size
 * of `DomPanel.ts` without adding to its logic.
 *
 * Every style is a `Partial<CSSStyleDeclaration>` so consumers can
 * `Object.assign(el.style, …)` directly. Theming changes live here;
 * `DomPanel` imports the constants and never inlines its own.
 */

// Shared dark fill used by every chrome surface (title bar, body,
// footer). The panel container itself stays transparent so
// `PixiPanel` subclasses can flip just their body to transparent
// and have Pixi content show through the canvas underneath; every
// other panel paints its own chrome and looks identical to before.
export const CHROME_BG = "rgba(20, 22, 30, 0.96)";

export const PANEL_CSS: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  display: "flex",
  flexDirection: "column",
  color: "#ecd6aa",
  fontFamily: "ui-monospace, monospace",
  fontSize: "12px",
  minWidth: "200px",
  zIndex: "20",
  overflow: "hidden",
  // 1px outline so overlapping panels (multiple chat / debug
  // surfaces, future DOM panels) read as distinct rectangles
  // rather than blending into each other. `PixiPanel` overrides
  // this to `none` in its constructor — it draws an equivalent
  // outline in Pixi instead so the Pixi overlay's drag previews
  // can still composite over the edge.
  border: "1px solid #3a3a4a",
};

export const TITLEBAR_CSS: Partial<CSSStyleDeclaration> = {
  // Positioned so the action-button container can absolute-
  // position itself against the title bar's box and vertical-
  // center within it.
  position: "relative",
  display: "flex",
  alignItems: "center",
  padding: "8px 12px",
  // Reserve space on the right for the absolute-positioned action
  // buttons (minimize / close). Width matches `ACTIONS_CSS.width`
  // below so the title text doesn't bleed into the actions zone.
  // Sized to the *Pixi-chrome* button footprint (12px right pad +
  // 32px close + 4px gap + 32px minimize = 80px) — the DOM
  // buttons are visually narrower but `PixiPanel` paints over
  // them with the wider Pixi glyphs, and the drag-skip zone has
  // to cover the visual extent or clicks on the painted button
  // hit the bare title bar instead.
  paddingRight: "80px",
  background: CHROME_BG,
  borderBottom: "1px solid #3a3a4a",
  fontSize: "12px",
  color: "#a0a0b0",
  fontFamily: "sans-serif",
  userSelect: "none",
  cursor: "move",
  gap: "8px",
  flex: "0 0 auto",
  // Explicit `auto` is required (not the default) because
  // `PixiPanel` sets `pointer-events: none` on the parent panel
  // div so body-region clicks fall through to the Pixi canvas.
  // Spec-wise descendants with implicit `auto` should still be
  // hit targets, but in practice we make every chrome element
  // explicit so drag / minimize / close / resize stay reliably
  // interactive regardless of the parent's value.
  pointerEvents: "auto",
};

export const TITLE_CSS: Partial<CSSStyleDeclaration> = {
  flex: "0 0 auto",
};

export const TABS_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
  gap: "4px",
  padding: "4px 8px",
  borderBottom: "1px solid #3a3a4a",
  background: "rgba(12, 14, 20, 0.96)",
  flex: "0 0 auto",
  // See `TITLEBAR_CSS` — explicit auto so `PixiPanel`'s
  // `pointer-events: none` on the panel doesn't take chrome
  // interactivity with it.
  pointerEvents: "auto",
};

export const TAB_BTN_CSS: Partial<CSSStyleDeclaration> = {
  background: "none",
  border: "none",
  color: "#a0a0b0",
  cursor: "pointer",
  fontFamily: NOTO_EMOJI_FAMILY,
  fontSize: "14px",
  padding: "4px 8px",
  borderRadius: "3px",
  lineHeight: "1",
};

export const TAB_BTN_ACTIVE_CSS: Partial<CSSStyleDeclaration> = {
  background: "rgba(40, 44, 56, 0.96)",
  color: "#ecd6aa",
};

export const ACTIONS_CSS: Partial<CSSStyleDeclaration> = {
  // Absolute-positioned inside the title bar (which is
  // `position: relative` per `TITLEBAR_CSS`) and stretched
  // edge-to-edge vertically (`top: 0; bottom: 0`) so the
  // bounding box covers the full title-bar height — not just
  // the buttons' line-height. The drag-start check skips when
  // the pointer target is inside `actionsEl`; an earlier
  // version used `top: 50%; translateY(-50%)` which left ~5px
  // strips above and below the buttons where clicks fell
  // through to the title bar and started an unwanted drag.
  // Spans the full 80px reserved by `TITLEBAR_CSS.paddingRight`
  // horizontally (`right: 0; width: 80`); buttons sit at the
  // right end via flex `justify-end` + 12px right padding, so
  // the visual layout is unchanged. The 80px is sized to the
  // *Pixi-chrome* button footprint (see `TITLEBAR_CSS`
  // padding-right) — the DOM buttons are narrower but
  // `PixiPanel` paints wider Pixi-rendered buttons over them,
  // and the drag-skip zone needs to cover the visual extent
  // or hover-near-button clicks start an unwanted drag.
  // Cursor is explicit `default` so the actions zone doesn't
  // inherit `move` from the title bar — the user reads
  // "non-drag" by hover alone.
  position: "absolute",
  top: "0",
  bottom: "0",
  right: "0",
  width: "80px",
  paddingRight: "12px",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "4px",
  cursor: "default",
  // See `TITLEBAR_CSS` — explicit auto for `PixiPanel` parents.
  pointerEvents: "auto",
};

export const ACTION_BTN_CSS: Partial<CSSStyleDeclaration> = {
  background: "none",
  border: "none",
  color: "#a0a0b0",
  cursor: "pointer",
  fontSize: "16px",
  padding: "0",
  lineHeight: "1",
  // Width matches the Pixi-chrome `BUTTON_WIDTH` (32) so the
  // DOM hit-area sits exactly under the painted Pixi glyph in
  // `PixiPanel` — without this, the DOM button is ~20px wide
  // and the right edge of the Pixi minimize / close glyphs
  // hangs over bare title-bar pixels that miss the button on
  // click. `textAlign: center` + `border-box` give the glyph
  // a 32px slot to centre into, matching the Pixi layout's
  // `(BUTTON_WIDTH - glyph.width) / 2` positioning. Pure DOM
  // panels (no Pixi paint) get the same wider button — the
  // glyph still centres, the layout stays consistent across
  // panel kinds.
  width: "32px",
  boxSizing: "border-box",
  textAlign: "center",
};

export const BODY_CSS: Partial<CSSStyleDeclaration> = {
  flex: "1 1 auto",
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  minHeight: "0",
  // Default opaque chrome backdrop for DOM-content panels (chat,
  // debug, settings). `PixiPanel` overrides to `"transparent"` so
  // the canvas (and the Pixi content drawn on it) is visible
  // through the body region.
  background: CHROME_BG,
};

/** Default background applied to footers installed via
 *  `DomPanel.setFooter`. Footers used to inherit the panel's bg —
 *  now that the panel container is transparent, each footer paints
 *  its own backdrop so the chat input row (and any future footer)
 *  stays opaque over the canvas. */
export const FOOTER_BG = CHROME_BG;

/** Size (px) of the square resize-corner handle. Edge handles use
 *  this as the offset they skip past so they don't overlap the
 *  corner — see `RESIZE_EDGE_*_CSS` / `edgeXCssFor` / `edgeYCssFor`
 *  below. */
export const RESIZE_CORNER_SIZE = 14;

/** Base resize-corner CSS — size + grip lines + cursor. The
 *  `position: absolute` is shared across all four corner variants,
 *  but the actual `top` / `right` / `bottom` / `left` anchors come
 *  from `resizeCornerCssFor` below to pin the corner to the right
 *  edge of the panel. */
export const RESIZE_CORNER_CSS: Partial<CSSStyleDeclaration> = {
  position: "absolute",
  right: "0",
  bottom: "0",
  width:  `${RESIZE_CORNER_SIZE}px`,
  height: `${RESIZE_CORNER_SIZE}px`,
  cursor: "nwse-resize",
  // See `TITLEBAR_CSS` — explicit auto for `PixiPanel` parents.
  pointerEvents: "auto",
  // Two small diagonal lines as a visual grip hint.
  background:
    "linear-gradient(135deg, transparent 0%, transparent 40%, " +
    "rgba(160,160,176,0.5) 41%, rgba(160,160,176,0.5) 45%, " +
    "transparent 46%, transparent 60%, " +
    "rgba(160,160,176,0.5) 61%, rgba(160,160,176,0.5) 65%, " +
    "transparent 66%)",
};

/** Hit-area thickness (px) of each edge resize handle. Thin
 *  enough that the strip doesn't eat noticeable area off the
 *  body region — the user notices it via the cursor change, not
 *  a visible band — but wide enough to actually click on. */
export const RESIZE_EDGE_THICKNESS = 4;

/** Base CSS for the width-resize edge handle (vertical strip on
 *  the left or right side of the panel, depending on anchor).
 *  Pairs with `edgeXCssFor` for per-corner positioning. */
export const RESIZE_EDGE_X_CSS: Partial<CSSStyleDeclaration> = {
  position: "absolute",
  width:    `${RESIZE_EDGE_THICKNESS}px`,
  cursor:   "ew-resize",
  pointerEvents: "auto",
};

/** Base CSS for the height-resize edge handle (horizontal strip
 *  along the top or bottom of the panel, depending on anchor).
 *  Pairs with `edgeYCssFor` for per-corner positioning. */
export const RESIZE_EDGE_Y_CSS: Partial<CSSStyleDeclaration> = {
  position: "absolute",
  height:   `${RESIZE_EDGE_THICKNESS}px`,
  cursor:   "ns-resize",
  pointerEvents: "auto",
};

/** Per-corner positioning + cursor for the resize handle. Two pairs
 *  of cursor styles: `tl` and `br` share `nwse-resize` (the
 *  diagonal `\`), while `tr` and `bl` share `nesw-resize` (`/`).
 *  Use these to repaint the corner when the panel's anchor flips —
 *  the grab corner is always opposite the anchor. */
export function resizeCornerCssFor(
  corner: "tl" | "tr" | "bl" | "br",
): Partial<CSSStyleDeclaration> {
  const isRight  = corner.endsWith("r");
  const isBottom = corner.startsWith("b");
  const cursor   = (corner === "tl" || corner === "br") ? "nwse-resize" : "nesw-resize";
  return {
    top:    isBottom ? "auto" : "0",
    bottom: isBottom ? "0"    : "auto",
    left:   isRight  ? "auto" : "0",
    right:  isRight  ? "0"    : "auto",
    cursor,
  };
}

/** Per-corner positioning for the width-resize edge handle.
 *  Sits on the same side as the resize corner (the side opposite
 *  the anchor), runs the full height of the panel minus the
 *  corner's footprint so the two handles don't overlap. */
export function edgeXCssFor(
  corner: "tl" | "tr" | "bl" | "br",
): Partial<CSSStyleDeclaration> {
  const isRight  = corner.endsWith("r");
  const isBottom = corner.startsWith("b");
  return {
    top:    isBottom ? "0" : `${RESIZE_CORNER_SIZE}px`,
    bottom: isBottom ? `${RESIZE_CORNER_SIZE}px` : "0",
    left:   isRight  ? "auto" : "0",
    right:  isRight  ? "0"    : "auto",
  };
}

/** Per-corner positioning for the height-resize edge handle.
 *  Sits along the same horizontal side as the resize corner,
 *  spanning the full width minus the corner's footprint. */
export function edgeYCssFor(
  corner: "tl" | "tr" | "bl" | "br",
): Partial<CSSStyleDeclaration> {
  const isRight  = corner.endsWith("r");
  const isBottom = corner.startsWith("b");
  return {
    top:    isBottom ? "auto" : "0",
    bottom: isBottom ? "0"    : "auto",
    left:   isRight  ? "0" : `${RESIZE_CORNER_SIZE}px`,
    right:  isRight  ? `${RESIZE_CORNER_SIZE}px` : "0",
  };
}
