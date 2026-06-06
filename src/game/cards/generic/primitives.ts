import { BitmapText, Container, Graphics, Sprite, Texture } from "pixi.js";
import { TEXT_BAKE_PX, TEXT_FONT } from "../../../assets/fonts";
import type { LodTextureManager } from "../../../assets/textures/LodTextureManager";
import { footprintPx, pxX, pxY, type CardBox } from "./cardBox";
import { resolveAsset } from "./resolveAsset";
import type { AnimatableFields, PrimKind, VisualNode } from "./visualSpec";

/** Per-step ease factor. Matches `CardLayout.TWEEN_LERP` so a primitive's ease
 *  feels identical to the card-position tween — both advance one step per
 *  `layout()` pass (frame-step, not dt). */
const STEP = 0.3;
/** Below this px delta a position/size field snaps to target (≙ TWEEN_SNAP_PX). */
const SNAP_PX = 0.25;
/** Per-channel tint delta below which colour is considered settled. */
const TINT_EPS = 1.5;

/** Shared deps a primitive needs to resolve itself. */
export interface PrimDeps {
  lod: LodTextureManager;
  /** Atlas-packed white texture for solid fills — tinted to any colour. MUST
   *  live in the same atlas as the art so fills batch with sprites (Pixi's
   *  global `Texture.WHITE` is a separate page and would break the batch). */
  whiteTexture: Texture;
  /** Per-card seed for variant picking (row/def id). */
  seed: number;
  faction?: string;
  /** White hex-mask texture (atlas-packed) for `hex` fills. Until wired, `hex`
   *  falls back to the rectangular white fill with a one-time warning. */
  hexTexture?: Texture;
  /** Live fill fraction for a `progress` primitive's `target` row: 0..1 while
   *  filling, or `< 0` when no such progress is active (the bar hides). The
   *  engine (not the DSL) drives this — it reads the row's timing vs the server
   *  clock each frame, so the bar fills without the DSL running per-frame. */
  progress?: (target: number) => number;
  /** Live fill fraction for a `progress` primitive with `source = 1`: the action
   *  QUEUE/debounce countdown before a recipe is proposed (0..1, or `< 0` when no
   *  queue is active → the bar hides). Same per-frame engine fill as `progress`. */
  queue?: () => number;
}

/** A reconciled, retained primitive: owns one Pixi node + its current/target
 *  animation state. The DSL sets targets; the engine eases current. */
export interface Primitive {
  readonly kind: PrimKind;
  readonly node: Container;
  /** Apply a spec node: discrete fields immediately, numeric fields as the new
   *  target. On first call, seeds `current` (from `enter` or target). */
  update(n: VisualNode, box: CardBox): void;
  /** Advance the ease one layout step; returns true while still animating (so
   *  the owning LayoutNode's `layout()` stays dirty and re-runs next frame). */
  settle(): boolean;
  destroy(): void;
}

function blankFields(): AnimatableFields {
  return { x: 0, y: 0, w: 0, h: 0, scale: 1, rot: 0, alpha: 1, tint: 0xffffff };
}

function targetFromNode(n: VisualNode, box: CardBox): AnimatableFields {
  return {
    x: pxX(box, n.pos.x),
    y: pxY(box, n.pos.y),
    w: pxX(box, n.size.x),
    h: pxY(box, n.size.y),
    scale: n.scale ?? 1,
    rot: n.rot ?? 0,
    alpha: n.alpha ?? 1,
    tint: n.tint ?? 0xffffff,
  };
}

