import { LayoutNode } from "../layout/LayoutNode";
import { CardFace } from "../cards/CardFace";

/**
 * Hit-testable cell in the wrench panel's blueprint grid. Hosts a
 * single `CardFace` (body + title + outline + art) drawn from the
 * blueprint card def each layout pass.
 *
 * Owning a `LayoutNode` per slot — rather than a bare display object
 * — gives us two things the parent panel needs:
 *
 * - **Drag pick-up.** `InputManager.hitTestLayout` walks the layout
 *   tree on every press, so `DragManager` can recognise a drag-start
 *   that originates from a slot (`data.hit instanceof BlueprintSlot`)
 *   and spawn a `DragGhost` for the blueprint's card.
 * - **Collapse to no-op.** Locked slots are rendered by setting
 *   their bounds to `0 × 0`, which fails the default `intersects`
 *   check and removes them from drag pickup without a custom
 *   predicate.
 *
 * The blueprint identity (`blueprintId`, `cardPackedDefinition`)
 * lives on the slot so the drag handler doesn't have to re-walk
 * `blueprints_0` to figure out which blueprint the user grabbed.
 */
export class BlueprintSlot extends LayoutNode {
  readonly face: CardFace;
  /** Stable blueprint id from `content/blueprints/id.json`. `0` when
   *  the slot is locked — same sentinel as `BLUEPRINT_NONE`
   *  server-side. */
  blueprintId = 0;
  /** Resolved `packedDefinition` for the blueprint's card. `0` when
   *  locked. Used directly by `DragManager` to mint the drag ghost
   *  (matches the `DragGhost` constructor signature). */
  cardPackedDefinition = 0;

  constructor() {
    super();
    this.face = new CardFace();
    this.container.addChild(this.face);
  }

  /** Bind this slot to a blueprint. Called from `BlueprintsPanel.layout`
   *  for unlocked slots; passing `0` / `0` clears the binding (used
   *  for locked slots which then also collapse their bounds). */
  setBlueprint(blueprintId: number, cardPackedDefinition: number): void {
    this.blueprintId = blueprintId;
    this.cardPackedDefinition = cardPackedDefinition;
  }
}
