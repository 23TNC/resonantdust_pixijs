import { Graphics, Text, type TextStyleOptions } from "pixi.js";
import { NOTO_EMOJI_FAMILY } from "../../assets/fonts";
import { LayoutNode } from "../../game/layout/LayoutNode";
import { DomPanel, type DomPanelOptions, type DomZBand } from "./DomPanel";

// ─────────────────────────────────────────────────────────────────
// Pixi-rendered chrome style constants. Mirror the DOM `TITLEBAR_CSS`
// values so the visual transition (DOM chrome → Pixi chrome) is
// invisible to users. Defined inline here rather than in
// `DomPanelStyles` so a future pure-DOM panel can re-skin freely
// without dragging Pixi color numbers along.
const CHROME_BG_COLOR = 0x14161e;        // rgba(20, 22, 30, 0.96) ≈
const CHROME_BG_ALPHA = 0.96;
const CHROME_BORDER_COLOR = 0x3a3a4a;    // same as the old PANEL_CSS border
const TITLE_TEXT_COLOR = 0xa0a0b0;
const BUTTON_TEXT_COLOR = 0xa0a0b0;  // matches DOM `ACTION_BTN_CSS.color`
const TITLE_TEXT_SIZE = 12;
const BUTTON_TEXT_SIZE = 16;          // matches DOM `ACTION_BTN_CSS.fontSize`
const TITLE_PAD_LEFT = 12;
const BUTTON_WIDTH = 32;
const BUTTON_GAP = 4;
const BUTTON_PAD_RIGHT = 12;

// Resize-corner grip styling, mirroring `RESIZE_CORNER_CSS`'s
// linear-gradient stripes. The DOM corner is 14×14 with two
// translucent diagonal grip lines at ~42% and ~62% along the box's
// diagonal; we approximate with two short `Graphics` strokes.
const RESIZE_CORNER_SIZE = 14;
const RESIZE_LINE_COLOR  = 0xa0a0b0;
const RESIZE_LINE_ALPHA  = 0.5;
const RESIZE_LINE_WIDTH  = 1.5;

/**
 * Pixi-rendered chrome that visually replaces the (now-invisible)
 * DOM title bar. The DOM title bar still owns interaction (drag
 * handle, button click capture); this node just paints the bar
 * over the canvas at the same screen rect.
 *
 * The reason we do this at all: a DOM-painted title bar composites
 * above the canvas in browser z-order, so a card being dragged in
 * the Pixi overlay (zIndex 1000 in MainLayout) was visually
 * occluded by the title bar even though semantically the card is
 * "in front." Moving the visuals into Pixi puts the title bar
 * back in the canvas's z-stack at default `zIndex: 0`, so the
 * drag overlay correctly draws above it.
 */
