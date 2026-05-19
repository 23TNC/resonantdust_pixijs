import { Graphics } from "pixi.js";
import { LayoutNode } from "../layout/LayoutNode";
import {
  RECT_CARD_HEIGHT,
  RECT_CARD_TITLE_HEIGHT,
  RECT_CARD_WIDTH,
} from "../cards/layout/rectangle/RectCard";
import { ToolBar } from "./ToolBar";
import { BlueprintSlot } from "./BlueprintSlot";
import type { Soul } from "../../server/spacetime/bindings/types";

const PANEL_BG = 0x1a1f24;

const PADDING = 8;
const GUTTER = 8;
const COLS = 4;
/** One slot per `blueprints_0` bit. Slot `N` corresponds to blueprint
 *  id `N + 1` — bit position is `id - 1`, matching the 1-indexed
 *  mapping in `content/blueprints/id.json` and the
 *  `SoulPrivate.blueprints_0` packing on the server side. The slot
 *  count expands when `blueprints_1` is added. */
const CARD_COUNT = 64;
const CARD_W = RECT_CARD_WIDTH;
const CARD_H = RECT_CARD_HEIGHT;
const ROW_STEP = CARD_H + GUTTER;

/** Fraction of the body's smaller dimension that the card art
 *  occupies. Matches `RECT_CARD.ART_BODY_FRACTION` so the wrench
 *  panel's art reads at the same scale as cards in-world. */
const ART_BODY_FRACTION = 0.85;

const SCROLLBAR_WIDTH = 8;
/** Width derived from the card grid so `COLS` columns fit exactly:
 *  outer padding on both sides + `COLS` cards + `COLS - 1` gutters +
 *  the scrollbar gutter on the right. Bumping `COLS`, `CARD_W`, or
 *  `PADDING` flows through here. */
const WIDTH =
  PADDING * 2 + COLS * CARD_W + (COLS - 1) * GUTTER + SCROLLBAR_WIDTH;
const SCROLLBAR_TRACK = 0x12161b;
const SCROLLBAR_THUMB = 0x3a4452;
const SCROLLBAR_THUMB_HOVER = 0x5a6472;
/** Minimum thumb height so it stays grabbable when the content vastly
 *  overflows the viewport. */
const MIN_THUMB_HEIGHT = 24;
/** Pixels per wheel notch when the browser reports line-mode deltas. */
const WHEEL_STEP = ROW_STEP;

/** Draggable scrollbar thumb. Leaf LayoutNode — `hitTestLayout` returns
 *  `this` for in-bounds clicks, which `WrenchPanel` uses to enter
 *  scrollbar-drag mode. Mirrors the equivalent class in `ChatPanel`. */
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
    if (this.width <= 0 || this.height <= 0) return;
    this.gfx
      .rect(0, 0, this.width, this.height)
      .fill({ color: this.active ? SCROLLBAR_THUMB_HOVER : SCROLLBAR_THUMB });
  }
}

/**
 * Left-side panel toggled by the toolbar's wrench button. Spans the
 * full body height (below the title bar), sits above the world, below
 * the chat panel and the toolbar. Closed by default — `currentWidth`
 * reports `0` so `GameLayout` collapses its slot to zero, which also
 * suppresses hit-tests (intersects fails when width is 0).
 *
 * Renders a fixed grid of `CARD_COUNT` placeholder cards inside a
 * masked content container. Scrolls top-down via mouse wheel (when the
 * cursor is over the panel body) and via dragging the right-edge
 * scrollbar thumb. Cards are flat `Graphics` rectangles for now — the
 * grid layout and scroll plumbing exist so a follow-up can swap in
 * real card visuals without restructuring the panel.
 */
export class WrenchPanel extends LayoutNode {
  static readonly WIDTH = WIDTH;

  private _isOpen = false;
  private readonly bg = new Graphics();

