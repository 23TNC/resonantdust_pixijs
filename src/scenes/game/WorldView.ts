import { Graphics, Text } from "pixi.js";
import { LayoutNode } from "../../layout/LayoutNode";

export class LayoutWorld extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly label: Text;

  constructor() {
    super();
    this.label = new Text({
      text: "World",
      style: {
        fill: 0xcccccc,
        fontFamily: "sans-serif",
        fontSize: 24,
      },
    });
    this.label.anchor.set(0.5);

    this.container.addChild(this.bg);
    this.container.addChild(this.label);
  }

  protected override layout(): void {
    this.bg.clear();
    this.bg.rect(0, 0, this.width, this.height).fill({ color: 0x0d1218 });
    this.label.position.set(this.width / 2, this.height / 2);
  }
}