class PixiPanelChrome extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly titleText: Text;
  private readonly minimizeText: Text;
  private readonly closeText: Text;
  private showMinimize = false;
  private showClose = false;

  constructor() {
    super();
    const titleStyle: TextStyleOptions = {
      fontFamily: "sans-serif",
      fontSize: TITLE_TEXT_SIZE,
      fill: TITLE_TEXT_COLOR,
    };
    const buttonStyle: TextStyleOptions = {
      fontFamily: NOTO_EMOJI_FAMILY,
      fontSize: BUTTON_TEXT_SIZE,
      fill: BUTTON_TEXT_COLOR,
    };
    this.titleText = new Text({ text: "", style: titleStyle });
    this.minimizeText = new Text({ text: "−", style: buttonStyle });
    this.closeText = new Text({ text: "✕", style: buttonStyle });
    this.container.addChild(this.bg);
    this.container.addChild(this.titleText);
    this.container.addChild(this.minimizeText);
    this.container.addChild(this.closeText);
  }

  setTitle(text: string): void {
    if (this.titleText.text === text) return;
    this.titleText.text = text;
    this.invalidate();
  }
  setMinimizedGlyph(minimized: boolean): void {
    const next = minimized ? "+" : "−";
    if (this.minimizeText.text === next) return;
    this.minimizeText.text = next;
    this.invalidate();
  }
  setShowMinimize(show: boolean): void {
    if (this.showMinimize === show) return;
    this.showMinimize = show;
    this.invalidate();
  }
  setShowClose(show: boolean): void {
    if (this.showClose === show) return;
    this.showClose = show;
    this.invalidate();
  }

  protected override layout(): void {
    this.bg.clear()
      .rect(0, 0, this.width, this.height)
      .fill({ color: CHROME_BG_COLOR, alpha: CHROME_BG_ALPHA })
      // Bottom border replaces the old `TITLEBAR_CSS` `border-bottom`.
      .moveTo(0, this.height - 0.5).lineTo(this.width, this.height - 0.5)
      .stroke({ color: CHROME_BORDER_COLOR, width: 1 });

    // Title text — flush left after the padding, vertical-centered.
    this.titleText.position.set(
      TITLE_PAD_LEFT,
      (this.height - this.titleText.height) / 2,
    );

    // Action buttons positioned right-to-left from the right edge.
    // Close is the rightmost (matches DOM `actionsEl` order), then
    // minimize to its left. Each occupies `BUTTON_WIDTH` and the
    // glyph is centered within that slot so click hot-spots match
    // the DOM buttons' visual centers.
    let rightX = this.width - BUTTON_PAD_RIGHT;

    this.closeText.visible = this.showClose;
    if (this.showClose) {
      rightX -= BUTTON_WIDTH;
      this.closeText.position.set(
        rightX + (BUTTON_WIDTH - this.closeText.width) / 2,
        (this.height - this.closeText.height) / 2,
      );
      rightX -= BUTTON_GAP;
    }

    this.minimizeText.visible = this.showMinimize;
    if (this.showMinimize) {
      rightX -= BUTTON_WIDTH;
      this.minimizeText.position.set(
        rightX + (BUTTON_WIDTH - this.minimizeText.width) / 2,
        (this.height - this.minimizeText.height) / 2,
      );
    }
  }
}

/**
 * Pixi-rendered resize indicator. Like `PixiPanelChrome`, the DOM
 * resize-corner div stays in place for pointer capture (resize
 * gestures still go through `attachResize`'s document-level
 * pointermove/up listeners) — this node just paints the visible
 * grip lines over the DOM corner's screen rect. Cards in the
 * `MainLayout.overlay` (zIndex 1000) draw above it.
 *
 * The grip is two short parallel diagonal strokes inside a 14×14
 * box, matching the `linear-gradient(135deg, ...)` stripes the
 * DOM corner used to render. Same drawing for all four corner
 * orientations — the DOM CSS used the same gradient for every
 * corner too; only the box's position on the panel changes.
 */
class PixiResizeIndicator extends LayoutNode {
  private readonly gfx = new Graphics();

  constructor() {
    super();
    this.container.addChild(this.gfx);
  }

  protected override layout(): void {
    // Render lines in a fixed 14×14 coord space; the parent's
    // `setBounds(...)` positions + scales us. (`setBounds` only
    // moves the container — the Graphics shape is intrinsic and
    // remains 14px.)
    this.gfx.clear()
      // Inner stripe — longer, further from the corner.
      .moveTo(2,  12).lineTo(12, 2)
      .stroke({ width: RESIZE_LINE_WIDTH, color: RESIZE_LINE_COLOR, alpha: RESIZE_LINE_ALPHA })
      // Outer stripe — shorter, closer to the corner.
      .moveTo(7,  12).lineTo(12, 7)
      .stroke({ width: RESIZE_LINE_WIDTH, color: RESIZE_LINE_COLOR, alpha: RESIZE_LINE_ALPHA });
  }
}

/**
 * Outline node — paints a 1px stroke around the panel's outer rect.
 * Renders above the panel's content + chrome (added last to the
 * parent in `PixiPanel.constructor`) so the outline silhouettes the
 * panel even when its body is filled by another panel's content
 * underneath. Lets the user tell overlapping panels apart, which
 * matters most for inventories — they share the same default rect,
 * so a fresh panel for a new soul lands on top of every prior one.
 */
