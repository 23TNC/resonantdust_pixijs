import { Container } from "pixi.js";
import type { GameContext } from "../../../GameContext";
import { global } from "../../definitions/globals";
import { cardBox } from "./cardBox";
import { atlasHex, atlasWhite } from "./atlasFills";
import { PrimitiveLayer } from "./PrimitiveLayer";
import type { PrimDeps } from "./primitives";
import { drawVisuals, type HostValue, type VisualHost } from "./drawVisuals";

/**
 * A standalone, offline render of a card definition's `:visuals` — the same
 * generic PrimList pipeline a live `LayoutGenericCard` uses, but with no card
 * row, no LayoutNode, and no easing loop. Drives a single `PrimitiveLayer`
 * whose `init` draw snaps every primitive straight to its target (see
 * `BasePrim.update` seeding `cur = tgt`), so one `draw()` produces a fully
 * positioned card with no tick.
 *
 * Use for preview surfaces that render a *def*, not a *card*: the drag ghost
 * today; blueprint / wrench previews later. Re-call `draw()` on
 * `lodTextures.onLoad` so lazily-loaded art upgrades in place.
 *
 * Origin matches `LayoutGenericCard`: (0,0) is the body's top-left corner; the
 * title strip prims sit OUTSIDE the body (negative y for a loose card). This is
 * the same convention the drag grab-offset is measured against, so a ghost
 * lines up with the real card under the cursor.
 */
export class GenericCardFace extends Container {
  private readonly layer: PrimitiveLayer;
  private readonly deps: PrimDeps;

  constructor(
    private readonly ctx: GameContext,
    seed: number,
  ) {
    super();
    this.deps = {
      lod: ctx.lodTextures,
      whiteTexture: atlasWhite(ctx.textures, ctx.app.renderer),
      hexTexture: atlasHex(ctx.textures, ctx.app.renderer),
      seed,
      // Preview: no live row → no progress timing. Bars hide on `< 0`.
      progress: () => -1,
      queue: () => -1,
    };
    this.layer = new PrimitiveLayer(cardBox(global("card_width"), global("body_height")), this.deps);
    this.addChild(this.layer);
  }

  /** (Re)render the def's `:visuals @init`. `fallbackFaction` is the viewer's
   *  faction folder; a card-side `faction` sub-aspect override beats it (mirrors
   *  `LayoutGenericCard.rebuildSpec`) so faction-specific cards preview the same
   *  across viewers. */
  draw(packedDefinition: number, fallbackFaction?: string | null): void {
    const def = this.ctx.definitions.decode(packedDefinition);
    const faction =
      (def ? this.ctx.definitions.cardFactionOverride(def) : null) ??
      fallbackFaction ??
      undefined;
    this.deps.faction = faction;
    const host: VisualHost = { card_data: PREVIEW_CARD_DATA };
    if (faction) host.faction = faction;
    this.layer.draw(drawVisuals(packedDefinition, host, "init"));
  }

  override destroy(): void {
    this.layer.destroy();
    super.destroy();
  }
}

/** Static `^card_data` for a def preview: a plain loose card — no stack fan, no
 *  hover/select/pending/drag overlays, no progress bars. Mirrors the shape of
 *  `LayoutGenericCard.buildCardData` so the DSL reads the same keys. */
const PREVIEW_CARD_DATA: HostValue = {
  stack: { state: 0, index: 0, dir: 0 },
  loose: 1,
  hovered: 0,
  selected: 0,
  pending: 0,
  dragging: 0,
  progress: [],
};
