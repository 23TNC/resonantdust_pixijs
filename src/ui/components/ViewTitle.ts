import { client_cards, observer_id, viewed_id } from "@/spacetime/Data";
import { LayoutLabel, type LayoutLabelOptions } from "@/ui/layout/LayoutLabel";

/**
 * Displays the current observer / viewed soul identifiers and the viewed
 * soul's world position.  Call sync() after any data change that may affect
 * these values.
 */
export class ViewTitle extends LayoutLabel {
  constructor(options: LayoutLabelOptions = {}) {
    super({ align: "center", valign: "middle", ...options });
    this.sync();
  }

  sync(): void {
    const soul = client_cards[viewed_id];
    if (soul) {
      this.setText(
        `obs:${observer_id}  view:${viewed_id}  q:${soul.world_q}  r:${soul.world_r}  z:${soul.layer}`,
      );
    } else {
      this.setText(`obs:${observer_id}  view:${viewed_id}  —`);
    }
  }
}
