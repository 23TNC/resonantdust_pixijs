import { Container, Graphics, Rectangle, Text } from "pixi.js";
import type { GameContext } from "../../GameContext";
import type { LocalCard } from "../../server/data/DataManager";
import { LayoutNode } from "../../game/layout/LayoutNode";
import { LayoutHexCard } from "../../game/cards/layout/hexagon/HexCard";
import { RECT_CARD_HEIGHT, RECT_CARD_WIDTH } from "../../game/cards/layout/rectangle/RectCard";
import { RectCardVisual } from "../../game/cards/layout/rectangle/RectVisual";
import { HexCardVisual } from "../../game/cards/layout/hexagon/HexVisual";
import { GRID_H, GRID_W } from "../../game/inventory/InventoryGame";

const PANEL_BG = 0x121922;
const SELECTION_COLOR = 0xffff00;
const SELECTION_WIDTH = 3;

const BUTTON_HEIGHT = 44;
const BUTTON_PAD = 12;
const BUTTON_BG = 0x3a3a4a;
const BUTTON_BG_DISABLED = 0x222228;
const BUTTON_BG_HOVER = 0x4a4a5a;
const BUTTON_TEXT = 0xecd6aa;
const BUTTON_TEXT_DISABLED = 0x707080;

/** Cap on souls per player. Reached → "Create character" disables.
 *  Visuals in this panel are 1:1 with owned soul cards (since
 *  `subscribeOwnedCards` is filtered to `owner_id == playerId`),
 *  so `visuals.size` is a faithful count without re-walking
 *  `cardsLocal`. Server should enforce the same cap on the
 *  `create_character` reducer; this client gate just avoids
 *  futile round-trips. */
const MAX_SOULS_PER_PLAYER = 5;

/**
 * Read-only grid of every card owned by `ownerId`. Renders each card
 * as a `RectCardVisual` / `HexCardVisual` arranged on the same grid
 * `InventoryGame` uses (`GRID_W` × `GRID_H` cells), independent of
 * the row's positional data — `macroZone` / `microZone` /
 * `microLocation` / `surface` are ignored. Server data is never
 * mutated; the panel only reads `cardsLocal`.
 *
 * Selection: clicking a card highlights it with a yellow outline.
 * `getSelectedCardId()` returns the current selection (or `null`);
 * `onSelectionChange` fires when it shifts so callers (the Play
 * button) can enable / disable.
 *
 * Play button: a bottom-anchored rectangle that fires
 * `onPlay(selectedCardId)` when clicked, gated on having a
 * selection. Disabled visual when nothing is selected.
 */
