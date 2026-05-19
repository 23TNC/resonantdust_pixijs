import { Container, Graphics, Sprite, Text } from "pixi.js";
import type { GameContext } from "../../GameContext";
import type { CardDefinition, StarterPack } from "../../game/definitions/DefinitionManager";
import { LayoutNode } from "../../game/layout/LayoutNode";
import { LayoutHexCard } from "../../game/cards/layout/hexagon/HexCard";
import {
  RECT_CARD_HEIGHT,
  RECT_CARD_TITLE_HEIGHT,
  RECT_CARD_WIDTH,
} from "../../game/cards/layout/rectangle/RectCard";
import { RectCardVisual } from "../../game/cards/layout/rectangle/RectVisual";
import { HexCardVisual } from "../../game/cards/layout/hexagon/HexVisual";
import { GRID_H, GRID_W } from "../../game/inventory/InventoryGame";

const PANEL_BG = 0x0e1218;
const SECTION_LABEL_COLOR = 0xa0a0b0;
const SECTION_GAP = 16;
const SECTION_INSET = 16;

/**
 * Left-panel preview for the currently-selected starter pack.
 * Pure display — no buttons, no selection. The pack chooser on the
 * right owns "which pack is selected" and pushes it into this
 * panel via `setPack(pack)`.
 *
 * Three vertically-stacked sections:
 *
 * 1. **Soul** — the soul card itself (e.g. the human soul),
 *    labeled "Soul: Human".
 * 2. **Contents** — the cards the pack grants, one visual per
 *    copy (so "1 axe + 3 corpus" renders as four card visuals).
 * 3. **Blueprints** — one card per blueprint the soul grants on
 *    character creation, sourced from
 *    `definitions.starterBlueprintsForSoul(pack.soul)`. The list
 *    is per-soul (not per-pack), so two packs sharing a soul
 *    show the same blueprints. Section is hidden if the soul
 *    declares none.
 *
 * Mirrors `SoulInventoryPanel`'s placeholder pattern when no pack
 * is selected — keeps the panel readable rather than blank.
 */
