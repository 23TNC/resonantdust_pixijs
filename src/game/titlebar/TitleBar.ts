import { Graphics, Text } from "pixi.js";
import { LayoutNode } from "../layout/LayoutNode";

const HEIGHT = 32;
const PADDING = 12;
const FONT_SIZE = 14;
const FPS_SMOOTHING = 0.05;

export class TitleBar extends LayoutNode {
  static readonly HEIGHT = HEIGHT;

  private readonly bg = new Graphics();
  private readonly nameText: Text;
  private readonly drawCallsText: Text;
  private readonly fpsText: Text;
  private fps = 60;
  private readonly playerName: string;
  private playerId: number;
  /** `0` until the soul subscription lands. Re-set via `setSoulCardId`
   *  when `SoulManager` resolves the player's soul card. */
  private soulCardId = 0;

  constructor(playerName: string, playerId: number) {
    super();
    this.playerName = playerName;
    this.playerId = playerId;
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

    this.container.addChild(this.bg);
    this.container.addChild(this.nameText);
    this.container.addChild(this.drawCallsText);
    this.container.addChild(this.fpsText);
  }

  updateStats(deltaMS: number, drawCalls: number): void {
    if (deltaMS <= 0) return;
    const instant = 1000 / deltaMS;
    this.fps = this.fps * (1 - FPS_SMOOTHING) + instant * FPS_SMOOTHING;
    this.drawCallsText.text = `${drawCalls} dc`;
    this.fpsText.text = `${Math.round(this.fps)} fps`;
  }

  /** Update the displayed soul card id (after `SoulManager` resolves
   *  it on first login / lazy migration / character switch). Re-renders
   *  the name line to include the new id alongside the player id. */
  setSoulCardId(soulCardId: number): void {
    if (this.soulCardId === soulCardId) return;
    this.soulCardId = soulCardId;
    this.nameText.text = this.formatNameLine();
  }

  /** Compose the name line: `"<name> p:<player_id> s:<soul_id>"`. Both
   *  ids are appended for spawn-by-id debugging — copy the values
   *  straight into a `bin/st`-style command to target this player or
   *  soul. Soul id reads as `s:0` until the subscription resolves it. */
  private formatNameLine(): string {
    return `${this.playerName} p:${this.playerId} s:${this.soulCardId}`;
  }

  protected override layout(): void {
    this.bg.clear();
    this.bg.rect(0, 0, this.width, this.height).fill({ color: 0x1a1f24 });

    const cy = this.height / 2;
    this.nameText.position.set(PADDING, cy);
    this.fpsText.position.set(this.width - PADDING, cy);
    this.drawCallsText.position.set(this.fpsText.x - this.fpsText.width - PADDING, cy);
  }
}