export class OwnedCardsPanel extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly cardsContainer = new Container();
  private readonly selectionOutline = new Graphics();
  private readonly playButton = new Container();
  private readonly playButtonBg = new Graphics();
  private readonly playButtonLabel: Text;
  private readonly createButton = new Container();
  private readonly createButtonBg = new Graphics();
  private readonly createButtonLabel: Text;
  private readonly visuals = new Map<number, Container>();
  private readonly unsubLocalCard: () => void;
  private readonly gameContext: GameContext;
  private readonly ownerId: number;
  private readonly onPlay: (cardId: number) => void;
  private readonly onCreateCharacter: () => void;
  private readonly onSelectionChange: (cardId: number | null) => void;
  private selectedCardId: number | null = null;
  private playHovered = false;
  private createHovered = false;

  constructor(
    ctx: GameContext,
    ownerId: number,
    onPlay: (cardId: number) => void,
    onCreateCharacter: () => void,
    onSelectionChange: (cardId: number | null) => void,
  ) {
    super();
    this.gameContext = ctx;
    this.ownerId = ownerId;
    this.onPlay = onPlay;
    this.onCreateCharacter = onCreateCharacter;
    this.onSelectionChange = onSelectionChange;

    this.playButtonLabel = new Text({
      text: "Play",
      style: { fill: BUTTON_TEXT, fontFamily: "sans-serif", fontSize: 18, fontWeight: "600" },
    });
    this.playButtonLabel.anchor.set(0.5);
    this.playButton.addChild(this.playButtonBg);
    this.playButton.addChild(this.playButtonLabel);
    this.playButton.eventMode = "static";
    this.playButton.cursor = "pointer";
    this.playButton.on("pointertap", () => {
      if (this.selectedCardId === null) return;
      this.onPlay(this.selectedCardId);
    });
    this.playButton.on("pointerover", () => { this.playHovered = true; this.invalidate(); });
    this.playButton.on("pointerout", () => { this.playHovered = false; this.invalidate(); });

    this.createButtonLabel = new Text({
      text: "Create character",
      style: { fill: BUTTON_TEXT, fontFamily: "sans-serif", fontSize: 18, fontWeight: "600" },
    });
    this.createButtonLabel.anchor.set(0.5);
    this.createButton.addChild(this.createButtonBg);
    this.createButton.addChild(this.createButtonLabel);
    this.createButton.eventMode = "static";
    this.createButton.cursor = "pointer";
    this.createButton.on("pointertap", () => {
      if (this.visuals.size >= MAX_SOULS_PER_PLAYER) return;
      this.onCreateCharacter();
    });
    this.createButton.on("pointerover", () => { this.createHovered = true; this.invalidate(); });
    this.createButton.on("pointerout", () => { this.createHovered = false; this.invalidate(); });

    this.container.addChild(this.bg);
    this.container.addChild(this.cardsContainer);
    this.container.addChild(this.selectionOutline);
    this.container.addChild(this.playButton);
    this.container.addChild(this.createButton);

    // Seed from anything already in cardsLocal — the subscription
    // only fires on diffs from registration forward.
    for (const row of this.gameContext.data.cardsLocal.values()) {
      if (row.ownerId === this.ownerId) this.upsertVisual(row);
    }

    this.unsubLocalCard = this.gameContext.data.subscribeLocalCard((change) => {
      if (change.kind === "removed") {
        this.removeVisual(change.key);
        return;
      }
      const row = change.kind === "added" ? change.row : change.newRow;
      const wasOurs = this.visuals.has(change.key);
      const isOurs = row.ownerId === this.ownerId;
      if (isOurs) {
        this.upsertVisual(row);
      } else if (wasOurs) {
        this.removeVisual(change.key);
      }
    });
  }

  override destroy(): void {
    this.unsubLocalCard();
    for (const visual of this.visuals.values()) {
      visual.destroy({ children: true });
    }
    this.visuals.clear();
    super.destroy();
  }

  /** Build or refresh the visual for a card. The visual is wired
   *  for `pointertap` → selection update; rect vs hex picks the
   *  right visual class. */
  private upsertVisual(row: LocalCard): void {
    const def = row.def ?? this.gameContext.definitions.decode(row.packedDefinition);
    const typeId = (row.packedDefinition >> 12) & 0xf;
    const isHex = this.gameContext.definitions.shape(typeId) === "hex";

    let visual = this.visuals.get(row.cardId);
    if (visual === undefined) {
      visual = isHex ? new HexCardVisual(LayoutHexCard.RADIUS) : new RectCardVisual();
      visual.eventMode = "static";
      visual.cursor = "pointer";
      const cardId = row.cardId;
      visual.on("pointertap", () => this.select(cardId));
      this.cardsContainer.addChild(visual);
      this.visuals.set(row.cardId, visual);
    }
    if (visual instanceof RectCardVisual) {
      visual.draw(def, "top", this.gameContext.definitions.label(row.packedDefinition));
    } else if (visual instanceof HexCardVisual) {
      visual.draw(def);
    }
    this.invalidate();
  }

  private removeVisual(cardId: number): void {
    const visual = this.visuals.get(cardId);
    if (visual === undefined) return;
    this.cardsContainer.removeChild(visual);
    visual.destroy({ children: true });
    this.visuals.delete(cardId);
    if (this.selectedCardId === cardId) {
      this.selectedCardId = null;
      this.onSelectionChange(null);
    }
    this.invalidate();
  }

  private select(cardId: number): void {
    if (this.selectedCardId === cardId) return;
    this.selectedCardId = cardId;
    this.onSelectionChange(cardId);
    this.invalidate();
  }

  protected override layout(): void {
    this.bg.clear().rect(0, 0, this.width, this.height).fill({ color: PANEL_BG });

    // Reserve a strip at the bottom for the two buttons (Play +
    // Create character). The card grid lives above it.
    const buttonTop = this.height - BUTTON_HEIGHT - BUTTON_PAD;
    const gridBottom = buttonTop - BUTTON_PAD;

    // Inventory-style grid: cells are GRID_W × GRID_H, centered
    // horizontally so the leftover margin is split evenly. Cards
    // anchor at the top-left of their cell with a half-pad inset so
    // the visual sits in the cell's interior (matches `InventoryGame`
    // semantics; players see the same cell size and stride here).
    const cellsPerRow = Math.max(1, Math.floor(this.width / GRID_W));
    const usedWidth = cellsPerRow * GRID_W;
    const ox = (this.width - usedWidth) / 2;
    const oy = (gridBottom % GRID_H) / 2 < 4 ? 4 : (gridBottom % GRID_H) / 2;

    let i = 0;
    let selectedVisual: Container | null = null;
    for (const [cardId, visual] of this.visuals) {
      const col = i % cellsPerRow;
      const row = Math.floor(i / cellsPerRow);
      const cellX = ox + col * GRID_W;
      const cellY = oy + row * GRID_H;
      // Center the visual within its cell — rect cards are
      // (RECT_CARD_WIDTH × RECT_CARD_HEIGHT), grid cells are
      // (GRID_W × GRID_H) where GRID_W = RECT_CARD_WIDTH + GRID_PAD.
      const w = visualWidth(visual);
      const h = visualHeight(visual);
      const x = cellX + (GRID_W - w) / 2;
      const y = cellY + (GRID_H - h) / 2;
      visual.position.set(x, y);
      if (cardId === this.selectedCardId) selectedVisual = visual;
      i++;
    }

    // Selection outline — drawn above the cards container so the
    // stroke isn't clipped. Recomputed each layout to track the
    // selected card's current cell.
    this.selectionOutline.clear();
    if (selectedVisual !== null) {
      const w = visualWidth(selectedVisual);
      const h = visualHeight(selectedVisual);
      this.selectionOutline
        .rect(selectedVisual.x - 2, selectedVisual.y - 2, w + 4, h + 4)
        .stroke({ color: SELECTION_COLOR, width: SELECTION_WIDTH });
    }

    // Two buttons split half-and-half at the bottom strip:
    // [Play] [Create character]. Play gates on selection; Create
    // is always enabled (it just opens the create panel).
    const totalButtonsW = Math.max(0, this.width - BUTTON_PAD * 3);
    const halfW = Math.floor(totalButtonsW / 2);
    const playX = BUTTON_PAD;
    const createX = BUTTON_PAD + halfW + BUTTON_PAD;
    this.playButton.position.set(playX, buttonTop);
    this.createButton.position.set(createX, buttonTop);
    this.playButton.hitArea = new Rectangle(0, 0, halfW, BUTTON_HEIGHT);
    this.createButton.hitArea = new Rectangle(0, 0, halfW, BUTTON_HEIGHT);

    const playEnabled = this.selectedCardId !== null;
    const playColor = !playEnabled
      ? BUTTON_BG_DISABLED
      : this.playHovered
        ? BUTTON_BG_HOVER
        : BUTTON_BG;
    this.playButtonBg
      .clear()
      .roundRect(0, 0, halfW, BUTTON_HEIGHT, 4)
      .fill({ color: playColor })
      .stroke({ color: 0x5a5a6a, width: 1 });
    this.playButtonLabel.style.fill = playEnabled ? BUTTON_TEXT : BUTTON_TEXT_DISABLED;
    this.playButtonLabel.position.set(halfW / 2, BUTTON_HEIGHT / 2);

    // Soul cap: visuals.size is the player's current soul count
    // (subscription is owner-id-filtered, so each visual = one
    // soul). At cap, Create disables so the player can't pile up
    // more avatars than the server permits.
    const createEnabled = this.visuals.size < MAX_SOULS_PER_PLAYER;
    const createColor = !createEnabled
      ? BUTTON_BG_DISABLED
      : this.createHovered
        ? BUTTON_BG_HOVER
        : BUTTON_BG;
    this.createButton.cursor = createEnabled ? "pointer" : "not-allowed";
    this.createButtonBg
      .clear()
      .roundRect(0, 0, halfW, BUTTON_HEIGHT, 4)
      .fill({ color: createColor })
      .stroke({ color: 0x5a5a6a, width: 1 });
    this.createButtonLabel.style.fill = createEnabled ? BUTTON_TEXT : BUTTON_TEXT_DISABLED;
    this.createButtonLabel.text = createEnabled
      ? "Create character"
      : `Max ${MAX_SOULS_PER_PLAYER} characters`;
    this.createButtonLabel.position.set(halfW / 2, BUTTON_HEIGHT / 2);
  }
}

function visualWidth(child: Container): number {
  if (child instanceof RectCardVisual) return RECT_CARD_WIDTH;
  if (child instanceof HexCardVisual) return LayoutHexCard.WIDTH;
  return child.width;
}

function visualHeight(child: Container): number {
  if (child instanceof RectCardVisual) return RECT_CARD_HEIGHT;
  if (child instanceof HexCardVisual) return LayoutHexCard.HEIGHT;
  return child.height;
}