class PixiPanelOutline extends LayoutNode {
  private readonly gfx = new Graphics();
  constructor() {
    super();
    this.container.addChild(this.gfx);
  }
  /** Hit-transparent: the outline spans the whole panel rect and
   *  sits on top of `content` / `chrome`, so a default `intersects`
   *  would intercept every click on the panel and break drag /
   *  click-to-focus. Returning `false` makes hit-test skip the
   *  outline entirely and reach the panel's interactive surfaces
   *  underneath. */
  protected override intersects(): boolean {
    return false;
  }
  protected override layout(): void {
    this.gfx.clear()
      .rect(0, 0, this.width, this.height)
      .stroke({ color: CHROME_BORDER_COLOR, width: 1 });
  }
}

/** Re-export the corner-box size for callers that need to align
 *  bounds to it without importing the whole panel module. */
export const PIXI_RESIZE_CORNER_SIZE = RESIZE_CORNER_SIZE;

export interface PixiPanelOptions extends DomPanelOptions {
  /** Layout-tree parent that the panel's content + mask attach to.
   *  Must be transform-free (parented to a root container at (0, 0)
   *  in screen coords) so the DOM `getBoundingClientRect()` →
   *  Pixi-local-coords translation lands directly. */
  parent: LayoutNode;
  /** Inset (in pixels) applied to each side of the body rect
   *  before positioning the Pixi `content`. Use to reserve a strip
   *  inside the panel for DOM widgets surrounding the Pixi area
   *  (e.g. tabs above, button row below). Each side defaults to 0
   *  when omitted; the body itself still occupies the full panel
   *  body region, only the Pixi content shrinks. */
  padding?: PixiPanelPadding;
  // Note: the previous `masked?: boolean` constructor opt is gone.
  // Mask state is now a persisted DomPanel setting (`DomPanel.isMasked`,
  // toggle row in `PanelSettingsPopup`), seeded by content defaults +
  // localStorage. Default is `true`; flip it via the popup or a
  // content-defaults entry instead of the constructor.
}

export interface PixiPanelPadding {
  top?:    number;
  bottom?: number;
  left?:   number;
  right?:  number;
}

/**
 * DOM-shell panel hosting Pixi content. The DOM side (`DomPanel`)
 * owns drag / resize / minimize / close + the title-bar chrome;
 * this subclass adds a `content` `LayoutNode` whose position and
 * size mirror the panel's body rect on every change.
 *
 * Architecture:
 *   - `content` is a hit-testable `LayoutNode`; consumers add their
 *     Pixi-rendered children to it.
 *   - When `masked: true`, a sibling `Graphics` clips `content` to
 *     the body rect so children that overflow get cropped. The mask
 *     is a Pixi-side sibling (not a `LayoutNode`) — hit-testing
 *     ignores it.
 *   - Both `content` and the mask are attached to `opts.parent`,
 *     which must be transform-free. That lets the panel hand
 *     `DOMRect` coords (viewport pixels) directly to `setBounds`
 *     and `Graphics.rect` — no DPR or transform math here.
 *   - Visibility tracks `isOpen && !isMinimized`. When hidden, the
 *     mask is detached and the content's container goes invisible
 *     so Pixi culls the subtree (no draw-call cost while parked).
 *
 * **Body rect, not panel rect** — the title bar and tab strip are
 * DOM chrome; Pixi content should not draw over them. Subscribes
 * to `onRectChange` and reads `bodyRect` on each fire.
 */
export class PixiPanel extends DomPanel {
  /** Public content node. Consumers add Pixi children here; it
   *  positions and sizes itself to the panel's body region on
   *  every rect change. */
  readonly content: LayoutNode;
  /** Pixi-rendered title bar that draws over the (visually-
   *  transparent) DOM title bar. Lives as a sibling of `content`
   *  under `opts.parent`, so the `MainLayout` overlay (zIndex
   *  1000) can draw above it during card drags. */
  private readonly chrome: PixiPanelChrome;
  /** Pixi-rendered resize grip that draws over the (visually-
   *  transparent) DOM resize-corner div. Same z-stack reasoning as
   *  `chrome`. */
  private readonly resizeIndicator: PixiResizeIndicator;
  /** 1px stroke around the panel's outer rect — silhouettes the
   *  panel against overlapping siblings so the user can tell
   *  inventories apart when they stack at the same default rect. */
  private readonly outline: PixiPanelOutline;