function lerpChannel(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Per-channel colour ease. Returns `[blended, settled]`. */
function easeTint(cur: number, tgt: number, t: number): [number, boolean] {
  const cr = (cur >> 16) & 0xff, cg = (cur >> 8) & 0xff, cb = cur & 0xff;
  const tr = (tgt >> 16) & 0xff, tg = (tgt >> 8) & 0xff, tb = tgt & 0xff;
  if (Math.abs(cr - tr) < TINT_EPS && Math.abs(cg - tg) < TINT_EPS && Math.abs(cb - tb) < TINT_EPS) {
    return [tgt, true];
  }
  const nr = Math.round(lerpChannel(cr, tr, t));
  const ng = Math.round(lerpChannel(cg, tg, t));
  const nb = Math.round(lerpChannel(cb, tb, t));
  return [((nr << 16) | (ng << 8) | nb) >>> 0, false];
}

/** Shared ease + write loop. Subclasses provide the node and how `current`
 *  maps onto it (`writeNode`) plus discrete-field application (`applyDiscrete`). */
abstract class BasePrim implements Primitive {
  abstract readonly kind: PrimKind;
  abstract readonly node: Container;
  protected cur = blankFields();
  protected tgt = blankFields();
  /** World-pixel offset from the box, added to the node position on every
   *  write. `0` for self-mounted prims (cards); the tile corner for prims
   *  externally mounted into the viewport's shared sort container. Captured
   *  from the box on `update` so the per-step ease (`settle`) keeps applying it
   *  without re-reading the box. */
  protected originX = 0;
  protected originY = 0;
  private seeded = false;

  update(n: VisualNode, box: CardBox): void {
    this.tgt = targetFromNode(n, box);
    this.originX = box.originX;
    this.originY = box.originY;
    this.applyDiscrete(n, box);
    if (!this.seeded) {
      this.cur = n.enter ? { ...this.tgt, ...n.enter } : { ...this.tgt };
      this.seeded = true;
    }
    this.writeNode();
  }

  settle(): boolean {
    const c = this.cur, g = this.tgt;
    let active = false;
    for (const k of ["x", "y", "w", "h", "scale", "rot", "alpha"] as const) {
      const d = g[k] - c[k];
      const snap = k === "scale" || k === "alpha" ? 0.004 : k === "rot" ? 0.001 : SNAP_PX;
      if (Math.abs(d) < snap) {
        c[k] = g[k];
      } else {
        c[k] += d * STEP;
        active = true;
      }
    }
    if (c.tint !== g.tint) {
      const [blended, settled] = easeTint(c.tint, g.tint, STEP);
      c.tint = blended;
      if (!settled) active = true;
    }
    this.writeNode();
    return active;
  }

  destroy(): void {
    this.node.destroy();
  }

  /** Apply non-animated fields (texture/text/anchor + any base scale). */
  protected abstract applyDiscrete(n: VisualNode, box: CardBox): void;
  /** Push `this.cur` onto the Pixi node. */
  protected abstract writeNode(): void;
}

/** `rect` / `hex` — a solid (or textured) fill via a tinted Sprite. A white
 *  texture × tint gives any colour without a Graphics batch break. */
export class FillPrim extends BasePrim {
  readonly node: Sprite;
  constructor(readonly kind: "rect" | "hex", private readonly deps: PrimDeps) {
    super();
    this.node = new Sprite(deps.whiteTexture);
    if (kind === "hex") {
      if (deps.hexTexture) this.node.texture = deps.hexTexture;
      else hexFallbackWarn();
    }
  }

  protected applyDiscrete(n: VisualNode, box: CardBox): void {
    // Texture BEFORE setSize (Pixi 8: a 1×1 `orig` pins scale to literal px
    // otherwise). A textured fill swaps the base texture here.
    if (n.texture) {
      const r = resolveAsset(this.deps.lod, n.texture, footprintPx(box, n.size), {
        dpr: box.dpr, seed: this.deps.seed, faction: this.deps.faction,
      });
      this.node.texture = r.texture;
    } else if (this.kind === "hex" && this.deps.hexTexture) {
      this.node.texture = this.deps.hexTexture;
    } else {
      this.node.texture = this.deps.whiteTexture;
    }
    setAnchor(this.node, n);
  }

  protected writeNode(): void {
    const c = this.cur;
    this.node.position.set(this.originX + c.x, this.originY + c.y);
    this.node.rotation = c.rot;
    this.node.alpha = c.alpha;
    this.node.tint = c.tint;
    this.node.setSize(c.w * c.scale, c.h * c.scale);
  }
}

/** `sprite` — LOD art. Footprint × dpr drives the bucket; the resolver returns
 *  the scale that draws it at the requested CSS size. */
export class SpritePrim extends BasePrim {
  readonly kind = "sprite" as const;
  readonly node = new Sprite();
  private baseScale = 1;
  constructor(private readonly deps: PrimDeps) {
    super();
  }

  protected applyDiscrete(n: VisualNode, box: CardBox): void {
    if (!n.texture) {
      this.node.visible = false;
      return;
    }
    this.node.visible = true;
    const r = resolveAsset(this.deps.lod, n.texture, footprintPx(box, n.size), {
      dpr: box.dpr, seed: this.deps.seed, faction: this.deps.faction,
    });
    this.node.texture = r.texture;
    this.baseScale = r.scale;
    setAnchor(this.node, n);
  }

  protected writeNode(): void {
    const c = this.cur;
    this.node.position.set(this.originX + c.x, this.originY + c.y);
    this.node.rotation = c.rot;
    this.node.alpha = c.alpha;
    this.node.tint = c.tint;
    this.node.scale.set(this.baseScale * c.scale);
  }
}

/** `text` — a BitmapText. Content + font size are discrete (a re-rasterize);
 *  position / alpha / tint ease. */
export class TextPrim extends BasePrim {
  readonly kind = "text" as const;
  // The font is BAKED ONCE at `TEXT_BAKE_PX` (see `fonts.ts`) — every card label
  // shares that single glyph atlas (glyphs draw as batched quads). We NEVER drive
  // `style.fontSize`: changing it re-rasterizes a fresh atlas per size and per
  // zoom. Instead the prim's px height (`size.y`) becomes a `node.scale`, so
  // resizing/zoom is a free transform on the same atlas.
  readonly node = new BitmapText({ text: "", style: { fontFamily: TEXT_FONT, fontSize: TEXT_BAKE_PX } });
  /** Glyph scale = target px height / baked px — recomputed on data/box change. */
  private fontScale = 1;

  protected applyDiscrete(n: VisualNode, box: CardBox): void {
    this.node.text = n.text ?? "";
    this.fontScale = Math.max(0.01, pxY(box, n.size.y) / TEXT_BAKE_PX);
    setAnchor(this.node, n);
  }

  protected writeNode(): void {
    const c = this.cur;
    this.node.position.set(this.originX + c.x, this.originY + c.y);
    this.node.rotation = c.rot;
    this.node.alpha = c.alpha;
    this.node.tint = c.tint;
    // Eased `scale` field (default 1) composes with the glyph scale.
    this.node.scale.set(this.fontScale * c.scale);
  }
}

/** `progress` — a self-contained progress bar: a dim track + a fill driven by a
 *  `target` row's timing. The DSL sets `target` (which progress to track, from
 *  `^card_data` `*d.progress.<i>.id`) + `style` (1 = ltr, 2 = rtl); it does NOT
 *  set the fill — the engine resolves `target` to a live fraction
 *  (`deps.progress`) each frame, so the bar fills over time without the DSL
 *  running per-frame, and hides itself when the progress ends ("the engine
 *  handles the reset"). `tint` is the fill colour; `size` the bar box. */
export class ProgressPrim extends BasePrim {
  readonly kind = "progress" as const;
  readonly node = new Container();
  private readonly track = new Sprite();
  private readonly fill = new Sprite();
  private ax = 0;
  private ay = 0;
  private target = 0;
  private style = 1;
  /** Fill source: 0 = a progress row (`target`), 1 = the action queue/debounce. */
  private source = 0;
  /** Last fraction read from the source (`< 0` = inactive/hidden). Drives
   *  `settle`'s keep-alive so the bar re-renders while filling. */
  private frac = -1;
  constructor(private readonly deps: PrimDeps) {
    super();
    this.track.texture = deps.whiteTexture;
    this.fill.texture = deps.whiteTexture;
    this.node.addChild(this.track);
    this.node.addChild(this.fill);
  }

  protected applyDiscrete(n: VisualNode, _box: CardBox): void {
    this.target = n.target ?? 0;
    this.style = n.style ?? 1;
    this.source = n.source ?? 0;
    this.ax = (n.anchor?.x ?? 0) / 100;
    this.ay = (n.anchor?.y ?? 0) / 100;
  }

  protected writeNode(): void {
    const c = this.cur;
    // Live fraction from the engine: a progress row's timing (default) or the
    // action queue/debounce countdown (`source = 1`).
    this.frac = this.source === 1 ? (this.deps.queue?.() ?? -1) : (this.deps.progress?.(this.target) ?? -1);
    if (this.frac < 0) {
      this.node.visible = false;
      return;
    }
    this.node.visible = true;
    const w = c.w * c.scale;
    const h = c.h * c.scale;
    this.node.position.set(this.originX + c.x - this.ax * w, this.originY + c.y - this.ay * h);
    this.node.rotation = c.rot;
    this.node.alpha = c.alpha;
    // Track: transparent — the bar fills over whatever's behind it (the title-bar
    // rect for the recipe bar; the card seam for the queue bar). A visible track
    // would draw a strip even at frac≈0, reading as a line/gap at the body edge.
    this.track.visible = false;
    // Fill: the tint colour, width = fraction · w. style 2 = rtl (anchored to
    // the right edge); else ltr (from the left).
    const fw = w * Math.max(0, Math.min(1, this.frac));
    this.fill.tint = c.tint;
    this.fill.setSize(fw, h);
    this.fill.position.set(this.style === 2 ? w - fw : 0, 0);
  }

  override settle(): boolean {
    const base = super.settle(); // eases geometry, calls writeNode (refreshes frac)
    // Keep re-rendering while the bar is actively filling, so the live clock
    // advances it without the DSL re-running. Done (≥1) / inactive (<0) settle.
    return base || (this.frac >= 0 && this.frac < 1);
  }
}

/** `mask` — a clip rect, NOT drawn. The `PrimitiveLayer` sets it as its own
 *  `.mask`, so easing the rect's `h` (height) clips the rest of the card's prims:
 *  a roll-up exit when `h` eases full → 0. Seed the open height via `enter.h`
 *  (the target `size.y` is the rolled-up height, typically 0). Top-anchored, so
 *  the bottom of the card vanishes first — a window-blind roll-up. A rect
 *  Graphics (cheap axis-aligned stencil), redrawn each step from the eased box.
 *  Only meaningful on a self-mounted (card) layer; tiles never author one. */
export class MaskPrim extends BasePrim {
  readonly kind = "mask" as const;
  readonly node = new Graphics();

  protected applyDiscrete(_n: VisualNode, _box: CardBox): void {
    // A mask is pure geometry — no texture/anchor/text to apply.
  }

  protected writeNode(): void {
    const c = this.cur;
    this.node.position.set(this.originX + c.x, this.originY + c.y);
    this.node
      .clear()
      .rect(0, 0, Math.max(0, c.w * c.scale), Math.max(0, c.h * c.scale))
      .fill(0xffffff);
  }
}

function setAnchor(node: Sprite | BitmapText, n: VisualNode): void {
  const ax = (n.anchor?.x ?? 0) / 100;
  const ay = (n.anchor?.y ?? 0) / 100;
  node.anchor.set(ax, ay);
}

let hexWarned = false;
function hexFallbackWarn(): void {
  if (hexWarned) return;
  hexWarned = true;
  // Lazy import to keep this module free of a hard debug dependency at top.
  void import("../../../debug").then(({ debug }) =>
    debug.warn(["render"], "[generic] hex primitive has no hexTexture — falling back to rect fill"),
  );
}

/** Construct the backing primitive for a kind. */
export function makePrimitive(kind: PrimKind, deps: PrimDeps): Primitive {
  switch (kind) {
    case "rect":
    case "hex":
      return new FillPrim(kind, deps);
    case "sprite":
      return new SpritePrim(deps);
    case "text":
      return new TextPrim();
    case "progress":
      return new ProgressPrim(deps);
    case "mask":
      return new MaskPrim();
  }
}
