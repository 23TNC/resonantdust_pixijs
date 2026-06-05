import type { Card as CardRow } from "../../../server/spacetime/bindings/types";
import type { GameContext } from "../../../GameContext";
import { ownerFactionFolder } from "../../../server/player/playerFlags";
import { LayoutCard } from "../layout/CardLayout";
import { RECT_CARD_WIDTH, RECT_CARD_HEIGHT, RECT_CARD_TITLE_HEIGHT } from "../layout/rectangle/RectCard";
import { decodeMicro } from "../../../server/data/packing";
import { directionForBranch } from "../cardData";
import { cardBox } from "./cardBox";
import { atlasHex, atlasWhite } from "./atlasFills";
import { PrimitiveLayer } from "./PrimitiveLayer";
import type { PrimDeps } from "./primitives";
import { drawVisuals, type VisualHost } from "./drawVisuals";
import type { PrimList } from "./visualSpec";

/**
 * The DSL-driven card, slotting into the existing `Card` lifecycle as the
 * visual ("Layout") half. Extends `LayoutCard` to reuse all the shared
 * plumbing — `tweenTo` position animation, drag offset, stack hosts, attach —
 * and replaces only the bespoke visual build (the `rectVisual`/`progressBar`/
 * `resourceMeter`/… sub-layers of `LayoutRectCard`) with a `PrimitiveLayer`
 * reconciled from a `PrimList`.
 *
 * `layout()` is the same shape as `LayoutRectCard`'s positioning tail —
 * `tweenTo(target, with drag)` — plus `layer.settle()` for the primitive ease;
 * returning `true` from either keeps the LayoutNode dirty loop running (no
 * ticker). The spec rebuilds only on data change (`applyData`) / resize.
 *
 * **Scope today:** loose / unstacked cards (first live def: requisite `axe`).
 * Stack positioning (`chainStep`) is shape-specific and deferred until a stacked
 * card is migrated — at which point the generic stack model is decided (likely
 * DSL-driven). The spec comes from the wasm `:visuals` export (`rebuildSpec` →
 * `drawVisuals`); `setSpec` allows direct injection (preview paths).
 */
export class LayoutGenericCard extends LayoutCard {
  private readonly layer: PrimitiveLayer;
  private readonly deps: PrimDeps;
  private spec: PrimList | null = null;
  private currentPackedDefinition: number | null = null;
  /** First draw runs the `:visuals @init` hook (client snaps current=target);
   *  subsequent data changes run `@update` (client eases to new targets). */
  private drawn = false;

  constructor(cardId: number, ctx: GameContext) {
    super(cardId, ctx);
    // Default to the standard rect-card box so the PrimitiveLayer has a non-zero
    // pixel box from the start (LayoutNode starts at 0×0; LayoutRectCard does the
    // same in its constructor). Without this every prim resolves against a 0×0
    // box and draws at zero size — i.e. nothing renders.
    this.setSize(RECT_CARD_WIDTH, RECT_CARD_HEIGHT);
    this.deps = {
      lod: ctx.lodTextures,
      whiteTexture: atlasWhite(ctx.textures, ctx.app.renderer),
      hexTexture: atlasHex(ctx.textures, ctx.app.renderer),
      seed: cardId,
    };
    this.layer = new PrimitiveLayer(cardBox(this.width, this.height), this.deps);
    // Above the stack hosts the base added in its constructor.
    this.container.addChild(this.layer);
  }

  applyData(row: CardRow): void {
    this.currentPackedDefinition = row.packedDefinition;
    this.rebuildSpec();
    this.applyPosition(row);
    this.invalidate();
  }

  /** Decode the row's placement and set the tween target — without this the card
   *  sits at (0,0) and never appears in its cell. Mirror of the position half of
   *  `LayoutRectCard.applyData` (the death/flags/overlay decorations are
   *  rect-specific and omitted). LOOSE is handled fully; STACKED gets a
   *  raw-index fan (no gap-collapse — the gap-aware `chainStep` + the proper
   *  fix, lifting this whole decode into the shared `LayoutCard` base, are
   *  deferred with the generic stack model). */
  private applyPosition(row: CardRow): void {
    const micro = decodeMicro(row.microLocation, row.flagsBk);
    if (micro.kind === "loose") {
      this.stackZ = null;
      const q = row.macroZone.zoneQ + micro.localQ;
      const r = row.macroZone.zoneR + micro.localR;
      const cell = this.worldView?.cellToPixel(q, r);
      const applyOffset = (micro.looseKind & 0b10) === 0;
      const ox = applyOffset ? micro.x : 0;
      const oy = applyOffset ? micro.y : 0;
      if (cell) {
        this.setTarget((cell.x + ox) - RECT_CARD_WIDTH / 2, (cell.y + oy) - RECT_CARD_HEIGHT / 2);
      } else {
        this.setTarget(micro.x, micro.y);
      }
      return;
    }
    // Stacked: parented to the root's stack host by `CardView.attach`; position
    // within it by a simple index fan. Signed stackZ so inner cards render in
    // front, matching the rect chain's convention.
    const dir = directionForBranch(micro.branch);
    const off = micro.index * RECT_CARD_TITLE_HEIGHT;
    this.stackZ = dir === "bottom" ? micro.index : -micro.index;
    if (dir === "bottom") this.setTarget(0, off);
    else if (dir === "top") this.setTarget(0, -off);
    else this.setTarget(0, 0); // hex mount — centred on the root
  }

  /** Direct spec injection — the eventual wasm `@draw` output path. */
  setSpec(list: PrimList): void {
    this.spec = list;
    this.layer.setBox(cardBox(this.width, this.height));
    this.layer.draw(list);
    this.invalidate();
  }

  protected override layout(): boolean | void {
    // Position: identical tail to LayoutRectCard — target, or cursor-follow
    // while dragging — driven through the base's tween.
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
    const easing = this.layer.settle();
    return moving || easing || undefined;
  }

  override setBounds(x: number, y: number, width: number, height: number): void {
    const sizeChanged = width !== this.width || height !== this.height;
    super.setBounds(x, y, width, height);
    if (sizeChanged && this.spec) {
      this.layer.setBox(cardBox(this.width, this.height));
      this.layer.draw(this.spec);
    }
  }

  override destroy(): void {
    this.layer.destroy();
    super.destroy();
  }

  /** Run the card's `:visuals` hook through the VM (`drawVisuals`) and reconcile.
   *  Faction is resolved and passed in the host (the DSL reads `*faction` for
   *  faction-tinted art) AND set on `deps` so `SpritePrim` picks the faction LOD
   *  during the draw. `@init` on first draw, `@update` after. */
  private rebuildSpec(): void {
    if (this.currentPackedDefinition === null) {
      this.spec = null;
      return;
    }
    const def = this.ctx.definitions.decode(this.currentPackedDefinition);
    const faction =
      (def ? this.ctx.definitions.cardFactionOverride(def) : null) ??
      ownerFactionFolder(this.ctx, this.cardId) ??
      undefined;
    this.deps.faction = faction;
    const host: VisualHost = {};
    if (faction) host.faction = faction;
    this.spec = drawVisuals(this.currentPackedDefinition, host, this.drawn ? "update" : "init");
    this.drawn = true;
    this.layer.setBox(cardBox(this.width, this.height));
    this.layer.draw(this.spec);
  }
}
