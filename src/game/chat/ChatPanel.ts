import { Container, Graphics, Text } from "pixi.js";
import { LayoutNode } from "../layout/LayoutNode";
import { TitleBar } from "../titlebar/TitleBar";
import { NOTO_EMOJI_FAMILY } from "../../assets/fonts";
import type { GameContext } from "../../GameContext";
import type { InputManager } from "../input/InputManager";
import type { ChatMessage } from "../../server/spacetime/bindings/types";
import { debug } from "../../debug";
import { ChatSettingsMenu } from "./ChatSettingsMenu";

/** Tab strip height matches the title/tool bars so the three UI bars
 *  share a consistent vertical rhythm. */
const TAB_HEIGHT = TitleBar.HEIGHT;
const INPUT_HEIGHT = 28;
const SCROLLBAR_WIDTH = 8;
const HANDLE_SIZE = 16;
/** Width of the chat-settings (`⚙`) button sitting between the
 *  rightmost tab and the resize handle. Full `TAB_HEIGHT` tall so it
 *  reads as part of the control strip rather than a floating glyph. */
const SETTINGS_WIDTH = 24;
/** Width of the minimize (`−`) button. Slots to the left of the
 *  settings button. */
const MINIMIZE_WIDTH = 24;
const FONT_SIZE = 13;
/** Settings glyph rendered slightly larger than body text — matches
 *  the title-bar gear's visual weight. */
const SETTINGS_FONT_SIZE = 14;
const SETTINGS_FONT_WEIGHT = "400";
const MINIMIZE_FONT_SIZE = 18;
const MINIMIZE_FONT_WEIGHT = "700";

/** Exponential-lerp factor for the minimize/restore tween. Each
 *  layout pass moves `currentHeight` this fraction of the remaining
 *  distance to the target. Matches the shape of `LayoutCard.tweenTo`.
 *  `TWEEN_SNAP_PX` collapses the last sub-pixel step so we always
 *  land exactly on the target (clean, no perpetual dirty flag). */
const TWEEN_LERP = 0.3;
const TWEEN_SNAP_PX = 0.5;
/** Explicit line height for body Text — locks each row to a fixed
 *  vertical step so the resize snap math operates in clean line units.
 *  Without this Pixi would compute line height from font metrics, which
 *  varies per browser and would desync from the snap step. */
const LINE_HEIGHT = 18;
/** Vertical pixels consumed by the tab strip + input row. The body
 *  region between them is `currentHeight - VERTICAL_OVERHEAD`. */
const VERTICAL_OVERHEAD = TAB_HEIGHT + INPUT_HEIGHT;
/** Minimum body-area height in lines. Multiplied by `LINE_HEIGHT` and
 *  added to the overhead to get `MIN_HEIGHT`. */
const MIN_LINES = 3;
/** Minimum width in `LINE_HEIGHT` units. Width snaps to the same step
 *  as height so resize feels symmetric. */
const MIN_WIDTH_UNITS = 12;

/** Default = 18 width-units, close to the old 320 px round value
 *  while snapping cleanly onto the line grid. */
const DEFAULT_WIDTH = 18 * LINE_HEIGHT;
/** Default = overhead + 10 visible body lines. */
const DEFAULT_HEIGHT = VERTICAL_OVERHEAD + 10 * LINE_HEIGHT;
const MIN_WIDTH = MIN_WIDTH_UNITS * LINE_HEIGHT;
const MIN_HEIGHT = VERTICAL_OVERHEAD + MIN_LINES * LINE_HEIGHT;

const PANEL_BG = 0x1a1f24;
/** Inactive tabs sit darker than the panel body so the active tab
 *  visually merges into the body (standard tab metaphor). */
const TAB_INACTIVE_BG = 0x12161b;
const TAB_ACTIVE_BG = PANEL_BG;
const TAB_INACTIVE_LABEL = 0x888888;
const TAB_ACTIVE_LABEL = 0xffffff;
const SCROLLBAR_TRACK = 0x12161b;
const SCROLLBAR_THUMB = 0x3a4452;
const SCROLLBAR_THUMB_HOVER = 0x5a6472;
const HANDLE_GRIP = 0xaab5c4;
/** Minimum thumb height. Without this, the thumb shrinks to almost
 *  invisible when the content vastly exceeds the visible region. */
const MIN_THUMB_HEIGHT = 24;
/** Pixels per wheel "notch." Browsers vary in how `deltaY` is reported
 *  (pixels vs. lines vs. pages); this clamps the per-tick step to a
 *  comfortable amount regardless of source. */
const WHEEL_STEP = LINE_HEIGHT * 3;

type TabId = "general" | "logs";

interface TabSpec {
  id: TabId;
  label: string;
}

const TABS: readonly TabSpec[] = [
  { id: "general", label: "general" },
  { id: "logs",    label: "logs" },
];

/** One clickable tab in the strip at the top of `ChatPanel`. Leaf
 *  LayoutNode — `hitTestLayout` returns `this` for in-bounds clicks,
 *  which `ChatPanel`'s `left_click` listener uses to identify the tab. */
class TabNode extends LayoutNode {
  readonly id: TabId;
  private readonly bg = new Graphics();
  private readonly labelText: Text;
  private isActive = false;

  constructor(spec: TabSpec) {
    super();
    this.id = spec.id;
    this.container.addChild(this.bg);
    this.labelText = new Text({
      text: spec.label,
      style: {
        fill: TAB_INACTIVE_LABEL,
        fontFamily: "sans-serif",
        fontSize: FONT_SIZE,
      },
    });
    this.labelText.anchor.set(0.5, 0.5);
    this.container.addChild(this.labelText);
  }

  setActive(active: boolean): void {
    if (this.isActive === active) return;
    this.isActive = active;
    this.invalidate();
  }

  protected override layout(): void {
    this.bg.clear();
    this.bg
      .rect(0, 0, this.width, this.height)
      .fill({ color: this.isActive ? TAB_ACTIVE_BG : TAB_INACTIVE_BG });
    this.labelText.style.fill = this.isActive ? TAB_ACTIVE_LABEL : TAB_INACTIVE_LABEL;
    this.labelText.position.set(this.width / 2, this.height / 2);
  }
}

