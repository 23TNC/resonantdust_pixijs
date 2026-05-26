import { RenderTexture, Sprite } from "pixi.js";
import type { GameContext } from "../../../GameContext";

export interface WorldObjectOverlayOptions {
  /** Width of the baked snapshot RT in card-local pixels. */
  width: number;
  /** Height of the baked snapshot RT in card-local pixels. */
  height: number;
  /** Sprite alpha — `LayoutRectCard` uses 0.75, `LayoutHexCard`
   *  uses 0.5. */
  alpha: number;
}

/**
 * Per-card "in-front-objects" overlay: a translucent Sprite that
 * bakes the world-tile content (trees, rocks, etc.) which should
 * visually occlude this card from above. Sourced from
 * `ctx.worldOverlay`.
 *
 * The host (`LayoutRectCard` / `LayoutHexCard`) parents `sprite` once
 * at construction time at whatever z-position it wants the occluder
 * to sit at — the overlay then manages `texture` / `visible` on its
 * own. Two refresh entry points:
 *
 * - `refresh(q, r, offsetX, offsetY)` — the card sits on its own
 *   world tile.
 * - `inheritFrom(parentQ, parentR, parentOffsetX, parentOffsetY)` —
 *   the card is stacked on a parent; uses the parent's overlay
 *   coords plus this card's `chainDelta` (set by the host in
 *   `applyData`) to align the snapshot with our actual position.
 *
 * `clear()` hides the sprite and forgets the cached tile coords (the
 * RT + Sprite stay around for reuse).
 *
 * The overlay also auto-refreshes on two ambient events:
 *   - `ctx.lodTextures.onLoad` — a card placed before its sprite
 *     pack landed picks up the texture once it arrives.
 *   - `ctx.onTilesChanged` — a card stays in sync as world tiles
 *     change underneath it.
 *
 * `onStateChange` fires after every refresh / clear so the host can
 * cascade overlay state to stacked children (the host owns the
 * walk over its stack hosts / hex mount; the overlay just signals
 * "my state moved").
 */
export class WorldObjectOverlay {
  readonly sprite: Sprite;
  /** Backing RenderTexture for `sprite`. Single RT reused across
   *  refreshes — `ctx.worldOverlay` renders into it in place. */
  private readonly texture: RenderTexture;

  /** Current tile coords this overlay is baked for, or `null` when
   *  hidden / not on a world surface. Hosts gate per-frame refreshes
   *  on `overlay.q !== null` to skip cards that aren't on the world. */
  q: number | null = null;
  r: number | null = null;
  offsetX = 0;
  offsetY = 0;

  /** Displacement of this card's centre from its parent's centre in
   *  world pixels. Used in `inheritFrom` to align the snapshot with
   *  this card's actual position rather than the parent's. */
  private chainDeltaX = 0;
  private chainDeltaY = 0;

  /** Host callback fired after every state mutation. Hosts wire this
   *  to their stacked-children cascade so descendants `inheritFrom`
   *  the latest state. `null` until the host wires it. */
  onStateChange: (() => void) | null = null;

  private readonly ctx: GameContext;
  private readonly width: number;
  private readonly height: number;
  private readonly unsubObjectLoad: () => void;
  private readonly unsubTileChange: (() => void) | null;

  constructor(ctx: GameContext, options: WorldObjectOverlayOptions) {
    this.ctx = ctx;
    this.width = options.width;
    this.height = options.height;
    this.texture = RenderTexture.create({
      width: options.width,
      height: options.height,
      resolution: Math.min(window.devicePixelRatio, 2),
    });
    this.sprite = new Sprite(this.texture);
    this.sprite.alpha = options.alpha;
    this.sprite.visible = false;

    // Refresh whenever an object-texture pack lands — the first
    // snapshot built at placement time may miss sprites whose pack
    // was still loading. Mirrors the legacy behaviour of resetting
    // offset to 0 (the per-frame drag-tween refresh in the host
    // covers cards mid-motion).
    this.unsubObjectLoad = ctx.lodTextures.onLoad(() => {
      if (this.q !== null && this.r !== null) {
        this.refresh(this.q, this.r);
      }
    });
    // Refresh whenever world tile data updates so the snapshot
    // tracks new trees / terrain changes. Preserves current offset —
    // the card hasn't moved, the tiles around it have.
    this.unsubTileChange = ctx.onTilesChanged?.(() => {
      if (this.q !== null && this.r !== null) {
        this.refresh(this.q, this.r, this.offsetX, this.offsetY);
      }
    }) ?? null;
  }

  /** Set the static displacement of this card from its parent. Called
   *  by the host in `applyData` whenever stack direction changes. */
  setChainDelta(dx: number, dy: number): void {
    this.chainDeltaX = dx;
    this.chainDeltaY = dy;
  }

  /** Re-bake the snapshot for the given world hex. `(offsetX, offsetY)`
   *  is the tile centre's displacement from the card centre — a
   *  chained rect above its parent passes a positive offsetY to slide
   *  the snapshot down. */
  refresh(q: number, r: number, offsetX = 0, offsetY = 0): void {
    const overlay = this.ctx.worldOverlay;
    if (!overlay) return;
    this.q = q;
    this.r = r;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.sprite.visible = overlay(q, r, this.texture, this.width, this.height, offsetX, offsetY);
    this.onStateChange?.();
  }

  /** Parent-pushed state — the parent's overlay coords plus this
   *  card's `chainDelta` give the snapshot the right shift relative
   *  to our position. `null` parent coords clear our overlay. */
  inheritFrom(
    parentQ: number | null,
    parentR: number | null,
    parentOffsetX: number,
    parentOffsetY: number,
  ): void {
    if (parentQ === null || parentR === null) {
      this.clear();
      return;
    }
    this.refresh(
      parentQ,
      parentR,
      parentOffsetX + this.chainDeltaX,
      parentOffsetY + this.chainDeltaY,
    );
  }

  /** Hide the overlay and forget the cached tile. The RT + Sprite
   *  stay around for reuse if the card re-enters a world surface. */
  clear(): void {
    this.q = null;
    this.r = null;
    this.offsetX = 0;
    this.offsetY = 0;
    this.sprite.visible = false;
    this.onStateChange?.();
  }

  destroy(): void {
    this.unsubObjectLoad();
    this.unsubTileChange?.();
    this.sprite.destroy();
    this.texture.destroy(true);
  }
}