  private readonly parent: LayoutNode;
  /** The body-fill mask Graphics. Allocated lazily in
   *  `applyMaskState` when the persisted `isMasked` flag is on (or
   *  flipped on at runtime via the popup) and torn down when it
   *  flips off — saves the ~3 draw calls per masked container the
   *  feature was created to address. `null` whenever no mask is
   *  active. */
  private maskGfx: Graphics | null;
  /** Per-side inset from the body rect, applied before sizing the
   *  Pixi `content`. Resolved once at construction with `0` filling
   *  in for any omitted side. Mutable in principle but not exposed
   *  as such yet — add a setter if dynamic reflow becomes a need. */
  private readonly padding: Required<PixiPanelPadding>;
  private readonly unsubRect:     () => void;
  private readonly unsubOpen:     () => void;
  private readonly unsubMinimize: () => void;
  private readonly unsubMinimizable: () => void;
  private readonly unsubResizable:   () => void;
  private readonly unsubClosable:    () => void;
  private readonly unsubHideMinimizeBtn: () => void;
  private readonly unsubHideCloseBtn:    () => void;
  /** Cleanup for the `onFocus` subscription that lifts this panel's
   *  Pixi nodes to the top of their layer (so the focused panel
   *  renders + hit-tests above its peers). */
  private readonly unsubFocusReorder: () => void;
  /** Cleanup for the `onMaskedChange` subscription — the popup's
   *  Mask toggle invalidates the mask Graphics via
   *  `applyMaskState`. */
  private readonly unsubMasked: () => void;
  /** Cleanup for the `uiEditMode.on` subscription that toggles
   *  panel + body `pointer-events` between `none` (default — clicks
   *  fall through to Pixi) and `auto` (edit mode — clicks land on
   *  the panel so they can open the per-panel settings popup).
   *  `null` when no `uiEditMode` was provided; in that case the
   *  panel stays `pointer-events: none` for its whole lifetime. */
  private readonly unsubUiEdit: (() => void) | null;

