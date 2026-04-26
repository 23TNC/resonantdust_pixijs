import { Card } from "./Card"
import { LayoutRect } from "@/ui/layout";

export class CardStack extends LayoutRect {
  private cards: Card[] = [];

  public setCards(cards: Card[]): void {
    this.cards = cards;

    this.removeChildren();
    for (const card of cards) {
      this.addLayoutChild(card);
    }

    this.invalidateLayout();
  }

  protected override layoutChildren(): void {
    const { x, y, width, height } = this.innerRect;

    const offsetY = 10; // stack spacing

    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i];

      card.setLayout(
        x,
        y + i * offsetY,
        width,
        height
      );
    }
  }
}