/** Draggable scrollbar thumb. Leaf LayoutNode — `hitTestLayout`
 *  returns `this` for in-bounds clicks, used by `ChatPanel` to enter
 *  scrollbar-drag mode. Visual fill darkens (or lightens, depending on
 *  taste) when active. */
class ScrollbarThumb extends LayoutNode {
  private readonly gfx = new Graphics();
  private active = false;

  constructor() {
    super();
    this.container.addChild(this.gfx);
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.invalidate();
  }

  protected override layout(): void {
    this.gfx.clear();
    this.gfx
      .rect(0, 0, this.width, this.height)
      .fill({ color: this.active ? SCROLLBAR_THUMB_HOVER : SCROLLBAR_THUMB });
  }
}

/** Chat-settings affordance — a `⚙` glyph in the tab strip, to the
 *  left of the resize handle. Same shape as `TabNode`: leaf LayoutNode
 *  so `hitTestLayout` returns `this` for in-bounds clicks. No action
 *  wired yet — the settings menu is a follow-up. */
class ChatSettingsButton extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly labelText: Text;

  constructor() {
    super();
    this.container.addChild(this.bg);
    this.labelText = new Text({
      text: "⚙",
      style: {
        fill: 0xffffff,
        fontFamily: NOTO_EMOJI_FAMILY,
        fontSize: SETTINGS_FONT_SIZE,
        fontWeight: SETTINGS_FONT_WEIGHT,
      },
    });
    this.labelText.anchor.set(0.5, 0.5);
    this.container.addChild(this.labelText);
  }

  protected override layout(): void {
    this.bg.clear();
    // Match the inactive-tab fill so the strip reads as a single
    // control band; the active-tab fill (= panel bg) is reserved for
    // the currently-selected feed.
    this.bg.rect(0, 0, this.width, this.height).fill({ color: TAB_INACTIVE_BG });
    this.labelText.position.set(this.width / 2, this.height / 2);
  }
}

/** Minimize affordance — a `−` glyph in the tab strip, slotted to the
 *  left of the settings gear. Same leaf-LayoutNode shape as
 *  `ChatSettingsButton`: `hitTestLayout` returns `this` for in-bounds
 *  clicks, which `ChatPanel`'s `left_click` listener uses to drive the
 *  minimize toggle. Background matches the inactive-tab fill so the
 *  control strip reads as one band. */
class MinimizeButton extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly labelText: Text;

  constructor() {
    super();
    this.container.addChild(this.bg);
    this.labelText = new Text({
      text: "−",
      style: {
        fill: 0xffffff,
        fontFamily: "sans-serif",
        fontSize: MINIMIZE_FONT_SIZE,
        fontWeight: MINIMIZE_FONT_WEIGHT,
      },
    });
    this.labelText.anchor.set(0.5, 0.5);
    this.container.addChild(this.labelText);
  }

  protected override layout(): void {
    this.bg.clear();
    this.bg.rect(0, 0, this.width, this.height).fill({ color: TAB_INACTIVE_BG });
    // Nudge the glyph upward a hair — the minus sign sits below the
    // optical centre of a Text bounding box and looks low-anchored
    // when placed at the geometric midpoint.
    this.labelText.position.set(this.width / 2, this.height / 2 - 1);
  }
}

/** Top-right resize affordance. Filled right-triangle whose apex is
 *  pinned to the panel's top-right corner (the actual grab point);
 *  the hypotenuse slopes inward toward the panel body, reading as a
 *  "drag this corner outward to grow" cue.
 *
 *  Hit-test uses the LayoutNode's bounding box (the full square),
 *  not the triangle outline — so the click target is more generous
 *  than the visible shape, which is forgiving on mis-aims. */
class ResizeHandle extends LayoutNode {
  private readonly gfx = new Graphics();

  constructor() {
    super();
    this.container.addChild(this.gfx);
  }

  protected override layout(): void {
    this.gfx.clear();
    // Vertices: top-left → top-right (apex / grab corner) → bottom-right.
    // Fills the top-right half of the handle bounds.
    this.gfx
      .poly([0, 0, this.width, 0, this.width, this.height])
      .fill({ color: HANDLE_GRIP });
  }
}

/** Bottom-left chat / logs panel. Tabs along the top swap which content
 *  pane is visible; the body is a placeholder until chat + log streams
 *  are wired up. An HTML `<input>` pinned to the panel's bottom edge
 *  handles text entry — Enter (while unfocused) brings focus to it.
 *
 *  Resizable via the top-right corner handle. `preferredWidth` /
 *  `preferredHeight` expose the user-driven size to the parent layout,
 *  which clamps to the available space and calls `setBounds`. */
export class ChatPanel extends LayoutNode {
  static readonly DEFAULT_WIDTH = DEFAULT_WIDTH;
  static readonly DEFAULT_HEIGHT = DEFAULT_HEIGHT;
  static readonly MIN_WIDTH = MIN_WIDTH;
  static readonly MIN_HEIGHT = MIN_HEIGHT;

  private readonly bg = new Graphics();
  private readonly tabs: TabNode[];
  private readonly resizeHandle: ResizeHandle;
  private readonly settingsButton: ChatSettingsButton;
  private readonly minimizeButton: MinimizeButton;
  private readonly scrollbarTrack = new Graphics();
  private readonly scrollbarThumb: ScrollbarThumb;
  private readonly inputEl: HTMLInputElement;
  private readonly canvas: HTMLCanvasElement;
  private activeTab: TabId = "general";

  // ── Scroll state (per tab) ─────────────────────────────────────────
  /** Pixels scrolled up from the bottom of the content. `0` = newest
   *  visible at the bottom edge (auto-scroll position). Positive
   *  values move content down, revealing older messages at the top.
   *  Clamped to `[0, maxScroll]` every render. */
  private generalScrollOffset = 0;
  private logsScrollOffset = 0;
  /** Cached `maxScroll` from the most-recent render of the active tab.
   *  Used by the scrollbar-drag handler to translate pixel motion of
   *  the thumb back into a scrollOffset delta. */
  private activeMaxScroll = 0;
  private activeTrackHeight = 0;
  private activeThumbHeight = 0;