  constructor(opts: PixiPanelOptions) {
    // Auto-derive the DOM z-band from the Pixi parent layer
    // when the caller doesn't override. `MainLayout` tags each
    // LayerNode with a `band` field matching its z-position
    // (gameview / inventory / overlay); we duck-type read it
    // here to keep PixiPanel decoupled from the specific
    // LayerNode class. Pure DomPanels (no Pixi parent) default
    // to `"dom"` via `DomPanel`'s own fallback.
    const derivedBand = (opts.parent as { band?: DomZBand }).band;
    super({ ...opts, domZBand: opts.domZBand ?? derivedBand });
    this.parent = opts.parent;
    this.padding = {
      top:    opts.padding?.top    ?? 0,
      bottom: opts.padding?.bottom ?? 0,
      left:   opts.padding?.left   ?? 0,
      right:  opts.padding?.right  ?? 0,
    };
    // The body is a DOM div that visually overlays the canvas where
    // the Pixi content lives. Two static overrides + one dynamic:
    //
    // - Body `background: transparent`. Overrides the shared
    //   `BODY_CSS` chrome backdrop so the canvas (and the Pixi
    //   content drawn on it) is visible through the body region.
    //   The panel container is already transparent (see
    //   `PANEL_CSS`); chrome colors live on title bar / tabs /
    //   footer.
    // - Panel + body `pointer-events` are toggled below by the
    //   `uiEditMode.on` subscription. Default state (edit mode off,
    //   or no `uiEditMode` provided) is `none` on both so clicks
    //   fall through to the Pixi cards / buttons beneath. With body
    //   alone at `none`, hit-testing would still land on the
    //   parent panel div (default `auto`) and never reach the
    //   canvas — so the panel itself flips to `none` too. Chrome
    //   children (title bar, tabs, actions, resize corner) default
    //   to `auto`, which keeps them targetable independently of
    //   the parent, so drag / resize / minimize / close still
    //   work; chrome-originated events still bubble up to the
    //   panel's `pointerdown` / `click` listeners.
    //
    //   While edit mode is on, both flip to `auto` so a click
    //   anywhere on the panel (body included) lands on the body
    //   div and bubbles up to the panel's `click` → `openSettings`
    //   handler. Pixi-side interactions are disabled in this state
    //   on purpose — the user is arranging panels, not playing.
    this.body.style.background = "transparent";
    // Hide the DOM-rendered border (set by `PANEL_CSS`) — Pixi
    // draws an equivalent outline in canvas space via
    // `this.outline`, so a DOM border on top of the transparent
    // body would composite above the Pixi overlay and clip drag
    // previews at the panel edge.
    this.panel.style.border = "none";
    this.setBodyInteractive(false);
    if (opts.uiEditMode) {
      this.unsubUiEdit = opts.uiEditMode.on((enabled) => {
        this.setBodyInteractive(enabled);
      });
    } else {
      this.unsubUiEdit = null;
    }

    // Hide DOM title bar visuals — its background, title text, and
    // action button glyphs all turn transparent. The DOM elements
    // remain in the layout flow (so the panel's content sits below
    // the title bar slot as usual) and keep `pointer-events: auto`
    // for drag + click handling. The visible bar is the Pixi chrome
    // built below.
    this.titlebar.style.background = "transparent";
    this.titlebar.style.borderBottom = "none";
    this.titleEl.style.color = "transparent";
    this.minimizeBtn.style.color = "transparent";
    if (this.closeBtn) this.closeBtn.style.color = "transparent";

    // Hide the DOM resize corner's gradient — Pixi indicator paints
    // the visible grip lines. The corner div stays in place with
    // `pointer-events: auto` so `attachResize`'s gesture wiring
    // still fires.
    this.resizeCorner.style.background = "none";

    this.content = new LayoutNode();
    this.parent.addChild(this.content);

    // Pixi chrome + resize indicator — parented to the same
    // `opts.parent` as `content` so they live in the same coordinate
    // space and inherit the MainLayout sortableChildren behaviour
    // (default zIndex 0; drag overlay at zIndex 1000 draws above).
    this.chrome = new PixiPanelChrome();
    this.chrome.setTitle(this.titleText);
    this.parent.addChild(this.chrome);

    this.resizeIndicator = new PixiResizeIndicator();
    this.parent.addChild(this.resizeIndicator);

    // Outline added last so it draws on top of the panel's own
    // content / chrome / resize-indicator within the parent layer.
    // Focus reorder lifts it along with the rest.
    this.outline = new PixiPanelOutline();
    this.parent.addChild(this.outline);

    // The mask row is meaningful on PixiPanels — re-enable it
    // here (DomPanel default-hides it for plain DOM panels). The
    // popup's Mask toggle drives `this.toggleMasked` → fires
    // `onMaskedChange` → `applyMaskState` allocates / tears down
    // the Graphics so the drawcall saving lands live.
    this._hiddenSettings.delete("mask");
    this.maskGfx = null;
    this.applyMaskState();

    this.applyVisibility();

    this.unsubRect        = this.onRectChange(() => this.syncRect());
    this.unsubOpen        = this.onOpenChange(() => this.applyVisibility());
    this.unsubMinimize    = this.onMinimizeChange(() => {
      this.chrome.setMinimizedGlyph(this.isMinimized);
      this.applyVisibility();
    });
    // Minimizable / closable changes hide their respective Pixi
    // buttons in lock-step with the DOM ones. Anchor used to gate
    // close here, but anchor is now purely a resize-corner preset
    // and no longer affects chrome visibility — the resize
    // indicator follows anchor changes via the existing rectChange
    // path (`applyAnchor` fires it), so no separate subscription
    // is needed.
    this.unsubMinimizable = this.onMinimizableChange(() => this.refreshChromeState());
    this.unsubClosable    = this.onClosableChange(()    => this.refreshChromeState());
    // The "hide button" toggles are independent from the
    // capability toggles, so they need their own subscriptions
    // even though both end up calling the same refresh.
    this.unsubHideMinimizeBtn = this.onHideMinimizeBtnChange(() => this.refreshChromeState());
    this.unsubHideCloseBtn    = this.onHideCloseBtnChange(()    => this.refreshChromeState());
    // Resize toggle hides / re-shows the Pixi grip alongside the
    // DOM corner — re-runs the full visibility pass since
    // `isResizable` participates in `applyVisibility`.
    this.unsubResizable   = this.onResizableChange(() => this.applyVisibility());

    // Focus → bring our Pixi nodes to the top of the parent layer.
    // DomPanel's bringToFront already updates DOM z-index; this hook
    // does the matching Pixi-side reorder. Both LayoutNode.children
    // (hit-test) and the Pixi container's children (render) move in
    // lockstep via `LayoutNode.bringToFront`, so the focused panel
    // can't visually render on top while clicks still route to a
    // peer underneath.
    this.unsubFocusReorder = this.onFocus(() => {
      this.parent.bringToFront(this.content);
      this.parent.bringToFront(this.chrome);
      this.parent.bringToFront(this.resizeIndicator);
      this.parent.bringToFront(this.outline);
    });
    this.unsubMasked = this.onMaskedChange(() => this.applyMaskState());

    // Seed initial chrome state + rect so consumers that add
    // children before opening the panel see correct bounds on
    // first layout.
    this.refreshChromeState();
    this.syncRect();
  }

