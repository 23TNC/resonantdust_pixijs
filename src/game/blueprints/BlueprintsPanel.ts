import { Graphics } from "pixi.js";
import { LayoutNode } from "../layout/LayoutNode";
import { RECT_CARD_HEIGHT, RECT_CARD_WIDTH } from "../cards/layout/rectangle/RectCard";
import { BlueprintSlot, type BlueprintScope } from "./BlueprintSlot";
import type { Blueprint } from "../definitions/DefinitionManager";
import { getTextureRegistry } from "../definitions/TextureRegistry";
import { localPlayerFactionFolder } from "../../server/player/playerFlags";
import type { Player, Soul } from "../../server/spacetime/bindings/types";

const PANEL_BG = 0x1a1f24;

const PADDING = 8;
const GUTTER = 8;
/** One slot per `blueprints_0` bit. Slot `N` corresponds to blueprint
 *  id `N + 1` — bit position is `id - 1`, matching the 1-indexed
 *  mapping in `content/blueprints/id.json` and the
 *  `SoulPrivate.blueprints_0` packing on the server side. The slot
 *  count expands when `blueprints_1` is added. */
const CARD_COUNT = 64;
const CARD_W = RECT_CARD_WIDTH;
const CARD_H = RECT_CARD_HEIGHT;
const ROW_STEP = CARD_H + GUTTER;

const SCROLLBAR_WIDTH = 8;
/** Reasonable default outer width used by `MainLayout` for the host
 *  PixiPanel's `defaultRect`. Sized for 4 columns at canonical card
 *  width; the actual rendered column count is computed from `this.width`
 *  on every layout pass, so resizing the panel re-flows the grid. */
export const BLUEPRINTS_DEFAULT_WIDTH =
  PADDING * 2 + 4 * CARD_W + 3 * GUTTER + SCROLLBAR_WIDTH;
const SCROLLBAR_TRACK = 0x12161b;
const SCROLLBAR_THUMB = 0x3a4452;
const SCROLLBAR_THUMB_HOVER = 0x5a6472;
/** Minimum thumb height so it stays grabbable when the content vastly
 *  overflows the viewport. */
const MIN_THUMB_HEIGHT = 24;
/** Pixels per wheel notch when the browser reports line-mode deltas. */
const WHEEL_STEP = ROW_STEP;

/** Draggable scrollbar thumb. Leaf LayoutNode — `hitTestLayout` returns
 *  `this` for in-bounds clicks, which `BlueprintsPanel` uses to enter
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
 * Blueprint grid — scope-aware. Renders a scrollable grid of
 * `BlueprintSlot`s, one per discovery bit in either:
 *
 * - **Soul scope** (`scope: "soul"`): bits in
 *   `SoulPrivate.blueprints_0`, drives `request_blueprint` reducer
 *   calls in `DragManager` on drop.
 * - **Player scope** (`scope: "player"`): bits in
 *   `PlayerProfile.blueprints_0`, drives `request_player_blueprint`
 *   on drop.
 *
 * Each unlocked slot is a hit target — dragging from a slot fires a
 * craft action via `DragManager`. The slot itself carries its scope
 * tag so the drag handler can dispatch without walking back to the
 * panel.
 *
 * Sizing: the panel adapts to `this.width × this.height`, set by the
 * wrapping `PixiPanel` (in `MainLayout` it lives inside
 * `blueprintsHostPanel.content`). Column count is recomputed from
 * `this.width` on every layout pass; scrolling kicks in when content
 * exceeds `this.height`. Overflow clipping comes from the wrapping
 * PixiPanel's content mask — no internal cover quads required.
 */