  // ── Card grid ────────────────────────────────────────────────────
  /** Mask Graphics shared by every slot — drawn each layout pass to
   *  match the body region. Each slot's `container.mask` references
   *  this same Graphics, so partially-scrolled cards get clipped at
   *  the body edges. */
  private readonly contentMask = new Graphics();
  /** One slot per `blueprints_0` bit. Locked slots collapse their
   *  bounds to `0 × 0` (and hide their sprite); unlocked slots get a
   *  per-def texture via `CardTextureManager.getRect(def, "top",
   *  label)`. Slots are `LayoutNode` children of this panel so
   *  `InputManager.hitTestLayout` can route drag-starts on them
   *  through `DragManager`. */
  private readonly slots: BlueprintSlot[] = [];
  /** Card-id of the active soul, mirrored from `ctx.souls`. `null`
   *  pre-character-select. Drives which `SoulPrivate` row we read
   *  for the unlock bits. */
  private currentSoulId: number | null = null;
  /** Cached soul listener — keeps `currentSoulId` in sync and
   *  invalidates layout on soul-swap. */
  private unsubSoul: (() => void) | null = null;
  /** Side-channel `soul_privates` handler — fires on every insert /
   *  update / delete for any soul's private row. We invalidate when
   *  the row for `currentSoulId` changes; other souls' changes are
   *  no-ops here. */
  private unsubSoulPrivate: (() => void) | null = null;
  /** Cleared once we subscribe to `cardTextures.onArtLoad` — that
   *  callback invalidates the panel so any blueprint slot whose
   *  sprite was still in-flight at the previous layout pass can
   *  pick up the texture once it lands. */
  private unsubArtLoad: (() => void) | null = null;

  // ── Scrollbar ────────────────────────────────────────────────────
  private readonly scrollbarTrack = new Graphics();
  private readonly scrollbarThumb: ScrollbarThumb;
  /** Pixels scrolled down from the top of the content. `0` = top of
   *  grid flush with body top; positive values reveal lower rows. */
  private scrollOffset = 0;
  /** Extra scroll headroom past the natural end. The owning layout
   *  pushes the height of any UI that visually covers the bottom of
   *  this panel (today: the chat panel), so the user can scroll the
   *  last row of cards out from under that overlay. `0` disables
   *  overscroll. */
  private overscroll = 0;
  /** Cached metrics from the most-recent render, read by the drag
   *  handler to translate thumb-pixel motion back into a
   *  scrollOffset delta. */
  private cachedMaxScroll = 0;
  private cachedTrackHeight = 0;
  private cachedThumbHeight = 0;