  /** Reconcile the Pixi chrome's button-visibility flags with the
   *  underlying DomPanel state. Mirrors what `refreshChrome` does
   *  for the DOM buttons. Called on construct + every minimizable
   *  / closable / minimize change. */
  private refreshChromeState(): void {
    // Effective visibility = capability && !hide-button. Both
    // toggles flow into the same Pixi chrome flag; DomPanel
    // handles the same AND for the DOM side in `refreshChrome`.
    this.chrome.setShowMinimize(this.isMinimizeBtnVisible);
    this.chrome.setShowClose(this.isCloseBtnVisible);
    this.chrome.setMinimizedGlyph(this.isMinimized);
  }

  /** Mirror title updates onto the Pixi chrome's text node. The
   *  DOM-side update (the `titleEl` span) still happens in
   *  `super.setTitle`; this just keeps the Pixi-rendered title
   *  string in lockstep. */
  override setTitle(text: string): void {
    super.setTitle(text);
    this.chrome.setTitle(text);
  }

  /** Allocate or tear down the mask Graphics based on the persisted
   *  `isMasked` flag. Called on construct (initial seed) and from
   *  the `onMaskedChange` subscription (popup toggle). When turning
   *  off, also clear `content.container.mask` so Pixi stops
   *  stencil-rendering — the drawcall saving the feature exists for.
   *  When turning on, re-sync rect + visibility so the freshly-
   *  allocated mask matches the body and attaches if visible. */
  private applyMaskState(): void {
    const wantMask = this.isMasked;
    const haveMask = this.maskGfx !== null;
    if (wantMask === haveMask) return;
    if (wantMask) {
      this.maskGfx = new Graphics();
      // Mask is a Pixi-level sibling of content's container — not a
      // `LayoutNode`, since it shouldn't be hit-tested. Sharing the
      // parent's container puts both in the same transform context
      // so the viewport-pixel coords used to draw the mask match
      // the bounds applied to `content`.
      this.parent.container.addChild(this.maskGfx);
      this.syncRect();
      this.applyVisibility();
    } else {
      this.content.container.mask = null;
      if (this.maskGfx) {
        this.parent.container.removeChild(this.maskGfx);
        this.maskGfx.destroy();
        this.maskGfx = null;
      }
    }
  }

  override destroy(): void {
    this.unsubRect();
    this.unsubOpen();
    this.unsubMinimize();
    this.unsubMinimizable();
    this.unsubResizable();
    this.unsubClosable();
    this.unsubHideMinimizeBtn();
    this.unsubHideCloseBtn();
    this.unsubFocusReorder();
    this.unsubMasked();
    this.unsubUiEdit?.();
    this.parent.removeChild(this.content);
    this.content.destroy();
    this.parent.removeChild(this.chrome);
    this.chrome.destroy();
    this.parent.removeChild(this.resizeIndicator);
    this.resizeIndicator.destroy();
    this.parent.removeChild(this.outline);
    this.outline.destroy();
    if (this.maskGfx) {
      this.parent.container.removeChild(this.maskGfx);
      this.maskGfx.destroy();
    }
    super.destroy();
  }

