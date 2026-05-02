import { Graphics, Text } from "pixi.js";
import { LayoutNode } from "../../layout/LayoutNode";

const HEIGHT = 32;
const PADDING = 12;
const FONT_SIZE = 14;
const FPS_SMOOTHING = 0.05;

export class TitleBar extends LayoutNode {
  static readonly HEIGHT = HEIGHT;

  private readonly bg = new Graphics();
  private readonly nameText: Text;
  private readonly fpsText: Text;
  private fps = 60;

  constructor(playerName: string) {
    super();
    this.nameText = new Text({
      text: playerName,
      style: {
        fill: 0xffffff,
        fontFamily: "sans-serif",
        fontSize: FONT_SIZE,
      },
    });
    this.nameText.anchor.set(0, 0.5);

    this.fpsText = new Text({
      text: "-- fps",
      style: {
        fill: 0x999999,
        fontFamily: "ui-monospace, monospace",
        fontSize: FONT_SIZE,
      },
    });
    this.fpsText.anchor.set(1, 0.5);

    this.container.addChild(this.bg);
    this.container.addChild(this.nameText);
    this.container.addChild(this.fpsText);
  }

  updateFps(deltaMS: number): void {
    if (deltaMS <= 0) return;
    const instant = 1000 / deltaMS;
    this.fps = this.fps * (1 - FPS_SMOOTHING) + instant * FPS_SMOOTHING;
    this.fpsText.text = `${Math.round(this.fps)} fps`;
  }

  protected override layout(): void {
    this.bg.clear();
    this.bg.rect(0, 0, this.width, this.height).fill({ color: 0x1a1f24 });

    const cy = this.height / 2;
    this.nameText.position.set(PADDING, cy);
    this.fpsText.position.set(this.width - PADDING, cy);
  }
}