  // ── Input plumbing ───────────────────────────────────────────────
  private canvas: HTMLCanvasElement | null = null;
  private inputWired = false;
  private unsubDragStart: (() => void) | null = null;
  private unsubDragStop: (() => void) | null = null;
  private scrollDragging = false;
  private scrollDragStartY = 0;
  private scrollDragStartOffset = 0;
  private readonly onScrollPointerMove: (e: PointerEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;

  constructor() {
    super();
    this.container.visible = false;
    this.container.addChild(this.bg);

    // Mask Graphics — drawn each layout pass into the panel's local
    // coord space. Slots reference it via `container.mask` so they
    // all share the same clip region.
    this.container.addChild(this.contentMask);
    for (let i = 0; i < CARD_COUNT; i++) {
      const slot = new BlueprintSlot();
      slot.container.mask = this.contentMask;
      this.slots.push(slot);
      // LayoutNode-level addChild puts the slot in the hit-test tree
      // *and* parents its container under ours. Drag-starts on the
      // slot will surface here via `data.hit instanceof BlueprintSlot`.
      this.addChild(slot);
    }

    // Scrollbar — track is non-interactive; thumb is a LayoutNode so
    // it's hit-testable for drag-to-scroll.
    this.container.addChild(this.scrollbarTrack);
    this.scrollbarThumb = new ScrollbarThumb();
    this.addChild(this.scrollbarThumb);

    this.onScrollPointerMove = (e: PointerEvent): void => {
      if (!this.scrollDragging) return;
      if (this.cachedMaxScroll <= 0) return;
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const dyThumb = y - this.scrollDragStartY;
      const travel = Math.max(1, this.cachedTrackHeight - this.cachedThumbHeight);
      // Top-down scroll: dragging the thumb DOWN scrolls toward later
      // rows = increases scrollOffset. Direct (non-inverted) mapping.
      const dyScroll = dyThumb * (this.cachedMaxScroll / travel);
      this.setScrollOffset(this.scrollDragStartOffset + dyScroll);
    };

    this.onWheel = (e: WheelEvent): void => {
      if (!this._isOpen) return;
      if (!this.cursorOverBody(e.clientX, e.clientY)) return;
      e.preventDefault();
      let dy: number;
      if (e.deltaMode === 1) dy = Math.sign(e.deltaY) * WHEEL_STEP;
      else if (e.deltaMode === 2) dy = Math.sign(e.deltaY) * this.height;
      else dy = e.deltaY;
      this.setScrollOffset(this.scrollOffset + dy);
    };
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  /** Width the parent layout should reserve. `0` when closed so the
   *  panel occupies no space and intercepts no clicks. */
  get currentWidth(): number {
    return this._isOpen ? WIDTH : 0;
  }

  toggle(): void {
    this._isOpen = !this._isOpen;
    this.container.visible = this._isOpen;
    this.parent?.invalidate();
    this.invalidate();
  }

  /** Set the overscroll headroom — extra pixels the user can scroll
   *  past the natural end of the grid. Called by `GameLayout` with the
   *  chat panel's current height so the last row can clear the chat.
   *  No-op when the value hasn't changed. */
  setOverscroll(px: number): void {
    const clamped = Math.max(0, Math.floor(px));
    if (clamped === this.overscroll) return;
    this.overscroll = clamped;
    this.invalidate();
  }

  override destroy(): void {
    this.unsubDragStart?.();
    this.unsubDragStop?.();
    this.unsubSoul?.();
    this.unsubSoulPrivate?.();
    this.unsubArtLoad?.();
    document.removeEventListener("pointermove", this.onScrollPointerMove);
    this.canvas?.removeEventListener("wheel", this.onWheel);
    super.destroy();
  }

  /** Lazy-wire input subscriptions on the first layout pass — the
   *  panel is constructed before `GameScene` populates `ctx.input`,
   *  same situation as `ChatPanel`. Idempotent. */
  private maybeWireInput(): void {
    if (this.inputWired) return;
    const ctx = this.ctx;
    if (!ctx.input) return;
    this.canvas = ctx.app.canvas as HTMLCanvasElement;

    this.unsubDragStart = ctx.input.on("left_drag_start", (data) => {
      if (data.hit !== this.scrollbarThumb) return;
      this.scrollDragging = true;
      this.scrollbarThumb.setActive(true);
      this.scrollDragStartY = data.y;
      this.scrollDragStartOffset = this.scrollOffset;
      document.addEventListener("pointermove", this.onScrollPointerMove);
    });
    this.unsubDragStop = ctx.input.on("left_drag_stop", () => {
      if (!this.scrollDragging) return;
      this.scrollDragging = false;
      this.scrollbarThumb.setActive(false);
      document.removeEventListener("pointermove", this.onScrollPointerMove);
    });

    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });

    // Re-layout when a card-art sprite finishes loading so slots
    // that hit the `null` branch in the previous pass pick up the
    // texture without a manual refresh. Same hook `RectCard` /
    // `HexCard` use for the in-world equivalent.
    this.unsubArtLoad = ctx.cardTextures.onArtLoad(() => this.invalidate());

    // Track active soul → drives which `SoulPrivate` row we read.
    // `souls.on` fires immediately with the current value, so a soul
    // already-selected by the time the panel opens is picked up
    // here without a manual seed.
    this.unsubSoul = ctx.souls.on((soul: Soul | null) => {
      const next = soul?.cardId ?? null;
      if (next === this.currentSoulId) return;
      this.currentSoulId = next;
      this.invalidate();
    });

    // Re-render on every `soul_privates` event for the active soul.
    // The row is keyed by `cardId`; events for other souls fall
    // through as no-ops. Side-channel handler — leaves the existing
    // `DataManager` mirror handler intact (multiple handlers fan out
    // through `SubscriptionBase`).
    this.unsubSoulPrivate = ctx.data.subscriptions.registerTableHandlers(
      "soul_privates",
      {
        onInsert: (row) => {
          if (row.cardId === this.currentSoulId) this.invalidate();
        },
        onUpdate: (_oldRow, newRow) => {
          if (newRow.cardId === this.currentSoulId) this.invalidate();
        },
        onDelete: (row) => {
          if (row.cardId === this.currentSoulId) this.invalidate();
        },
      },
    );

    this.inputWired = true;
  }

  private setScrollOffset(value: number): void {
    const clamped = Math.max(0, Math.min(value, this.cachedMaxScroll));
    const snapped = Math.round(clamped);
    if (snapped === this.scrollOffset) return;
    this.scrollOffset = snapped;
    this.invalidate();
  }

  /** True when `(clientX, clientY)` falls inside the panel's body in
   *  viewport coords — gates wheel events so we don't steal scroll
   *  from the rest of the page. */
  private cursorOverBody(clientX: number, clientY: number): boolean {
    if (!this._isOpen || !this.canvas) return false;
    const rect = this.canvas.getBoundingClientRect();
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
    const top = rect.top + gy;
    const bottom = top + this.height;
    return clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
  }