  /** Push the current DOM body + title-bar + resize-corner rects
   *  into the Pixi content bounds, chrome bounds, indicator bounds,
   *  and mask geometry. The chrome syncs even when the panel is
   *  minimized — a roll-up panel still shows its title bar; only
   *  the body hides. */
  private syncRect(): void {
    if (!this.isOpen) return;

    // Chrome rect = title bar's outer rect. `getBoundingClientRect`
    // returns all-zeros when the element is `display: none` (taskbar-
    // minimized panel), which conveniently collapses the chrome to
    // nothing — paired with `applyVisibility` hiding the container.
    const titleRect = this.titlebar.getBoundingClientRect();
    this.chrome.setBounds(
      titleRect.left, titleRect.top, titleRect.width, titleRect.height,
    );

    // Resize indicator rect = corner div's outer rect. Naturally
    // tracks the corner's current anchor-driven position (tl / tr /
    // bl / br) since we just read the DOM corner's screen rect.
    // Hidden via `applyVisibility` when minimized or when the user
    // toggled resize off (DOM corner's `display: none` makes the
    // rect collapse to zeros anyway, but the explicit visible flag
    // skips a redundant Graphics redraw).
    const cornerRect = this.resizeCorner.getBoundingClientRect();
    this.resizeIndicator.setBounds(
      cornerRect.left, cornerRect.top, cornerRect.width, cornerRect.height,
    );

    // Outline rect = whole-panel rect (title bar + body). Read from
    // the DOM panel element so it tracks anchor / drag / resize the
    // same way every other panel surface does.
    const panelRect = this.panel.getBoundingClientRect();
    this.outline.setBounds(
      panelRect.left, panelRect.top, panelRect.width, panelRect.height,
    );

    // Body rect — skip when minimized in roll-up mode (body is
    // hidden but title still visible) so we don't clobber the
    // saved content bounds with zeros.
    if (this.isMinimized) return;
    const r = this.bodyRect;
    // Inset the Pixi area by the configured padding on each side.
    // The DOM body still occupies the full body rect — consumers can
    // place DOM widgets (tabs, button rows, status strips) inside the
    // reserved strips and the Pixi content sits in what's left.
    const x = r.left + this.padding.left;
    const y = r.top  + this.padding.top;
    const w = Math.max(0, r.width  - this.padding.left - this.padding.right);
    const h = Math.max(0, r.height - this.padding.top  - this.padding.bottom);
    this.content.setBounds(x, y, w, h);
    if (this.maskGfx) {
      this.maskGfx.clear().rect(x, y, w, h).fill(0xffffff);
    }
  }

  /** Flip the panel + body `pointer-events` together. `interactive
   *  = true` (edit mode) lets clicks land on the body so they
   *  bubble to `panel.click` → `openSettings`; `false` (default)
   *  lets clicks fall through to the Pixi canvas beneath so cards
   *  / buttons in the panel content receive them. The panel
   *  itself has to match the body — see the constructor comment
   *  for why body alone isn't enough. */
  private setBodyInteractive(interactive: boolean): void {
    const mode = interactive ? "auto" : "none";
    this.panel.style.pointerEvents = mode;
    this.body.style.pointerEvents = mode;
  }

  /** Toggle Pixi-side visibility based on the panel's open and
   *  minimize state. When the body is hidden (closed OR minimized),
   *  detach the mask too — Pixi culls the subtree on
   *  `visible = false`, so the mask cost goes with it, but clearing
   *  `content.mask` is defensive against a future refactor that
   *  might keep the subtree alive while parked. The chrome (title
   *  bar) tracks `isOpen` alone — a roll-up-minimized panel still
   *  shows its title bar; a closed panel hides it. The resize
   *  indicator tracks body visibility AND the runtime resize toggle:
   *  no grip on a minimized roll-up (no corner to grab) or on a
   *  panel the user set non-resizable. */
  private applyVisibility(): void {
    const bodyVisible   = this.isOpen && !this.isMinimized;
    const chromeVisible = this.isOpen;
    const resizeVisible = bodyVisible && this.isResizable;
    this.content.container.visible         = bodyVisible;
    this.chrome.container.visible          = chromeVisible;
    this.resizeIndicator.container.visible = resizeVisible;
    // Outline tracks the chrome: visible whenever the panel is
    // open (even when roll-up-minimized — title bar still shows).
    this.outline.container.visible         = chromeVisible;
    if (this.maskGfx) {
      this.maskGfx.visible = bodyVisible;
      this.content.container.mask = bodyVisible ? this.maskGfx : null;
    }
    if (chromeVisible) this.syncRect();
  }
}
