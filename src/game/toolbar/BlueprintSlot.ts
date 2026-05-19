import { Sprite, Texture } from "pixi.js";
import { LayoutNode } from "../layout/LayoutNode";

/**
 * Hit-testable cell in the wrench panel's blueprint grid. Hosts a
 * single Sprite whose texture is set per-frame by `WrenchPanel.layout`
 * (per-def card via `CardTextureManager.getRect` for unlocked
 * blueprints; collapsed bounds for locked ones).
 *
 * Owning a LayoutNode per slot — rather than a bare Sprite — gives us
 * two things the parent panel needs:
 *
 * - **Drag pick-up.** `InputManager.hitTestLayout` walks the layout
 *   tree on every press, so `DragManager` can recognise a drag-start
 *   that originates from a slot (`data.hit instanceof BlueprintSlot`)
 *   and spawn a `DragGhost` for the blueprint's card.
 * - **Collapse to no-op.** Locked slots are rendered by setting their
 *   bounds to `0 × 0`, which fails the default `intersects` check and
 *   removes them from drag pickup without a custom predicate.
 *
 * The blueprint identity (`blueprintId`, `cardPackedDefinition`)
 * lives on the slot rather than being resolved at drag time so the
 * drag handler doesn't have to re-walk `blueprints_0` to figure out
 * which blueprint the user grabbed.
 */
export class BlueprintSlot extends LayoutNode {
  readonly sprite: Sprite;
  /** Stable blueprint id from `content/blueprints/id.json`. `0` when
   *  the slot is locked (no blueprint mounted) — same sentinel as
   *  `BLUEPRINT_NONE` server-side. */
  blueprintId = 0;
  /** Resolved `packedDefinition` for the blueprint's card. `0` when
   *  locked. Used directly by `DragManager` to mint the drag ghost
   *  (matches the `DragGhost` constructor signature). */
  cardPackedDefinition = 0;

  /** Card-art overlay drawn on top of the base card texture. Bound
   *  to the blueprint card def's `sprite` field by
   *  `WrenchPanel.layout` — the same sprite that `RectCard.applyCardArt`
   *  uses for in-world cards. Anchored at its centre so a single
   *  position-set + scale-set call lays it out over the body region. */
  readonly artSprite: Sprite;

  constructor() {
    super();
    this.sprite = new Sprite(Texture.EMPTY);
    this.artSprite = new Sprite();
    this.artSprite.anchor.set(0.5, 0.5);
    this.artSprite.visible = false;
    this.container.addChild(this.sprite);
    // Art draws above the base card texture — same z-order as
    // `RectCard` puts its own `artSprite` over the visual.
    this.container.addChild(this.artSprite);
  }

  /** Bind this slot to a blueprint. Called from `WrenchPanel.layout`
   *  for unlocked slots; passing `0` / `0` clears the binding (used
   *  for locked slots which then also collapse their bounds). */
  setBlueprint(blueprintId: number, cardPackedDefinition: number): void {
    this.blueprintId = blueprintId;
    this.cardPackedDefinition = cardPackedDefinition;
  }
}