  protected override layout(): void {
    this.maybeWireInput();

    this.bg.clear();
    if (this.width <= 0 || this.height <= 0) return;
    this.bg.rect(0, 0, this.width, this.height).fill({ color: PANEL_BG });

    // Body region = the whole panel minus padding, scrollbar gutter,
    // and the toolbar's footprint at the top. The toolbar draws on
    // top of the wrench panel's top-left corner; reserving its height
    // (plus the panel's own padding) keeps cards from sitting under it.
    // Cards live inside this rect; the mask is the same rect so any
    // row scrolled out of view gets clipped.
    const bodyLeft = PADDING;
    const bodyTop = PADDING + ToolBar.HEIGHT;
    const bodyRight = this.width - SCROLLBAR_WIDTH - PADDING;
    const bodyBottom = this.height - PADDING;
    const bodyW = Math.max(0, bodyRight - bodyLeft);
    const bodyH = Math.max(0, bodyBottom - bodyTop);

    this.contentMask.clear();
    this.contentMask.rect(bodyLeft, bodyTop, bodyW, bodyH).fill(0xffffff);

    // Card placement. Column step shares the available body width
    // evenly across `COLS` columns; the actual card sits flush-left
    // inside its column slot so card size stays at the canonical
    // RECT_CARD_WIDTH × RECT_CARD_HEIGHT, regardless of how the slot
    // math rounds. Rows step by ROW_STEP (card + gutter).
    const colStep = COLS > 0 ? (bodyW + GUTTER) / COLS : 0;

    // Discovered-blueprints rendering: we walk the `blueprints_0`
    // bitfield (slot N ⇄ blueprint id N+1) and pack the discovered
    // entries into a contiguous grid — set bits become consecutive
    // cards in the first row, then the second, etc. Locked
    // blueprints aren't drawn at all (the placeholder is gone), so
    // the panel always reflects exactly what the soul has unlocked.
    //
    // Spare sprites past the discovered count get hidden. We keep
    // the pool at full `CARD_COUNT` so we never have to grow it as
    // the player unlocks more.
    const ctx = this.ctx;
    const profile = this.currentSoulId !== null
      ? ctx.data.soulPrivatesLocal.get(this.currentSoulId)
      : undefined;
    const blueprintsBits = profile?.blueprints0 ?? 0n;

    // First pass: count discovered blueprints so the scrollbar /
    // overscroll math sees the right content height *before* we
    // place anything. A blueprint whose def fails to resolve is
    // dropped here too, mirroring the placement loop's fallback.
    let unlockedCount = 0;
    for (let i = 0; i < this.slots.length; i++) {
      if ((blueprintsBits & (1n << BigInt(i))) === 0n) continue;
      if (ctx.definitions.blueprintById(i + 1) === null) continue;
      unlockedCount++;
    }

    const rows = Math.ceil(unlockedCount / COLS);
    const totalContentH = rows > 0 ? rows * ROW_STEP - GUTTER : 0;
    // Overscroll adds headroom past the natural end so rows hidden
    // behind the chat panel (or any other overlay the parent reports)
    // can be scrolled up into the unobstructed area.
    const maxScroll = Math.max(0, totalContentH - bodyH + this.overscroll);
    // Clamp scrollOffset against the new metrics — body height may
    // have changed since the last pass (window resize, toolbar height
    // shift, blueprints discovered / forgotten), and a stale offset
    // would scroll past the end.
    if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
    this.cachedMaxScroll = maxScroll;

    // Second pass: place the discovered cards in row-major order.
    // Locked / orphan slots collapse their bounds to zero so they
    // drop out of hit-testing (default `intersects` fails) and don't
    // accept a drag — keeps the locked-slot rule consistent with the
    // "removed from view" rendering.
    let displayIndex = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const bit = 1n << BigInt(i);
      if ((blueprintsBits & bit) === 0n) {
        slot.setBlueprint(0, 0);
        slot.setBounds(0, 0, 0, 0);
        slot.container.visible = false;
        slot.artSprite.visible = false;
        continue;
      }
      // Map slot index → blueprint id (+1), resolve the target card
      // def, and bake the titled card. A missing blueprint (e.g.
      // registry typo, id allocated but body removed) drops the
      // slot entirely — silent rather than crashing the UI, and
      // matches the count from the pre-pass above.
      const bp = ctx.definitions.blueprintById(i + 1);
      if (bp === null) {
        slot.setBlueprint(0, 0);
        slot.setBounds(0, 0, 0, 0);
        slot.container.visible = false;
        slot.artSprite.visible = false;
        continue;
      }
      // Draw the *blueprint* card (the discovered-blueprint visual),
      // not the output card — `blueprintPackedDefinition` is the
      // wrench-panel side of the schema; `cardPackedDefinition` is
      // what the eventual "build" reducer will spawn.
      const def = ctx.definitions.decode(bp.blueprintPackedDefinition);
      const label = ctx.definitions.label(bp.blueprintPackedDefinition);
      const col = displayIndex % COLS;
      const row = Math.floor(displayIndex / COLS);
      const x = bodyLeft + col * colStep;
      const y = bodyTop + row * ROW_STEP - this.scrollOffset;
      slot.setBlueprint(bp.id, bp.blueprintPackedDefinition);
      slot.setBounds(x, y, CARD_W, CARD_H);
      slot.sprite.texture = ctx.cardTextures.getRect(def, "top", label);
      // Card-art overlay — same math `RectCard.applyCardArt` uses:
      // anchor-centred over the body region (below the title bar),
      // scaled so the longer texture axis fills `ART_BODY_FRACTION`
      // of the body's smaller dimension. A `null` texture means
      // the sprite hasn't loaded yet; we hide and let the
      // `onArtLoad` hook re-layout once it lands.
      const artName = def?.sprite ?? null;
      const artTex = artName !== null ? ctx.cardTextures.getCardArt(artName) : null;
      if (artTex !== null) {
        slot.artSprite.texture = artTex;
        const bodyHeight = CARD_H - RECT_CARD_TITLE_HEIGHT;
        const target = ART_BODY_FRACTION * Math.min(CARD_W, bodyHeight);
        const scale = target / Math.max(artTex.width, artTex.height);
        slot.artSprite.scale.set(scale);
        slot.artSprite.position.set(CARD_W / 2, RECT_CARD_TITLE_HEIGHT + bodyHeight / 2);
        slot.artSprite.visible = true;
      } else {
        slot.artSprite.visible = false;
      }
      // Cull rows fully outside the body — the mask would hide them
      // anyway, but skipping the draw saves vertex submission.
      slot.container.visible = y + CARD_H >= bodyTop && y <= bodyBottom;
      displayIndex++;
    }

