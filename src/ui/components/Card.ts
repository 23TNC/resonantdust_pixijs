import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { LayoutRect } from "@/ui/layout/LayoutRect";

export interface CardOptions {
  name: string;
  titleBackgroundColor: number;
  titleTextColor: number;
  bodyBackgroundColor: number;
  texture?: Texture;
  titleHeightRatio?: number;
  cornerRadius?: number;
}

export class Card extends LayoutRect {
  public name: string;
  public titleBackgroundColor: number;
  public titleTextColor: number;
  public bodyBackgroundColor: number;

  private titleHeightRatio: number;
  private cornerRadius: number;

  private titleGraphics = new Graphics();
  private bodyGraphics = new Graphics();
  private titleText: Text;
  private spriteContainer = new Container();
  private sprite: Sprite | null = null;

  public constructor(
    x: number,
    y: number,
    width: number,
    height: number,
    options: CardOptions,
  ) {
    super(x, y, width, height, 0);

    this.name = options.name;
    this.titleBackgroundColor = options.titleBackgroundColor;
    this.titleTextColor = options.titleTextColor;
    this.bodyBackgroundColor = options.bodyBackgroundColor;
    this.titleHeightRatio = options.titleHeightRatio ?? 0.22;
    this.cornerRadius = options.cornerRadius ?? 8;

    this.titleText = new Text({
      text: this.name,
      style: {
        fill: this.titleTextColor,
        fontFamily: "Segoe UI",
        fontSize: 14,
        fontWeight: "700",
        align: "center",
      },
    });

    this.addChild(this.bodyGraphics);
    this.addChild(this.titleGraphics);
    this.addChild(this.spriteContainer);
    this.addChild(this.titleText);

    if (options.texture) {
      this.setTexture(options.texture);
    }

    this.redrawCard();
  }

  public override updateRects(): void {
    super.updateRects();
    this.redrawCard();
  }

  public setName(name: string): void {
    this.name = name;
    this.titleText.text = name;
    this.redrawCard();
  }

  public setColors(
    titleBackgroundColor: number,
    titleTextColor: number,
    bodyBackgroundColor: number,
  ): void {
    this.titleBackgroundColor = titleBackgroundColor;
    this.titleTextColor = titleTextColor;
    this.bodyBackgroundColor = bodyBackgroundColor;
    this.titleText.style.fill = titleTextColor;
    this.redrawCard();
  }

  public setTexture(texture: Texture | null): void {
    this.sprite?.destroy();
    this.sprite = null;

    if (!texture) {
      return;
    }

    this.sprite = new Sprite(texture);
    this.sprite.anchor.set(0.5);
    this.spriteContainer.addChild(this.sprite);
    this.redrawCard();
  }

  private redrawCard(): void {
    if (!this.titleText) {
      return;
    }

    const x = this.innerRect.x;
    const y = this.innerRect.y;
    const width = this.innerRect.width;
    const height = this.innerRect.height;

    const titleHeight = Math.max(0, height * this.titleHeightRatio);
    const bodyY = y + titleHeight;
    const bodyHeight = Math.max(0, height - titleHeight);
    const radius = Math.min(this.cornerRadius, width / 2, height / 2);

    this.drawTitle(x, y, width, titleHeight, radius);
    this.drawBody(x, bodyY, width, bodyHeight, radius);
    this.layoutTitleText(x, y, width, titleHeight);
    this.layoutSprite(x, bodyY, width, bodyHeight);
  }

  private drawTitle(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void {
    this.titleGraphics.clear();

    if (width <= 0 || height <= 0) {
      return;
    }

    this.titleGraphics
      .roundRect(x, y, width, height + radius, radius)
      .fill(this.titleBackgroundColor)
      .rect(x, y + height, width, radius)
      .fill(this.titleBackgroundColor);
  }

  private drawBody(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void {
    this.bodyGraphics.clear();

    if (width <= 0 || height <= 0) {
      return;
    }

    this.bodyGraphics
      .roundRect(x, y - radius, width, height + radius, radius)
      .fill(this.bodyBackgroundColor)
      .rect(x, y - radius, width, radius)
      .fill(this.bodyBackgroundColor);
  }

  private layoutTitleText(
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const fontSize = Math.max(8, Math.round(height * 0.42));
    this.titleText.style.fontSize = fontSize;

    this.titleText.anchor.set(0.5);
    this.titleText.x = x + width / 2;
    this.titleText.y = y + height / 2;

    const maxWidth = Math.max(0, width * 0.92);
    if (this.titleText.width > maxWidth && this.titleText.width > 0) {
      this.titleText.scale.set(maxWidth / this.titleText.width);
    } else {
      this.titleText.scale.set(1);
    }
  }

  private layoutSprite(
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    this.spriteContainer.x = x + width / 2;
    this.spriteContainer.y = y + height / 2;

    if (!this.sprite) {
      return;
    }

    const maxSize = Math.max(0, Math.min(width, height) * 0.85);
    const textureWidth = this.sprite.texture.width;
    const textureHeight = this.sprite.texture.height;
    const textureSize = Math.max(textureWidth, textureHeight);

    if (textureSize <= 0 || maxSize <= 0) {
      this.sprite.visible = false;
      return;
    }

    this.sprite.visible = true;
    this.sprite.scale.set(maxSize / textureSize);
    this.sprite.x = 0;
    this.sprite.y = 0;
  }
}
