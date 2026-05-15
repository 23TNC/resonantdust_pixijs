import { Graphics, Text } from "pixi.js";
import { LayoutNode } from "../layout/LayoutNode";
import { NOTO_EMOJI_FAMILY } from "../../assets/fonts";
import { SettingsMenu } from "./SettingsMenu";

const HEIGHT = 32;
const PADDING = 12;
const FONT_SIZE = 14;
const FONT_WEIGHT = "400";
const FPS_SMOOTHING = 0.05;

export class TitleBar extends LayoutNode {
  static readonly HEIGHT = HEIGHT;

  private readonly bg = new Graphics();
  private readonly nameText: Text;
  private readonly drawCallsText: Text;
  private readonly fpsText: Text;
  private readonly settingsText: Text;
  private fps = 60;
  private readonly playerName: string;
  readonly settingsMenu = new SettingsMenu();

  constructor(playerName: string) {
    super();
    this.playerName = playerName;
    this.nameText = new Text({
      text: this.formatNameLine(),
      style: {
        fill: 0xffffff,
        fontFamily: "sans-serif",
        fontSize: FONT_SIZE,
      },
    });
    this.nameText.anchor.set(0, 0.5);

    this.drawCallsText = new Text({
      text: "-- dc",
      style: {
        fill: 0x999999,
        fontFamily: "ui-monospace, monospace",
        fontSize: FONT_SIZE,
      },
    });
    this.drawCallsText.anchor.set(1, 0.5);

    this.fpsText = new Text({
      text: "-- fps",
      style: {
        fill: 0x999999,
        fontFamily: "ui-monospace, monospace",
        fontSize: FONT_SIZE,
      },
    });
    this.fpsText.anchor.set(1, 0.5);

    this.settingsText = new Text({
      text: "⚙",
      style: {
        fill: 0xffffff,
        fontFamily: NOTO_EMOJI_FAMILY,
        fontSize: FONT_SIZE,
        fontWeight: FONT_WEIGHT,
      },
    });
    this.settingsText.anchor.set(1, 0.5);
    this.settingsText.eventMode = "static";
    this.settingsText.cursor = "pointer";
    this.settingsText.on("pointertap", () => this.settingsMenu.toggle());

    this.container.addChild(this.bg);
    this.container.addChild(this.nameText);
    this.container.addChild(this.drawCallsText);
    this.container.addChild(this.fpsText);
    this.container.addChild(this.settingsText);
  }

  updateStats(deltaMS: number, drawCalls: number): void {
    if (deltaMS <= 0) return;
    const instant = 1000 / deltaMS;
    this.fps = this.fps * (1 - FPS_SMOOTHING) + instant * FPS_SMOOTHING;
    this.drawCallsText.text = `${drawCalls} dc`;
    this.fpsText.text = `${Math.round(this.fps)} fps`;
  }

  private formatNameLine(): string {
    return this.playerName;
  }

  override destroy(): void {
    this.settingsMenu.destroy();
    super.destroy();
  }

  protected override layout(): void {
    this.bg.clear();
    this.bg.rect(0, 0, this.width, this.height).fill({ color: 0x1a1f24 });

    const cy = this.height / 2;
    this.nameText.position.set(PADDING, cy);
    this.settingsText.position.set(this.width - PADDING, cy);
    this.fpsText.position.set(this.settingsText.x - this.settingsText.width - PADDING, cy);
    this.drawCallsText.position.set(this.fpsText.x - this.fpsText.width - PADDING, cy);
  }
}