  // Per-tab message-rendering containers. Both live inside the body
  // region and are clipped by `bodyMask`; `setActiveTab` toggles
  // visibility. Each container holds Text children stacked bottom-up
  // (most-recent message at the bottom edge, older messages above).
  private readonly bodyMask = new Graphics();
  private readonly generalContainer = new Container();
  private readonly logsContainer = new Container();
  /** Pooled Text nodes for the chat (general) tab. Re-used across
   *  re-renders so we don't churn Pixi text instances on every insert. */
  private readonly generalTexts: Text[] = [];
  /** Pooled Text nodes for the logs tab — same shape as `generalTexts`. */
  private readonly logsTexts: Text[] = [];

  /** User-driven preferred size. Updated by the resize-handle drag;
   *  read by the parent layout (`GameLayout.layout()`). `currentHeight`
   *  is the *animated* height — it tracks the minimize/restore tween,
   *  so during a transition it sits between `TAB_HEIGHT` and
   *  `restoredHeight`. The parent reads it as `preferredHeight`,
   *  shrinking the panel smoothly each frame. */
  private currentWidth = DEFAULT_WIDTH;
  private currentHeight = DEFAULT_HEIGHT;
  /** Height to restore to when the user un-minimizes. Stays in sync
   *  with `currentHeight` whenever the panel is settled at its
   *  un-minimized size (so resizes are remembered across minimize
   *  cycles); decoupled while the tween is in flight or while
   *  minimized. */
  private restoredHeight = DEFAULT_HEIGHT;
  /** True between a minimize click and the next un-minimize click.
   *  Drives the layout's tween target (`TAB_HEIGHT` vs `restoredHeight`)
   *  and gates resize-drag (the handle's bounds collapse to zero, so
   *  hit-tests miss it). */
  private minimized = false;

  // ── Resize-drag state ────────────────────────────────────────────────
  private resizing = false;
  private startPointerX = 0;
  private startPointerY = 0;
  private startWidth = 0;
  private startHeight = 0;
  private readonly onPointerMove: (e: PointerEvent) => void;

  // ── Scrollbar-drag state ─────────────────────────────────────────
  private scrollDragging = false;
  private scrollDragStartY = 0;
  private scrollDragStartOffset = 0;
  private readonly onScrollPointerMove: (e: PointerEvent) => void;

  // ── Wheel handler ────────────────────────────────────────────────
  private readonly onWheel: (e: WheelEvent) => void;

  // Subscription state. ChatPanel is constructed inside `GameLayout`
  // before `GameScene` creates the `InputManager`, so `ctx.input` is
  // null at construction time. The first `layout()` pass runs after
  // GameScene finishes setup; we wire subscriptions there once
  // `ctx.input` shows up.
  private fontSize = FONT_SIZE;
  private readonly chatSettingsMenu: ChatSettingsMenu;

  private readonly ctxRef: GameContext;
  private subscriptionsWired = false;
  private unsubClick: (() => void) | null = null;
  private unsubKey: (() => void) | null = null;
  private unsubDragStart: (() => void) | null = null;
  private unsubDragStop: (() => void) | null = null;
  private unsubChat: (() => void) | null = null;
  private unsubLogs: (() => void) | null = null;

  constructor(ctx: GameContext) {
    super();
    this.ctxRef = ctx;
    this.canvas = ctx.app.canvas as HTMLCanvasElement;
    this.chatSettingsMenu = new ChatSettingsMenu(this.fontSize);
    this.chatSettingsMenu.onFontSizeChange = (size) => this.applyFontSize(size);
    debug.log(
      ["chat"],
      `[ChatPanel] constructed, ctx.input=${ctx.input ? "set" : "null"} (subscriptions deferred to first layout)`,
    );

    this.container.addChild(this.bg);

    this.tabs = TABS.map((spec) => new TabNode(spec));
    for (const tab of this.tabs) this.addChild(tab);
    this.tabs.find((t) => t.id === this.activeTab)?.setActive(true);

    this.minimizeButton = new MinimizeButton();
    this.addChild(this.minimizeButton);

    this.settingsButton = new ChatSettingsButton();
    this.addChild(this.settingsButton);

    this.resizeHandle = new ResizeHandle();
    // Added after the tabs / settings so its hitTest wins for clicks
    // inside the corner (hitTestLayout walks children deepest / last-first).
    this.addChild(this.resizeHandle);

    // Body-area mask. Applied to both the general and logs containers
    // so text rendered outside the body bounds gets clipped (older
    // messages scrolled off the top of the viewport, etc.). Mask
    // geometry is recomputed in `layout()` since the body region
    // shifts when the panel is resized.
    this.container.addChild(this.bodyMask);

    // Tab content containers — only the active one is visible. Both
    // are masked by `bodyMask`. `setActiveTab` flips `visible`; tab
    // content itself (text rows) is appended into each.
    this.container.addChild(this.generalContainer);
    this.container.addChild(this.logsContainer);
    this.generalContainer.mask = this.bodyMask;
    this.logsContainer.mask = this.bodyMask;
    this.applyTabVisibility();

    // Scrollbar — track is non-interactive Graphics; thumb is a
    // LayoutNode so it's hit-testable for drag-to-scroll.
    this.container.addChild(this.scrollbarTrack);
    this.scrollbarThumb = new ScrollbarThumb();
    this.addChild(this.scrollbarThumb);

    // HTML input overlaid on the canvas via fixed-positioning. The
    // FormOverlay pattern is the precedent here — the canvas-level
    // input gets native focus, caret, IME, etc. for free, which a
    // Pixi-rendered text field would have to recreate.
    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.autocomplete = "off";
    Object.assign(this.inputEl.style, {
      position: "fixed",
      boxSizing: "border-box",
      background: "#0e1318",
      color: "#ffffff",
      border: "1px solid #2a3340",
      outline: "none",
      fontFamily: "sans-serif",
      fontSize: `${FONT_SIZE}px`,
      padding: "4px 8px",
      margin: "0",
      zIndex: "10",
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const body = this.inputEl.value.trim();
        if (body.length > 0) {
          // Fire-and-forget. Server validates body length / control
          // chars; reducer failures don't currently bubble back into
          // the UI (logged via the spacetime debug tag). The
          // optimistic-clear feels right: by the time the message
          // round-trips, the input is ready for the next one.
          debug.log(["chat"], `[ChatPanel] sending message len=${body.length}`);
          const player = this.ctxRef.playerSession.getPlayer();
          if (player) {
            void this.ctxRef.reducers.sendChatMessage({
              senderPlayerId: player.playerId,
              senderName: player.name,
              body,
            });
          }
        }
        this.inputEl.value = "";
        // Keep focus so the user can keep typing without re-pressing Enter
        // to re-focus. Matches the chat-app convention.
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.inputEl.blur();
      }
      e.stopPropagation();
    });
    document.body.appendChild(this.inputEl);