export class BlueprintsPanel extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly scope: BlueprintScope;

  // ── Card grid ────────────────────────────────────────────────────
  /** One slot per `blueprints_0` bit. Locked slots collapse their
   *  bounds to `0 × 0` (and hide their sprite); unlocked slots get a
   *  per-def texture via `CardTextureManager.getRect(def, "top",
   *  label)`. Slots are `LayoutNode` children of this panel so
   *  `InputManager.hitTestLayout` can route drag-starts on them
   *  through `DragManager`. */
  private readonly slots: BlueprintSlot[] = [];
  /** Card-id of the active soul (soul scope) — drives which
   *  `SoulPrivate` row we read for the unlock bits. `null`
   *  pre-character-select and unused in player scope. */
  private currentSoulId: number | null = null;
  /** Player-id of the local player (player scope) — drives which
   *  `PlayerProfile` row we read for the unlock bits. `null`
   *  pre-login and unused in soul scope. */
  private currentPlayerId: number | null = null;
  /** Cached soul listener — keeps `currentSoulId` in sync and
   *  invalidates layout on soul-swap. Only attached in soul scope. */
  private unsubSoul: (() => void) | null = null;
  /** Cached player-session listener — keeps `currentPlayerId` in
   *  sync. Only attached in player scope. */
  private unsubPlayer: (() => void) | null = null;
  /** Side-channel `soul_privates` / `player_profiles` handler —
   *  fires on every insert / update / delete for the scoped table.
   *  Invalidates when the row for our owner changes; other owners'
   *  changes are no-ops here. */
  private unsubBitfieldTable: (() => void) | null = null;
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

  constructor(scope: BlueprintScope = "soul") {
    super();
    this.scope = scope;
    // Visibility is owned by the wrapping PixiPanel — we don't hide
    // ourselves on construct any more. The host panel's
    // `applyVisibility` flips our container's `visible` based on
    // open / minimize state.
    this.container.addChild(this.bg);

    for (let i = 0; i < CARD_COUNT; i++) {
      const slot = new BlueprintSlot();
      this.slots.push(slot);
      // LayoutNode-level addChild puts the slot in the hit-test tree
      // *and* parents its container under ours. Drag-starts on the
      // slot will surface here via `data.hit instanceof BlueprintSlot`.
      this.addChild(slot);
    }

    // Scrollbar — track is non-interactive; thumb is a LayoutNode so
    // it's hit-testable for drag-to-scroll. Overflow clipping comes
    // from the wrapping PixiPanel's content mask, so we no longer
    // need internal cover-quads.
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
      // Gate on the cursor being over our screen rect — the host
      // PixiPanel hides us when closed, but the canvas wheel listener
      // fires globally. `cursorOverBody` returns false when our
      // container is invisible (height/width zero).
      if (!this.container.visible) return;
      if (!this.cursorOverBody(e.clientX, e.clientY)) return;
      e.preventDefault();
      let dy: number;
      if (e.deltaMode === 1) dy = Math.sign(e.deltaY) * WHEEL_STEP;
      else if (e.deltaMode === 2) dy = Math.sign(e.deltaY) * this.height;
      else dy = e.deltaY;
      this.setScrollOffset(this.scrollOffset + dy);
    };
  }


  override destroy(): void {
    this.unsubDragStart?.();
    this.unsubDragStop?.();
    this.unsubSoul?.();
    this.unsubPlayer?.();
    this.unsubBitfieldTable?.();
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
    this.unsubArtLoad = ctx.lodTextures.onLoad(() => this.invalidate());

    if (this.scope === "soul") {
      // Track active soul → drives which `SoulPrivate` row we read.
      // `souls.on` fires immediately with the current value, so a
      // soul already-selected by the time the panel opens is picked
      // up here without a manual seed.
      this.unsubSoul = ctx.souls.on((soul: Soul | null) => {
        const next = soul?.cardId ?? null;
        if (next === this.currentSoulId) return;
        this.currentSoulId = next;
        this.invalidate();
      });

      // Re-render on every `soul_privates` event for the active
      // soul. The row is keyed by `cardId`; events for other souls
      // fall through as no-ops. Side-channel handler — leaves the
      // existing `DataManager` mirror handler intact (multiple
      // handlers fan out through `SubscriptionBase`).
      this.unsubBitfieldTable = ctx.data.subscriptions.registerTableHandlers(
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
    } else {
      // Player scope — track local player, watch `player_profiles`
      // for the matching row. `playerSession.on` fires immediately
      // with the cached player when one is set.
      this.unsubPlayer = ctx.playerSession.on((player: Player | null) => {
        const next = player?.playerId ?? null;
        if (next === this.currentPlayerId) return;
        this.currentPlayerId = next;
        this.invalidate();
      });
      this.unsubBitfieldTable = ctx.data.subscriptions.registerTableHandlers(
        "player_profiles",
        {
          onInsert: (row) => {
            if (row.playerId === this.currentPlayerId) this.invalidate();
          },
          onUpdate: (_oldRow, newRow) => {
            if (newRow.playerId === this.currentPlayerId) this.invalidate();
          },
          onDelete: (row) => {
            if (row.playerId === this.currentPlayerId) this.invalidate();
          },
        },
      );
    }

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
    if (!this.container.visible || !this.canvas) return false;
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

    // Body region = the whole panel minus padding + scrollbar gutter.
    // The wrapping `PixiPanel`'s content mask clips anything that
    // scrolls past these bounds, so no internal cover-quads are
    // needed (used to be required when this panel had a title bar
    // and toolbar reserved on top).
    const bodyLeft = PADDING;
    const bodyTop = PADDING;
    const bodyRight = this.width - SCROLLBAR_WIDTH - PADDING;
    const bodyBottom = this.height - PADDING;
    const bodyW = Math.max(0, bodyRight - bodyLeft);
    const bodyH = Math.max(0, bodyBottom - bodyTop);

    // Card placement. Column count adapts to the available body
    // width — at least one column, however many cards-plus-gutter
    // fit otherwise. The actual card sits flush-left inside its
    // column slot so card size stays at the canonical
    // RECT_CARD_WIDTH × RECT_CARD_HEIGHT regardless of how the slot
    // math rounds. Rows step by ROW_STEP (card + gutter).
    const cols = Math.max(1, Math.floor((bodyW + GUTTER) / (CARD_W + GUTTER)));
    const colStep = (bodyW + GUTTER) / cols;

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
    // Scope-driven bitfield source:
    //  - soul scope: `SoulPrivate.blueprints0` for the active soul
    //  - player scope: `PlayerProfile.blueprints0` for the local player
    // Each row is keyed by its scope's owner id; if the owner
    // isn't known yet (pre-login / pre-character-select) we render
    // an empty grid.
    let blueprintsBits = 0n;
    if (this.scope === "soul") {
      if (this.currentSoulId !== null) {
        const row = ctx.data.soulPrivatesLocal.get(this.currentSoulId);
        blueprintsBits = row?.blueprints0 ?? 0n;
      }
    } else {
      if (this.currentPlayerId !== null) {
        const row = ctx.data.playerProfilesLocal.get(this.currentPlayerId);
        blueprintsBits = row?.blueprints0 ?? 0n;
      }
    }
    const lookup = (id: number): Blueprint | null =>
      this.scope === "soul"
        ? ctx.definitions.blueprintById(id)
        : ctx.definitions.playerBlueprintById(id);

    // First pass: count discovered blueprints so the scrollbar /
    // overscroll math sees the right content height *before* we
    // place anything. A blueprint whose def fails to resolve is
    // dropped here too, mirroring the placement loop's fallback.
    let unlockedCount = 0;
    for (let i = 0; i < this.slots.length; i++) {
      if ((blueprintsBits & (1n << BigInt(i))) === 0n) continue;
      if (lookup(i + 1) === null) continue;
      unlockedCount++;
    }

    const rows = Math.ceil(unlockedCount / cols);
    const totalContentH = rows > 0 ? rows * ROW_STEP - GUTTER : 0;
    const maxScroll = Math.max(0, totalContentH - bodyH);
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
        slot.setBlueprint(0, 0, this.scope);
        slot.setBounds(0, 0, 0, 0);
        slot.container.visible = false;
        continue;
      }
      // Map slot index → blueprint id (+1), resolve the target card
      // def, and draw the titled card via `CardFace` (body + title +
      // outline + sprite in one call). A missing blueprint (e.g.
      // registry typo, id allocated but body removed) drops the
      // slot entirely — silent rather than crashing the UI, and
      // matches the count from the pre-pass above.
      const bp = lookup(i + 1);
      if (bp === null) {
        slot.setBlueprint(0, 0, this.scope);
        slot.setBounds(0, 0, 0, 0);
        slot.container.visible = false;
        continue;
      }
      // Draw the *blueprint* card (the discovered-blueprint visual),
      // not the output card — `blueprintPackedDefinition` is the
      // wrench-panel side of the schema; `cardPackedDefinition` is
      // what the eventual "build" reducer will spawn.
      const def = ctx.definitions.decode(bp.blueprintPackedDefinition);
      const label = ctx.definitions.label(bp.blueprintPackedDefinition);
      const col = displayIndex % cols;
      const row = Math.floor(displayIndex / cols);
      const x = bodyLeft + col * colStep;
      const y = bodyTop + row * ROW_STEP - this.scrollOffset;
      slot.setBlueprint(bp.id, bp.blueprintPackedDefinition, this.scope);
      slot.setBounds(x, y, CARD_W, CARD_H);
      // One call paints body + title + outline + sprite. If the
      // sprite hasn't loaded yet the face hides its art layer; the
      // `onArtLoad` subscription below re-runs layout so the next
      // pass picks it up.
      slot.face.draw(def, "top", label, {
        lodTextures: ctx.lodTextures,
        textureRegistry: getTextureRegistry(),
        // Blueprint previews aren't tied to a card row — seed on
        // the blueprint's stable id so each slot's variant stays
        // consistent across re-layouts.
        seed: bp.id,
        faction: localPlayerFactionFolder(ctx),
        definitions: ctx.definitions,
      });
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
   *  (offset=0 → thumb at top — standard top-down scroll). */
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

    // Thumb size reflects visible-vs-total ratio.
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