    this.applyScrollbarGeometry(bodyTop, bodyH, maxScroll);
  }

  /** Track + thumb geometry. Track sits flush with the body's right
   *  edge; thumb height scales with the visible-to-effective-total
   *  ratio (`bodyH / (maxScroll + bodyH)`, clamped to `MIN_THUMB_HEIGHT`);
   *  thumb position tracks `scrollOffset` relative to `maxScroll`
   *  (offset=0 → thumb at top — standard top-down scroll, opposite of
   *  the bottom-anchored chat).
   *
   *  `maxScroll` is passed in so the thumb travel matches the
   *  overscrolled bound — without that, the scrollbar would think the
   *  content ends earlier than the user can actually scroll. */
  private applyScrollbarGeometry(
    bodyTop: number,
    bodyH: number,
    maxScroll: number,
  ): void {
    const trackX = this.width - SCROLLBAR_WIDTH - 2;
    const trackTop = bodyTop;
    const trackHeight = Math.max(0, bodyH);

    this.scrollbarTrack.clear();
    if (trackHeight > 0) {
      this.scrollbarTrack
        .rect(trackX, trackTop, SCROLLBAR_WIDTH, trackHeight)
        .fill({ color: SCROLLBAR_TRACK });
    }

    if (maxScroll <= 0) {
      // No overflow — thumb fills the track. Drag becomes a no-op
      // (handler bails on `cachedMaxScroll <= 0`).
      this.scrollbarThumb.setBounds(trackX, trackTop, SCROLLBAR_WIDTH, trackHeight);
      this.cachedTrackHeight = trackHeight;
      this.cachedThumbHeight = trackHeight;
      return;
    }

    // Thumb size reflects visible-vs-total ratio, where "total" is the
    // effective scrollable range (content + overscroll = maxScroll +
    // bodyH). Without the overscroll term the thumb would be oversized
    // and stop short of the track's bottom edge before the user hit
    // their actual maxScroll.
    const effectiveTotal = maxScroll + bodyH;
    const thumbHeight = Math.max(
      MIN_THUMB_HEIGHT,
      Math.floor(trackHeight * (bodyH / Math.max(bodyH, effectiveTotal))),
    );
    const travel = trackHeight - thumbHeight;
    const thumbY = trackTop + (this.scrollOffset / maxScroll) * travel;
    this.scrollbarThumb.setBounds(trackX, Math.round(thumbY), SCROLLBAR_WIDTH, thumbHeight);
    this.cachedTrackHeight = trackHeight;
    this.cachedThumbHeight = thumbHeight;
  }
}
