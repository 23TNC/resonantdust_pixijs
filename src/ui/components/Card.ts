import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { LayoutRect } from "@/ui/layout/LayoutRect";
import { getDefinitionByPacked } from "@/data/definitions/CardDefinitions";
import { client_cards, type CardId } from "@/spacetime/Data";

export interface CardOptions {
  texture?: Texture;
  titleHeightRatio?: number;
  cornerRadius?: number;
}

export class Card extends LayoutRect {
  public readonly card_id: CardId;
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
    card_id: CardId,
    options: CardOptions = {},
  ) {
    super(x, y, width, height, 0);

    this.card_id = card_id;

    const definition = this.getDefinition();
    const colors = normalizeCardColors(definition?.style?.color);

    this.name = definition?.name ?? `Card ${card_id}`;
    this.bodyBackgroundColor = colors[0] ?? 0x1f2937;
    this.titleBackgroundColor = colors[1] ?? 0x111827;
    this.titleTextColor = colors[2] ?? 0xf9fafb;
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

  public refreshFromClientCard(): void {
    const definition = this.getDefinition();
    if (!definition) {
      return;
    }

    const colors = normalizeCardColors(definition.style.color);

    this.setName(definition.name);
    this.setColors(
      colors[1] ?? this.titleBackgroundColor,
      colors[2] ?? this.titleTextColor,
      colors[0] ?? this.bodyBackgroundColor,
    );
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

  private getDefinition() {
    const card = client_cards[this.card_id];
    if (!card) {
      return undefined;
    }

    return getDefinitionByPacked(card.definition);
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

function normalizeCardColors(colors: readonly string[] | undefined): number[] {
  if (!colors) {
    return [];
  }

  const normalized: number[] = [];
  for (const rawColor of colors) {
    const parsedColor = parseColorNumber(rawColor);
    if (parsedColor != null) {
      normalized.push(parsedColor);
    }
  }

  return normalized;
}

function parseColorNumber(rawColor: string): number | null {
  const normalizedHex = rawColor.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalizedHex)) {
    return null;
  }

  return Number.parseInt(normalizedHex, 16);
}
