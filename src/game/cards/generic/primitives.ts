import { BitmapText, Container, Sprite, Texture } from "pixi.js";
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
  private seeded = false;

  update(n: VisualNode, box: CardBox): void {
    this.tgt = targetFromNode(n, box);
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
    this.node.position.set(c.x, c.y);
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
    this.node.position.set(c.x, c.y);
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
  readonly node = new BitmapText({ text: "", style: { fontFamily: "sans-serif", fontSize: 16, fill: 0xffffff } });

  protected applyDiscrete(n: VisualNode, box: CardBox): void {
    this.node.text = n.text ?? "";
    // Font size is the text's card-space height in px — set discretely, not
    // eased (easing fontSize re-rasterizes the glyph atlas every frame).
    const fontSize = Math.max(1, pxY(box, n.size.y));
    if (this.node.style.fontSize !== fontSize) this.node.style.fontSize = fontSize;
    setAnchor(this.node, n);
  }

  protected writeNode(): void {
    const c = this.cur;
    this.node.position.set(c.x, c.y);
    this.node.rotation = c.rot;
    this.node.alpha = c.alpha;
    this.node.tint = c.tint;
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
  }
}