export class PackContentsPanel extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly soulSection = new Container();
  private readonly soulLabel: Text;
  private readonly contentsSection = new Container();
  private readonly contentsLabel: Text;
  private readonly blueprintsSection = new Container();
  private readonly blueprintsLabel: Text;
  private readonly placeholder: Text;
  private readonly gameContext: GameContext;
  private pack: StarterPack | null = null;
  private soulVisual: RectCardVisual | HexCardVisual | null = null;
  private contentsVisuals: Container[] = [];
  private blueprintsVisuals: Container[] = [];

  constructor(ctx: GameContext) {
    super();
    this.gameContext = ctx;

    this.soulLabel = new Text({
      text: "Soul",
      style: { fill: SECTION_LABEL_COLOR, fontFamily: "sans-serif", fontSize: 14, fontWeight: "600" },
    });
    this.contentsLabel = new Text({
      text: "Contents",
      style: { fill: SECTION_LABEL_COLOR, fontFamily: "sans-serif", fontSize: 14, fontWeight: "600" },
    });
    this.blueprintsLabel = new Text({
      text: "Blueprints",
      style: { fill: SECTION_LABEL_COLOR, fontFamily: "sans-serif", fontSize: 14, fontWeight: "600" },
    });
    this.placeholder = new Text({
      text: "Pick a starter pack on the right.",
      style: { fill: SECTION_LABEL_COLOR, fontFamily: "sans-serif", fontSize: 14 },
    });
    this.placeholder.anchor.set(0.5);

    this.soulSection.addChild(this.soulLabel);
    this.contentsSection.addChild(this.contentsLabel);
    this.blueprintsSection.addChild(this.blueprintsLabel);

    this.container.addChild(this.bg);
    this.container.addChild(this.placeholder);
    this.container.addChild(this.soulSection);
    this.container.addChild(this.contentsSection);
    this.container.addChild(this.blueprintsSection);
  }

  override destroy(): void {
    this.clearVisuals();
    super.destroy();
  }

  /** Swap the pack being previewed. Tears down the old visuals
   *  and builds fresh ones from the new pack's `soul` key +
   *  `contents` list. `null` clears the panel back to the
   *  placeholder. */
  setPack(pack: StarterPack | null): void {
    if (this.pack === pack) return;
    this.pack = pack;
    this.clearVisuals();
    if (pack !== null) {
      this.buildVisuals(pack);
    }
    this.invalidate();
  }

  private clearVisuals(): void {
    if (this.soulVisual !== null) {
      this.soulSection.removeChild(this.soulVisual);
      this.soulVisual.destroy({ children: true });
      this.soulVisual = null;
    }
    for (const visual of this.contentsVisuals) {
      this.contentsSection.removeChild(visual);
      visual.destroy({ children: true });
    }
    this.contentsVisuals.length = 0;
    for (const visual of this.blueprintsVisuals) {
      this.blueprintsSection.removeChild(visual);
      visual.destroy({ children: true });
    }
    this.blueprintsVisuals.length = 0;
  }

  private buildVisuals(pack: StarterPack): void {
    const soulPacked = this.gameContext.definitions.findPackedByKey(pack.soul);
    const soulDef: CardDefinition | null = soulPacked === undefined
      ? null
      : this.gameContext.definitions.decode(soulPacked);
    if (soulDef !== null) {
      const isHex = this.gameContext.definitions.shape(soulDef.cardType) === "hex";
      const visual = isHex
        ? new HexCardVisual(LayoutHexCard.RADIUS)
        : new RectCardVisual();
      if (visual instanceof RectCardVisual) {
        const label = soulPacked !== undefined ? this.gameContext.definitions.label(soulPacked) : undefined;
        visual.draw(soulDef, "top", label);
      } else if (visual instanceof HexCardVisual) {
        visual.draw(soulDef);
      }
      this.soulSection.addChild(visual);
      this.soulVisual = visual;
    }
    this.soulLabel.text = `Soul: ${titleCase(pack.soul)}`;

    for (const item of pack.contents) {
      const def = this.gameContext.definitions.decode(item.packedDefinition);
      const typeId = (item.packedDefinition >> 12) & 0xf;
      const isHex = this.gameContext.definitions.shape(typeId) === "hex";
      for (let i = 0; i < item.count; i++) {
        const visual = isHex
          ? new HexCardVisual(LayoutHexCard.RADIUS)
          : new RectCardVisual();
        if (visual instanceof RectCardVisual) {
          visual.draw(def, "top", this.gameContext.definitions.label(item.packedDefinition));
        } else if (visual instanceof HexCardVisual) {
          visual.draw(def);
        }
        this.contentsSection.addChild(visual);
        this.contentsVisuals.push(visual);
      }
    }

    // Blueprints: per-soul list, same card-visual style as the
    // contents grid. Each blueprint's target card is decoded from
    // `cardPackedDefinition` (resolved at registry-build time from
    // the blueprint's `card_id` field).
    const blueprintIds = this.gameContext.definitions.starterBlueprintsForSoul(pack.soul);
    for (const bpId of blueprintIds) {
      const bp = this.gameContext.definitions.blueprintById(bpId);
      if (bp === null) continue;
      // Draw the *blueprint* card — same visual the wrench panel
      // shows once the blueprint is discovered. The output card
      // (`cardPackedDefinition`) is what the build action produces;
      // it's not the right visual for the catalog preview.
      const packed = bp.blueprintPackedDefinition;
      const def = this.gameContext.definitions.decode(packed);
      const typeId = (packed >> 12) & 0xf;
      const isHex = this.gameContext.definitions.shape(typeId) === "hex";
      const visual = isHex
        ? new HexCardVisual(LayoutHexCard.RADIUS)
        : new RectCardVisual();
      if (visual instanceof RectCardVisual) {
        visual.draw(def, "top", this.gameContext.definitions.label(packed));
      } else if (visual instanceof HexCardVisual) {
        visual.draw(def);
      }
      // Card-art overlay — same anchor-centred + body-fraction sizing
      // `RectCard.applyCardArt` uses in-world. Parented to the visual
      // so it's destroyed alongside it in `clearVisuals`. Skipped
      // silently if the sprite isn't loaded yet (preload covers
      // non-tile sprites by login; this preview only renders after
      // the user picks a soul, well past that).
      if (visual instanceof RectCardVisual && def?.sprite) {
        const artTex = this.gameContext.cardTextures.getCardArt(def.sprite);
        if (artTex !== null) {
          const art = new Sprite(artTex);
          art.anchor.set(0.5, 0.5);
          const bodyHeight = RECT_CARD_HEIGHT - RECT_CARD_TITLE_HEIGHT;
          const target = 0.85 * Math.min(RECT_CARD_WIDTH, bodyHeight);
          const scale = target / Math.max(artTex.width, artTex.height);
          art.scale.set(scale);
          art.position.set(RECT_CARD_WIDTH / 2, RECT_CARD_TITLE_HEIGHT + bodyHeight / 2);
          visual.addChild(art);
        }
      }
      this.blueprintsSection.addChild(visual);
      this.blueprintsVisuals.push(visual);
    }
  }

  protected override layout(): void {
    this.bg.clear().rect(0, 0, this.width, this.height).fill({ color: PANEL_BG });

    if (this.pack === null) {
      this.placeholder.visible = true;
      this.soulSection.visible = false;
      this.contentsSection.visible = false;
      this.placeholder.position.set(this.width / 2, this.height / 2);
      return;
    }

    this.placeholder.visible = false;
    this.soulSection.visible = true;
    this.contentsSection.visible = true;
    this.blueprintsSection.visible = this.blueprintsVisuals.length > 0;

    // Soul section at top — label, then the soul card visual below.
    this.soulSection.position.set(0, SECTION_INSET);
    this.soulLabel.position.set(SECTION_INSET, 0);
    const soulSectionBottom = (() => {
      if (this.soulVisual === null) return this.soulLabel.height;
      this.soulVisual.position.set(SECTION_INSET, this.soulLabel.height + 6);
      return this.soulLabel.height + 6 + visualHeight(this.soulVisual);
    })();

    // Contents section below — label then a wrapping grid of
    // visuals using the same GRID_W/GRID_H cells as the inventory.
    const contentsTop = SECTION_INSET + soulSectionBottom + SECTION_GAP;
    this.contentsSection.position.set(0, contentsTop);
    this.contentsLabel.position.set(SECTION_INSET, 0);

    const innerWidth = Math.max(0, this.width - SECTION_INSET * 2);
    const cellsPerRow = Math.max(1, Math.floor(innerWidth / GRID_W));
    const contentsCardsTop = this.contentsLabel.height + 6;
    const contentsRows = Math.ceil(this.contentsVisuals.length / cellsPerRow);
    for (let i = 0; i < this.contentsVisuals.length; i++) {
      const visual = this.contentsVisuals[i];
      const col = i % cellsPerRow;
      const row = Math.floor(i / cellsPerRow);
      const cellX = SECTION_INSET + col * GRID_W;
      const cellY = contentsCardsTop + row * GRID_H;
      const w = visualWidth(visual);
      const h = visualHeight(visual);
      visual.position.set(cellX + (GRID_W - w) / 2, cellY + (GRID_H - h) / 2);
    }
    const contentsHeight = contentsCardsTop + contentsRows * GRID_H;

    // Blueprints section under contents — same wrapping grid. Only
    // laid out when there are entries (otherwise the section is
    // hidden above and we'd be positioning an invisible label).
    if (this.blueprintsVisuals.length > 0) {
      const blueprintsTop = contentsTop + contentsHeight + SECTION_GAP;
      this.blueprintsSection.position.set(0, blueprintsTop);
      this.blueprintsLabel.position.set(SECTION_INSET, 0);
      const blueprintsCardsTop = this.blueprintsLabel.height + 6;
      for (let i = 0; i < this.blueprintsVisuals.length; i++) {
        const visual = this.blueprintsVisuals[i];
        const col = i % cellsPerRow;
        const row = Math.floor(i / cellsPerRow);
        const cellX = SECTION_INSET + col * GRID_W;
        const cellY = blueprintsCardsTop + row * GRID_H;
        const w = visualWidth(visual);
        const h = visualHeight(visual);
        visual.position.set(cellX + (GRID_W - w) / 2, cellY + (GRID_H - h) / 2);
      }
    }
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

function titleCase(s: string): string {
  if (s.length === 0) return s;
  return s[0].toUpperCase() + s.slice(1);
}
