import type { LayoutNode } from "../layout/LayoutNode";
import type { LayoutCard } from "./layout/CardLayout";
import type { CardManager } from "./CardManager";
import type { StackDirection } from "./Card";
import type { Card as CardRow } from "../../server/spacetime/bindings/types";
import type { ZoneId } from "../../server/data/packing";

/**
 * The per-panel VISUAL of a card. One `Card` (model) owns one `CardView` per
 * viewport that shows its zone; the view owns the `LayoutCard` PIXI node and
 * everything that depends on a specific panel's surface — the attach target,
 * the smooth re-parent, and the drag re-parent to the global overlay. Model
 * state (position decode, stacking-chain membership, back-pointers) stays on
 * `Card` and is passed into these methods as `(parentId, direction, zoneId)`.
 *
 * Phase C of the multi-viewport work: exactly one view per card (`Card.view`).
 * Phase D turns that into a map keyed by viewport so a row can render in N
 * panels at once; the per-view parent-host resolution here (`parent.view`)
 * becomes `parent.viewIn(thisViewId)` then.
 */
export class CardView {
  readonly layoutCard: LayoutCard;
  private readonly cardManager: CardManager;

  constructor(cardManager: CardManager, layoutCard: LayoutCard) {
    this.cardManager = cardManager;
    this.layoutCard = layoutCard;
  }

  applyData(row: CardRow): void {
    this.layoutCard.applyData(row);
  }

  /** Attach the layout node to whichever surface/host matches the model's
   *  current `(parentId, direction, zoneId)`: a parent card's stack host /
   *  hexMount when stacked, else the zone surface. */
  attachToCurrent(
    parentId: number,
    direction: StackDirection | null,
    zoneId: ZoneId,
  ): void {
    if (parentId !== 0) {
      const parent = this.cardManager.get(parentId);
      if (parent) {
        const parentLayout = parent.view.layoutCard;
        // Unified: stack 0 (hex/under-root), top, bottom all route through
        // attachToStack → the matching stack host on the root. No hexMount
        // special-case — a hex/tile member uses the root's stackHexHost.
        this.layoutCard.attachToStack(parentLayout, direction ?? "top");
        return;
      }
      // Defensive: parent vanished between routing and attach. Fall through
      // to the zone surface so the card is at least visible.
    }
    this.layoutCard.attach(zoneId);
  }

  /**
   * Re-parent the layout node preserving its on-screen position via
   * global→local conversion, so a zone / stack-parent change after the initial
   * spawn transitions seamlessly rather than snapping.
   *
   * The display buffer means an update can fire after our PIXI container has
   * been detached or destroyed mid-flight; when it isn't in a live scene graph,
   * `getGlobalPosition()` would throw, so fall back to a plain detach +
   * re-attach (there's no on-screen position worth preserving).
   */
  reparentSmoothly(newParent: LayoutNode | null): void {
    const myContainer = this.layoutCard.container;
    if (!myContainer.position) return;
    if (!myContainer.parent) {
      this.layoutCard.detach();
      if (newParent) newParent.addChild(this.layoutCard);
      return;
    }
    const g = myContainer.getGlobalPosition();
    this.layoutCard.detach();
    if (!newParent) return;
    newParent.addChild(this.layoutCard);
    const sg = newParent.container.getGlobalPosition();
    this.layoutCard.setDisplayPosition(g.x - sg.x, g.y - sg.y);
  }

  /** Resolve the layout parent for the NEW model target and re-parent there.
   *  The caller (`Card.onDataChange`) has already handled the orphan case
   *  (missing parent) before calling, so a missing parent here just resolves
   *  to a null surface (left unattached until it lands). */
  reparentToModel(
    parentId: number,
    direction: StackDirection | null,
    zoneId: ZoneId,
  ): void {
    let nextParent: LayoutNode | null = null;
    if (parentId !== 0) {
      const parentLayout = this.cardManager.get(parentId)?.view.layoutCard;
      if (parentLayout) {
        nextParent =
          direction === "hex" && parentLayout.hexMount
            ? parentLayout.hexMount
            : direction === "bottom"
              ? parentLayout.stackBottomHost
              : parentLayout.stackTopHost;
      }
    } else {
      nextParent = this.layoutCard.ctx.layout?.surfaceFor(zoneId) ?? null;
    }
    this.reparentSmoothly(nextParent);
  }

  /**
   * Visual half of drag. On grab, re-parent up to the global overlay so the
   * card roams above the scene; on release, re-attach to the surface its
   * current model state implies. On-screen position is preserved across each
   * re-parent so the transition is seamless. `offsetX/Y` are cursor→top-left
   * offsets at grab time, plumbed to the layout node for cursor-following.
   */
  setDragging(
    value: boolean,
    offsetX: number,
    offsetY: number,
    parentId: number,
    direction: StackDirection | null,
    zoneId: ZoneId,
  ): void {
    if (value) {
      const overlay = this.layoutCard.ctx.layout?.overlay;
      if (overlay) {
        const g = this.layoutCard.container.getGlobalPosition();
        this.layoutCard.detach();
        overlay.addChild(this.layoutCard);
        this.layoutCard.setDisplayPosition(g.x, g.y);
      }
      this.layoutCard.setDragging(true, offsetX, offsetY);
    } else {
      const g = this.layoutCard.container.getGlobalPosition();
      this.layoutCard.detach();
      this.attachToCurrent(parentId, direction, zoneId);
      // Use the actual PIXI parent (e.g. worldCardLayer) rather than the
      // LayoutNode surface's container, which may differ for world cards.
      const pixiParent = this.layoutCard.container.parent;
      if (pixiParent) {
        const sg = pixiParent.getGlobalPosition();
        this.layoutCard.setDisplayPosition(g.x - sg.x, g.y - sg.y);
      }
      this.layoutCard.setDragging(false);
    }
  }

  destroy(): void {
    this.layoutCard.destroy();
  }
}