    // ── Drag-to-scroll plumbing ───────────────────────────────────────
    this.onScrollPointerMove = (e: PointerEvent): void => {
      if (!this.scrollDragging) return;
      if (this.activeMaxScroll <= 0) return;
      // Thumb travel range = trackHeight - thumbHeight. The user's
      // pointer dy maps proportionally onto scrollOffset, inverted
      // (dragging the thumb DOWN scrolls towards newer = decreases
      // scrollOffset).
      const rect = this.canvas.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const dyThumb = y - this.scrollDragStartY;
      const travel = Math.max(1, this.activeTrackHeight - this.activeThumbHeight);
      const dyScroll = -dyThumb * (this.activeMaxScroll / travel);
      this.setActiveScrollOffset(this.scrollDragStartOffset + dyScroll);
    };

    // ── Wheel-to-scroll plumbing ──────────────────────────────────────
    this.onWheel = (e: WheelEvent): void => {
      // Gate: only consume wheel events whose cursor is over our body
      // region. Otherwise we'd hijack scrolling for the rest of the
      // page (no real scroll there today, but cheap to be safe).
      if (!this.cursorOverBody(e.clientX, e.clientY)) return;
      e.preventDefault();
      // Browsers may report deltaY in `pixel` / `line` / `page` units
      // (`deltaMode`). For `line` (1) treat one tick as `LINE_HEIGHT`,
      // for `page` (2) treat as a body's worth — otherwise pixel-perfect.
      let dy: number;
      if (e.deltaMode === 1) dy = Math.sign(e.deltaY) * WHEEL_STEP;
      else if (e.deltaMode === 2) dy = Math.sign(e.deltaY) * (this.height - VERTICAL_OVERHEAD);
      else dy = e.deltaY;
      // Positive deltaY = wheel down = scroll towards newer = decrease offset.
      this.setActiveScrollOffset(this.getActiveScrollOffset() - dy);
    };
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });

    // ── Drag-to-resize plumbing ───────────────────────────────────────
    this.onPointerMove = (e: PointerEvent): void => {
      if (!this.resizing) return;
      const rect = this.canvas.getBoundingClientRect();
      // Match InputManager.eventData: pointer coords are canvas-relative
      // CSS pixels, same unit our LayoutNode bounds are in.
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const dx = x - this.startPointerX;
      const dy = y - this.startPointerY;
      // Panel is anchored to the bottom-left of the screen, so:
      //   drag right → wider  (newW = startW + dx)
      //   drag up    → taller (newH = startH - dy, since dy < 0 going up)
      //
      // Snap both axes to `LINE_HEIGHT` units so the resize feels
      // symmetric — width and height tick at the same step. Width
      // is in raw line-units; height is in (line-units of body) + a
      // fixed `VERTICAL_OVERHEAD` for the tab strip + input row.
      const rawWidth = this.startWidth + dx;
      const widthUnits = Math.max(MIN_WIDTH_UNITS, Math.round(rawWidth / LINE_HEIGHT));
      this.currentWidth = widthUnits * LINE_HEIGHT;
      const rawHeight = this.startHeight - dy;
      const rawBodyH = rawHeight - VERTICAL_OVERHEAD;
      const lines = Math.max(MIN_LINES, Math.round(rawBodyH / LINE_HEIGHT));
      const snappedH = VERTICAL_OVERHEAD + lines * LINE_HEIGHT;
      this.currentHeight = snappedH;
      // Keep `restoredHeight` in lockstep so a future minimize/restore
      // round-trip lands back on the size the user just chose.
      this.restoredHeight = snappedH;
      debug.log(
        ["chat"],
        `[ChatPanel] resize move dx=${dx} dy=${dy} widthUnits=${widthUnits} lines=${lines} → ${this.currentWidth}x${this.currentHeight}`,
      );
      // Parent (GameLayout) reads preferredWidth/Height in its own
      // layout — invalidating it propagates the new size down through
      // `setBounds` on us, which clamps against the available area.
      this.parent?.invalidate();
    };

    // Subscriptions are wired lazily in `layout()` once `ctx.input` is
    // populated — see the field doc comment above.
  }

  /** One-shot wiring of all `InputManager` subscriptions. Called from
   *  `layout()` the first time `ctx.input` is non-null. */
  private subscribeInput(input: InputManager): void {
    debug.log(["chat"], "[ChatPanel] wiring input subscriptions");

    // Tab switching via clicks on a TabNode (leaf — `hitTestLayout`
    // returns the tab for in-bounds clicks).
    this.unsubClick = input.on("left_click", (data) => {
      const hit = data.up.hit;
      debug.log(
        ["chat"],
        `[ChatPanel] left_click hit=${hit?.constructor.name ?? "null"}`,
      );
      if (!hit) return;
      if (hit === this.minimizeButton) {
        this.toggleMinimized();
        return;
      }
      if (hit === this.settingsButton) {
        // Compute viewport coords for the settings button so the menu
        // anchors its bottom-right corner to the button's position.
        let gx = this.x;
        let gy = this.y;
        let node: LayoutNode | null = this.parent;
        while (node) { gx += node.x; gy += node.y; node = node.parent; }
        const rect = this.canvas.getBoundingClientRect();
        const btnRight = rect.left + gx + this.settingsButton.x + this.settingsButton.width;
        const panelTop = rect.top + gy;
        this.chatSettingsMenu.toggle(
          window.innerWidth  - btnRight,
          window.innerHeight - panelTop,
        );
        return;
      }
      for (const tab of this.tabs) {
        if (hit === tab) {
          debug.log(["chat"], `[ChatPanel] click matched tab=${tab.id}`);
          this.setActiveTab(tab.id);
          return;
        }
      }
    });

    // Enter (when the input isn't already focused) brings focus to it.
    this.unsubKey = input.onKey("key_down", (data) => {
      if (data.key !== "Enter") return;
      const alreadyFocused = document.activeElement === this.inputEl;
      debug.log(
        ["chat"],
        `[ChatPanel] key_down Enter alreadyFocused=${alreadyFocused}`,
      );
      if (alreadyFocused) return;
      this.inputEl.focus();
    });

    // Drag-start routing: the same `left_drag_start` event drives both
    // resize (corner handle) and scrollbar drag (thumb). Discriminate
    // by `data.hit`.
    this.unsubDragStart = input.on("left_drag_start", (data) => {
      debug.log(
        ["chat"],
        `[ChatPanel] drag_start hit=${data.hit?.constructor.name ?? "null"} match_handle=${data.hit === this.resizeHandle} match_thumb=${data.hit === this.scrollbarThumb}`,
      );
      if (data.hit === this.resizeHandle) {
        this.resizing = true;
        this.startPointerX = data.x;
        this.startPointerY = data.y;
        this.startWidth = this.currentWidth;
        this.startHeight = this.currentHeight;
        document.addEventListener("pointermove", this.onPointerMove);
      } else if (data.hit === this.scrollbarThumb) {
        this.scrollDragging = true;
        this.scrollbarThumb.setActive(true);
        this.scrollDragStartY = data.y;
        this.scrollDragStartOffset = this.getActiveScrollOffset();
        document.addEventListener("pointermove", this.onScrollPointerMove);
      }
    });
    this.unsubDragStop = input.on("left_drag_stop", () => {
      if (this.resizing) {
        debug.log(
          ["chat"],
          `[ChatPanel] resize stop final=${this.currentWidth}x${this.currentHeight}`,
        );
        this.resizing = false;
        document.removeEventListener("pointermove", this.onPointerMove);
      }
      if (this.scrollDragging) {
        debug.log(
          ["chat"],
          `[ChatPanel] scroll drag stop offset=${this.getActiveScrollOffset().toFixed(1)}`,
        );
        this.scrollDragging = false;
        this.scrollbarThumb.setActive(false);
        document.removeEventListener("pointermove", this.onScrollPointerMove);
      }
    });

    // Server subscription — chat feed, scoped to "since the player's
    // previous login" when that was recent enough to fit inside the
    // server's retention window, otherwise "since now" (no scrollback).
    // After installing the subscription we bump `last_login_secs` so
    // *next* login's threshold reflects this session.
    //
    // `sent_at` on a chat row is the packed `(time_ms << 16) | seq` u64,
    // so the threshold has to be packed the same way for the comparison
    // to slice on whole-second boundaries.
    const player = this.ctxRef.playerSession.getPlayer();
    const lastLoginSecs = player?.lastLoginSecs ?? 0;
    const nowSecs = Math.floor(this.ctxRef.reducers.serverNowMs() / 1_000);
    // Mirror the server's `RETENTION_MS` in chat.rs (1 h). If our
    // previous login was inside the retention window the server still
    // has those rows — pick `last_login_secs` so we catch up on what
    // we missed. Otherwise the rows are gone anyway and asking for
    // "since now" gives a tiny payload.
    const RETENTION_SECS = 60 * 60;
    const thresholdSecs =
      lastLoginSecs > nowSecs - RETENTION_SECS ? lastLoginSecs : nowSecs;
    // Pack secs → ms → `<< 16` to land in the `sent_at` coord space.
    // BigInt math because the result exceeds 2^53.
    const thresholdPacked = (BigInt(thresholdSecs) * 1_000n) << 16n;
    debug.log(
      ["chat"],
      `[ChatPanel] subscribing to chat: lastLogin=${lastLoginSecs}s now=${nowSecs}s → threshold=${thresholdSecs}s (packed=${thresholdPacked})`,
    );
    void this.ctxRef.data.chatSubscriptions.subscribeChat(thresholdPacked);
    // Bump server-side last_login_secs to `now` so next session's
    // threshold reflects this one. Best-effort; a failure here just
    // means the next login replays today's scrollback window.
    void this.ctxRef.reducers.setLastLogin();

    // Re-render on every chat-row event. Cheap: AppendTable fires on
    // insert / delete only (no per-frame), and we use a small pool of
    // Text nodes so even 100+ messages don't churn allocations.
    this.unsubChat = this.ctxRef.data.chatMessages.subscribe(() => {
      this.renderGeneralMessages();
      this.invalidate();
    });
    // Seed initial render in case rows already exist (e.g. subscription
    // applied while we were wiring up).
    this.renderGeneralMessages();

    // Logs tab — purely client-side. LogManager is scene-scoped on
    // ctx.logs (set by GameScene.onEnter); subscribe to its push
    // events and render the buffer when `logs` is the active tab.
    if (this.ctxRef.logs) {
      this.unsubLogs = this.ctxRef.logs.subscribe(() => {
        this.renderLogs();
        this.invalidate();
      });
      this.renderLogs();
    } else {
      debug.log(["chat"], "[ChatPanel] ctx.logs is null at wire time; logs tab will stay empty");
    }
  }

  /** User-driven preferred size. The parent layout clamps this against
   *  the available area before calling `setBounds`. */
  get preferredWidth(): number {
    return this.currentWidth;
  }
  get preferredHeight(): number {
    return this.currentHeight;
  }

  /** Flip the minimize flag. `restoredHeight` is already in sync with
   *  `currentHeight` while un-minimized (the resize handler keeps them
   *  paired), so we don't need to capture it here — the tween in
   *  `layout()` will pick the right target on the next pass. */
  private toggleMinimized(): void {
    this.minimized = !this.minimized;
    debug.log(
      ["chat"],
      `[ChatPanel] minimize → ${this.minimized} (restoredHeight=${this.restoredHeight})`,
    );
    this.parent?.invalidate();
    this.invalidate();
  }

  private setActiveTab(id: TabId): void {
    if (this.activeTab === id) return;
    this.activeTab = id;
    for (const tab of this.tabs) tab.setActive(tab.id === id);
    this.applyTabVisibility();
    this.invalidate();
  }

  private applyTabVisibility(): void {
    this.generalContainer.visible = this.activeTab === "general";
    this.logsContainer.visible = this.activeTab === "logs";
  }

  /** Read the scroll offset for whichever tab is active. */
  private getActiveScrollOffset(): number {
    return this.activeTab === "general" ? this.generalScrollOffset : this.logsScrollOffset;
  }

  /** Write the active tab's scroll offset and trigger a re-render.
   *  Snaps to multiples of `LINE_HEIGHT` so rows always render on the
   *  same y-grid (no half-line offsets between scroll positions).
   *  Clamping against `maxScroll` happens in the render method. */
  private setActiveScrollOffset(value: number): void {
    const snapped = Math.round(value / LINE_HEIGHT) * LINE_HEIGHT;
    if (this.activeTab === "general") this.generalScrollOffset = snapped;
    else this.logsScrollOffset = snapped;
    this.invalidate();
  }

  /** True when `(clientX, clientY)` is inside the panel's body region
   *  in viewport coords. Used to gate wheel events so we don't hijack
   *  scrolling outside our area. Translates through the canvas's
   *  bounding rect since pointer events are in viewport units. */
  private cursorOverBody(clientX: number, clientY: number): boolean {
    if (!this.subscriptionsWired) return false;
    const rect = this.canvas.getBoundingClientRect();
    // Stage coords are CSS pixels (autoDensity is on in `app.init`),
    // so `gx`/`gy` and the input event's `clientX`/`clientY` are in
    // the same unit once we translate by the canvas's CSS-space
    // bounding rect — no DPR scaling.
    let gx = this.x;
    let gy = this.y;
    let node: LayoutNode | null = this.parent;
    while (node) {
      gx += node.x;
      gy += node.y;
      node = node.parent;
    }
    const left = rect.left + gx;
    const right = left + this.width;
    const bodyTopY = rect.top + gy + TAB_HEIGHT;
    const bodyBottomY = rect.top + gy + this.height - INPUT_HEIGHT;
    return (
      clientX >= left &&
      clientX <= right &&
      clientY >= bodyTopY &&
      clientY <= bodyBottomY
    );
  }

  /** Render every chat message into the general-tab container. Pool-based
   *  to avoid Text-instance churn — we grow `generalTexts` as needed,
   *  reuse existing slots in place, and hide leftover slots when the
   *  message list shrinks.
   *
   *  Layout: most recent message anchored at the bottom of the body
   *  region, older messages stacked above. Out-of-bounds rows (older
   *  than fits) are clipped by `bodyMask`. The container's local
   *  origin is the body top-left; messages place themselves with
   *  `y` measured from that origin. Auto-scroll = "always bottom" by
   *  construction. */
  private renderGeneralMessages(): void {
    const rows = this.ctxRef.data.chatMessages.sorted();
    const wrapWidth = Math.max(
      0,
      this.width - 8 /* left pad */ - SCROLLBAR_WIDTH - 6 /* right pad incl. scrollbar */,
    );
    const bodyTop = TAB_HEIGHT;
    const bodyBottom = this.height - INPUT_HEIGHT;

    // Ensure pool has at least one Text per message. Reuse existing
    // slots; allocate as needed.
    while (this.generalTexts.length < rows.length) {
      const t = new Text({
        text: "",
        style: {
          fill: 0xdddddd,
          fontFamily: "sans-serif",
          fontSize: this.fontSize,
          lineHeight: this.fontSize + 5,
          wordWrap: true,
          // `wordWrap` alone only breaks on whitespace; a single long
          // run of non-whitespace chars (URL, "aaaaaa...", etc.) would
          // overflow horizontally. `breakWords` lets the wrapper split
          // inside such runs at the character boundary.
          breakWords: true,
          wordWrapWidth: wrapWidth,
        },
      });
      t.anchor.set(0, 0);
      this.generalContainer.addChild(t);
      this.generalTexts.push(t);
    }

    // Update visible Text rows. Keep all wrap widths in sync — the
    // panel resizes, so old rows might have been wrapped at a stale
    // width; refresh them here.
    for (let i = 0; i < rows.length; i++) {
      const text = this.generalTexts[i];
      const row = rows[i];
      text.text = this.formatMessage(row);
      text.style.wordWrapWidth = wrapWidth;
      text.visible = true;
    }
    // Hide leftover pool slots when the message list shrank (e.g.
    // retention sweep deleted rows).
    for (let i = rows.length; i < this.generalTexts.length; i++) {
      this.generalTexts[i].visible = false;
    }

    // Compute total content height (sum of all visible texts).
    let totalHeight = 0;
    for (let i = 0; i < rows.length; i++) totalHeight += this.generalTexts[i].height;

    // Clamp scrollOffset against the new content height. If the user
    // shrank the panel or messages disappeared, offset might now
    // exceed maxScroll — pull it back. Auto-scroll-to-bottom on insert
    // is implicit: offset stays at `0` and the bottom message stays
    // anchored at `bodyBottom`.
    const bodyH = Math.max(0, bodyBottom - bodyTop);
    const maxScroll = Math.max(0, totalHeight - bodyH);
    // Clamp then snap. `maxScroll` is itself a multiple of `LINE_HEIGHT`
    // (totalHeight and bodyH both are, assuming the resize snap holds);
    // the floor-snap here defends against the parent-clamp edge case
    // where bodyH might not be line-aligned, and against any externally
    // set offset that wasn't a multiple.
    const clamped = Math.max(0, Math.min(this.generalScrollOffset, maxScroll));
    this.generalScrollOffset = Math.floor(clamped / LINE_HEIGHT) * LINE_HEIGHT;
    const offset = this.generalScrollOffset;

    // Stack from the bottom up. `accY` starts at `bodyBottom + offset`
    // — scrolling up pushes the bottom anchor below the body, revealing
    // older messages at the top.
    let accY = bodyBottom + offset;
    for (let i = rows.length - 1; i >= 0; i--) {
      const text = this.generalTexts[i];
      accY -= text.height;
      text.position.set(8, accY);
      // Cull rows entirely outside the body region — the mask would
      // clip them anyway, but hiding them saves vertex submission.
      if (accY + text.height < bodyTop || accY > bodyBottom) {
        text.visible = false;
      }
    }

    if (this.activeTab === "general") this.applyScrollbarGeometry(totalHeight, bodyH);
  }

  /** Format a chat row as `name: body`. `sender_name` is denormalised
   *  onto the row by `send_chat_message` at send time, so no
   *  cross-table lookup is needed — old messages stay attributed to
   *  the name the sender was using when they sent. See the table doc
   *  on `chat::ChatMessage` for the rename-history policy. */
  private formatMessage(row: ChatMessage): string {
    return `${row.senderName}: ${row.body}`;
  }

  /** Render every log entry into the logs-tab container. Same shape
   *  as `renderGeneralMessages` but reads from `ctx.logs` instead of
   *  `data.chatMessages`. Pooled, bottom-stacked, mask-clipped. */
  private renderLogs(): void {
    const log = this.ctxRef.logs;
    if (!log) return;
    const entries = log.getAll();
    const wrapWidth = Math.max(
      0,
      this.width - 8 - SCROLLBAR_WIDTH - 6,
    );
    const bodyTop = TAB_HEIGHT;
    const bodyBottom = this.height - INPUT_HEIGHT;

    while (this.logsTexts.length < entries.length) {
      const t = new Text({
        text: "",
        style: {
          fill: 0xaaaaaa,
          fontFamily: "sans-serif",
          fontSize: this.fontSize,
          fontStyle: "italic",
          lineHeight: this.fontSize + 5,
          wordWrap: true,
          breakWords: true,
          wordWrapWidth: wrapWidth,
        },
      });
      t.anchor.set(0, 0);
      this.logsContainer.addChild(t);
      this.logsTexts.push(t);
    }

    for (let i = 0; i < entries.length; i++) {
      const text = this.logsTexts[i];
      text.text = entries[i].text;
      text.style.wordWrapWidth = wrapWidth;
      text.visible = true;
    }
    for (let i = entries.length; i < this.logsTexts.length; i++) {
      this.logsTexts[i].visible = false;
    }

    let totalHeight = 0;
    for (let i = 0; i < entries.length; i++) totalHeight += this.logsTexts[i].height;

    const bodyH = Math.max(0, bodyBottom - bodyTop);
    const maxScroll = Math.max(0, totalHeight - bodyH);
    const clamped = Math.max(0, Math.min(this.logsScrollOffset, maxScroll));
    this.logsScrollOffset = Math.floor(clamped / LINE_HEIGHT) * LINE_HEIGHT;
    const offset = this.logsScrollOffset;

    let accY = bodyBottom + offset;
    for (let i = entries.length - 1; i >= 0; i--) {
      const text = this.logsTexts[i];
      accY -= text.height;
      text.position.set(8, accY);
      if (accY + text.height < bodyTop || accY > bodyBottom) {
        text.visible = false;
      }
    }

    if (this.activeTab === "logs") this.applyScrollbarGeometry(totalHeight, bodyH);
  }

  /** Size and position the scrollbar thumb from the active tab's
   *  content metrics. Thumb height scales with `bodyH / totalH`
   *  (clamped to `MIN_THUMB_HEIGHT`); thumb position tracks the
   *  current scrollOffset relative to maxScroll, inverted (offset=0 →
   *  thumb at bottom).
   *
   *  Caches `activeMaxScroll` / `activeTrackHeight` / `activeThumbHeight`
   *  so the drag handler can convert thumb-pixel motion back into a
   *  scrollOffset delta without re-deriving these. */
  private applyScrollbarGeometry(totalHeight: number, bodyH: number): void {
    const bodyTop = TAB_HEIGHT;
    const trackTop = bodyTop + 2;
    const trackHeight = Math.max(0, bodyH - 4);
    const trackX = this.width - SCROLLBAR_WIDTH - 2;
    const maxScroll = Math.max(0, totalHeight - bodyH);

    if (maxScroll <= 0) {
      // No overflow — thumb fills the track. Drag is a no-op (the
      // drag handler bails on `activeMaxScroll <= 0`).
      this.scrollbarThumb.setBounds(trackX, trackTop, SCROLLBAR_WIDTH, trackHeight);
      this.activeMaxScroll = 0;
      this.activeTrackHeight = trackHeight;
      this.activeThumbHeight = trackHeight;
      return;
    }

    const thumbHeight = Math.max(
      MIN_THUMB_HEIGHT,
      Math.floor(trackHeight * (bodyH / totalHeight)),
    );
    const travel = trackHeight - thumbHeight;
    const offset = this.getActiveScrollOffset();
    // offset=0 → thumb at bottom; offset=maxScroll → thumb at top.
    const thumbY = trackTop + (1 - offset / maxScroll) * travel;
    this.scrollbarThumb.setBounds(trackX, Math.round(thumbY), SCROLLBAR_WIDTH, thumbHeight);
    this.activeMaxScroll = maxScroll;
    this.activeTrackHeight = trackHeight;
    this.activeThumbHeight = thumbHeight;
  }

  protected override layout(): boolean | void {
    // Lazy-wire input subscriptions once GameScene has populated
    // `ctx.input`. See the field doc comment above for why.
    if (!this.subscriptionsWired && this.ctxRef.input) {
      this.subscribeInput(this.ctxRef.input);
      this.subscriptionsWired = true;
    }

    // Step the minimize / restore tween. `currentHeight` is the
    // animated value the parent reads via `preferredHeight`; each
    // pass it eases toward `target` by `TWEEN_LERP`. When the gap
    // closes below `TWEEN_SNAP_PX` we snap and let the dirty flag
    // clear; otherwise we invalidate the parent so it re-reads
    // `preferredHeight` next frame and returns `true` so our own
    // layout runs again. Same shape as `LayoutCard.tweenTo`.
    const target = this.minimized ? TAB_HEIGHT : this.restoredHeight;
    let stillTweening = false;
    if (this.currentHeight !== target) {
      const dh = target - this.currentHeight;
      if (Math.abs(dh) < TWEEN_SNAP_PX) {
        this.currentHeight = target;
      } else {
        this.currentHeight += dh * TWEEN_LERP;
        stillTweening = true;
      }
      this.parent?.invalidate();
    }
    // `hideContent` covers both the at-rest minimized state and the
    // in-flight tween in either direction — the HTML input would
    // overlap the tab strip if shown while the panel is shorter than
    // its un-minimized size, and we don't want resize-drag to grab
    // the handle while the layout is sliding around.
    const hideContent = this.minimized || this.currentHeight !== this.restoredHeight;

    this.bg.clear();
    this.bg.rect(0, 0, this.width, this.height).fill({ color: PANEL_BG });

    // Tab strip layout: tabs fill the remaining width after reserving
    // space for the minimize / settings buttons (full TAB_HEIGHT tall,
    // left of the resize handle) and the resize handle itself (square,
    // top-right corner). Tabs share the leftover width evenly.
    const tabsAvailableW = Math.max(
      0,
      this.width - HANDLE_SIZE - SETTINGS_WIDTH - MINIMIZE_WIDTH,
    );
    const tabW = this.tabs.length > 0 ? Math.floor(tabsAvailableW / this.tabs.length) : 0;
    let tx = 0;
    for (let i = 0; i < this.tabs.length; i++) {
      const w = i === this.tabs.length - 1 ? tabsAvailableW - tx : tabW;
      this.tabs[i].setBounds(tx, 0, w, TAB_HEIGHT);
      tx += w;
    }

    this.minimizeButton.setBounds(
      this.width - HANDLE_SIZE - SETTINGS_WIDTH - MINIMIZE_WIDTH,
      0,
      MINIMIZE_WIDTH,
      TAB_HEIGHT,
    );
    this.settingsButton.setBounds(
      this.width - HANDLE_SIZE - SETTINGS_WIDTH,
      0,
      SETTINGS_WIDTH,
      TAB_HEIGHT,
    );
    // Collapse the resize handle's bounds to zero while minimized or
    // mid-tween — the hit-test in `LayoutNode.intersects` then misses
    // it, so `left_drag_start` can't grab it. Cleaner than guarding
    // every resize-path branch separately.
    if (hideContent) {
      this.resizeHandle.setBounds(this.width - HANDLE_SIZE, 0, 0, 0);
    } else {
      this.resizeHandle.setBounds(this.width - HANDLE_SIZE, 0, HANDLE_SIZE, HANDLE_SIZE);
    }
    debug.log(
      ["chat"],
      `[ChatPanel] layout panel=${this.width}x${this.height} handle=(${this.resizeHandle.x},${this.resizeHandle.y},${this.resizeHandle.width},${this.resizeHandle.height})`,
    );

    // Body region: between the tab strip and the input row, with the
    // scrollbar reserved on the right.
    const bodyTop = TAB_HEIGHT;
    const bodyBottom = this.height - INPUT_HEIGHT;
    const bodyHeight = Math.max(0, bodyBottom - bodyTop);
    const bodyWidth = Math.max(0, this.width - SCROLLBAR_WIDTH - 4);

    // Mask clips both tab-content containers to the body region. Drawn
    // every layout pass so resizes update it. Mask coords are in the
    // panel's local frame (since the mask is a child of `this.container`).
    this.bodyMask.clear();
    this.bodyMask.rect(0, bodyTop, bodyWidth, bodyHeight).fill(0xffffff);

    // Refresh chat / logs rendering whenever the panel re-laid out
    // — wrap width depends on `this.width`, and the vertical stack
    // depends on body height. Both run regardless of which tab is
    // active so a tab-switch shows the most recent contents without
    // needing a fresh push first.
    if (this.subscriptionsWired) {
      this.renderGeneralMessages();
      this.renderLogs();
    }

    // Scrollbar track — flush with the body's right edge. Thumb is a
    // LayoutNode child of the panel; its bounds + visual are set by
    // `applyScrollbarGeometry`, called from each tab's render fn so
    // the thumb size tracks the active tab's content height.
    const trackX = this.width - SCROLLBAR_WIDTH - 2;
    this.scrollbarTrack.clear();
    this.scrollbarTrack
      .rect(trackX, bodyTop + 2, SCROLLBAR_WIDTH, bodyHeight - 4)
      .fill({ color: SCROLLBAR_TRACK });

    this.repositionInput(bodyBottom, hideContent);

    // Returning `true` keeps `selfDirty` set so the next frame runs
    // `layout()` again — the in-flight tween advances another step.
    // When `stillTweening` is false the dirty flag clears and we
    // park until the next user-driven invalidation.
    return stillTweening;
  }

  /** Project the panel's bottom-edge bounds into viewport CSS-pixel
   *  coords and apply them to the `<input>` element. Walks the
   *  LayoutNode parent chain to accumulate global stage x/y.
   *
   *  Stage coords *are* CSS pixels when `autoDensity` is on (set in
   *  [main.ts](src/main.ts) `app.init`), so the only translation we
   *  need is the canvas's `getBoundingClientRect()` offset — no
   *  DPR scaling. Previous versions of this method multiplied by
   *  `rect.width / canvas.width`, which silently equalled 1 in the
   *  `resolution: 1` era but becomes `1 / DPR` once autoDensity is on
   *  and visibly misaligns the input. */
  private repositionInput(bodyBottom: number, hidden: boolean): void {
    // Hide the input outright while minimized or mid-tween — it would
    // otherwise slide across the tab strip as the panel shrinks, and
    // capture focus from clicks meant for the un-minimize button.
    if (hidden) {
      this.inputEl.style.display = "none";
      return;
    }
    this.inputEl.style.display = "";
    let gx = this.x;
    let gy = this.y;
    let node: LayoutNode | null = this.parent;
    while (node) {
      gx += node.x;
      gy += node.y;
      node = node.parent;
    }
    const rect = this.canvas.getBoundingClientRect();
    this.inputEl.style.left = `${rect.left + gx}px`;
    this.inputEl.style.top = `${rect.top + gy + bodyBottom}px`;
    this.inputEl.style.width = `${this.width}px`;
    this.inputEl.style.height = `${INPUT_HEIGHT}px`;
  }

  private applyFontSize(size: number): void {
    this.fontSize = size;
    const lineH = size + 5;
    for (const t of this.generalTexts) {
      t.style.fontSize = size;
      t.style.lineHeight = lineH;
    }
    for (const t of this.logsTexts) {
      t.style.fontSize = size;
      t.style.lineHeight = lineH;
    }
    if (this.subscriptionsWired) {
      this.renderGeneralMessages();
      this.renderLogs();
    }
    this.invalidate();
  }

  override destroy(): void {
    this.chatSettingsMenu.destroy();
    this.unsubClick?.();
    this.unsubKey?.();
    this.unsubDragStart?.();
    this.unsubDragStop?.();
    this.unsubChat?.();
    this.unsubLogs?.();
    // Tear down the server-side subscription too. Safe regardless of
    // whether we ever subscribed — `removeSubscription` no-ops on an
    // unknown name.
    this.ctxRef.data.chatSubscriptions.unsubscribeChat();
    document.removeEventListener("pointermove", this.onPointerMove);
    document.removeEventListener("pointermove", this.onScrollPointerMove);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.inputEl.remove();
    super.destroy();
  }
}
