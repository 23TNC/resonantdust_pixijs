import { Container, Graphics, Rectangle, Text } from "pixi.js";
import type { GameContext } from "../../../GameContext";
import type { CardDefinition, StarterPack } from "../../../game/definitions/DefinitionManager";
import { LayoutNode } from "../../../game/layout/LayoutNode";
import {
  RECT_CARD_HEIGHT,
  RECT_CARD_WIDTH,
} from "../../../game/cards/layout/rectangle/RectCard";
import { CardFace } from "../../../game/cards/CardFace";
import { getTextureRegistry } from "../../../game/definitions/TextureRegistry";

const PANEL_BG = 0x121922;
const SELECTION_COLOR = 0xffff00;
const SELECTION_WIDTH = 3;
const HEADER_HEIGHT = 28;
const HEADER_GAP = 8;
const SOUL_GAP = 24;
const CARD_GAP = 12;
const PANEL_INSET = 20;

const BUTTON_HEIGHT = 44;
const BUTTON_PAD = 12;
const BUTTON_BG = 0x3a3a4a;
const BUTTON_BG_DISABLED = 0x222228;
const BUTTON_BG_HOVER = 0x4a4a5a;
const BUTTON_TEXT = 0xecd6aa;
const BUTTON_TEXT_DISABLED = 0x707080;

interface SoulGroup {
  soul: string;
  /** Visual representing each pack in this group, in registry-id order. */
  packs: {
    pack: StarterPack;
    visual: CardFace;
  }[];
  header: Text;
}

/**
 * Left-panel pack chooser for character creation. Renders each
 * starter pack as a single rect card, with the pack's sub-category
 * (`packId`, e.g. `"default"`) as the card's title. Packs are
 * grouped under per-soul headers (e.g. "Human"); selecting a card
 * fires `onSelect(pack)`.
 *
 * Card style is inherited from the soul's card definition — the
 * pack card looks like the soul itself but with a custom title —
 * so a "human:default" card visually echoes the human soul. This
 * keeps pack identity tied to its soul without needing a custom
 * visual.
 *
 * Today only the `"human"` soul ships starter packs. A future
 * multi-species character creator would pass a list of soul keys
 * to enumerate; for now it's hard-coded.
 *
 * Selection state lives on the parent layout; this panel just
 * highlights whatever `setSelectedPackId(id)` says.
 */
export class PackChooserPanel extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly selectionOutline = new Graphics();
  private readonly groupsContainer = new Container();
  private readonly createButton = new Container();
  private readonly createButtonBg = new Graphics();
  private readonly createButtonLabel: Text;
  private readonly backButton = new Container();
  private readonly backButtonBg = new Graphics();
  private readonly backButtonLabel: Text;
  private readonly groups: SoulGroup[] = [];
  /** Cleanup for the `cardTextures.onArtLoad` listener — soul
   *  portraits are preloaded, but the listener still guards the
   *  preview against any sprite that lands mid-session. Redraws
   *  every pack card from its synthesized soul def. */
  private readonly unsubArtLoad: () => void;
  private readonly gameContext: GameContext;
  private readonly onSelect: (pack: StarterPack) => void;
  private readonly onCreate: (pack: StarterPack) => void;
  private readonly onBack: () => void;
  private selectedPackId: number | null = null;
  private createHovered = false;
  private backHovered = false;

  constructor(
    ctx: GameContext,
    souls: readonly string[],
    onSelect: (pack: StarterPack) => void,
    onCreate: (pack: StarterPack) => void,
    onBack: () => void,
  ) {
    super();
    this.gameContext = ctx;
    this.onSelect = onSelect;
    this.onCreate = onCreate;
    this.onBack = onBack;

    this.createButtonLabel = new Text({
      text: "Create",
      style: { fill: BUTTON_TEXT, fontFamily: "sans-serif", fontSize: 18, fontWeight: "600" },
    });
    this.createButtonLabel.anchor.set(0.5);
    this.createButton.addChild(this.createButtonBg);
    this.createButton.addChild(this.createButtonLabel);
    this.createButton.eventMode = "static";
    this.createButton.cursor = "pointer";
    this.createButton.on("pointertap", () => {
      const pack = this.selectedPack();
      if (pack !== null) this.onCreate(pack);
    });
    this.createButton.on("pointerover", () => { this.createHovered = true; this.invalidate(); });
    this.createButton.on("pointerout", () => { this.createHovered = false; this.invalidate(); });

    this.backButtonLabel = new Text({
      text: "Back",
      style: { fill: BUTTON_TEXT, fontFamily: "sans-serif", fontSize: 18, fontWeight: "600" },
    });
    this.backButtonLabel.anchor.set(0.5);
    this.backButton.addChild(this.backButtonBg);
    this.backButton.addChild(this.backButtonLabel);
    this.backButton.eventMode = "static";
    this.backButton.cursor = "pointer";
    this.backButton.on("pointertap", () => this.onBack());
    this.backButton.on("pointerover", () => { this.backHovered = true; this.invalidate(); });
    this.backButton.on("pointerout", () => { this.backHovered = false; this.invalidate(); });

    this.container.addChild(this.bg);
    this.container.addChild(this.groupsContainer);
    this.container.addChild(this.selectionOutline);
    this.container.addChild(this.createButton);
    this.container.addChild(this.backButton);

    for (const soul of souls) {
      this.buildGroup(soul);
    }

    this.unsubArtLoad = ctx.lodTextures.onLoad(() => {
      // Redraw every pack card. The synthesized `packCardDef`
      // carries the soul def's `object`, so a soul-portrait load
      // flips the cards from "art hidden" to "art shown".
      for (const group of this.groups) {
        const soulDef = this.resolveSoulDef(group.soul);
        for (const { pack, visual } of group.packs) {
          visual.draw(
            packCardDef(soulDef, pack.packId),
            "top",
            undefined,
            {
              lodTextures: this.gameContext.lodTextures,
              textureRegistry: getTextureRegistry(),
              // Stable per-pack id — preview cards stay consistent
              // across redraws.
              seed: pack.id,
            },
          );
        }
      }
    });
  }

  private selectedPack(): StarterPack | null {
    if (this.selectedPackId === null) return null;
    for (const g of this.groups) {
      for (const p of g.packs) {
        if (p.pack.id === this.selectedPackId) return p.pack;
      }
    }
    return null;
  }

  override destroy(): void {
    this.unsubArtLoad();
    for (const group of this.groups) {
      for (const { visual } of group.packs) {
        visual.destroy({ children: true });
      }
      group.header.destroy();
    }
    this.groups.length = 0;
    super.destroy();
  }

  /** Set the externally-tracked selected pack id (the layout owns
   *  the state since both panels need to read it). Re-renders to
   *  move the highlight; no event fires. */
  setSelectedPackId(packId: number | null): void {
    if (this.selectedPackId === packId) return;
    this.selectedPackId = packId;
    this.invalidate();
  }

  /** Build one soul's header + a card per pack. Packs come from
   *  `definitions.starterPacksForSoul(soul)`; unknown souls yield
   *  an empty group (header still rendered so the player knows
   *  there's nothing to pick — a UX prompt to author packs for
   *  that soul). */
  private buildGroup(soul: string): void {
    const header = new Text({
      text: titleCase(soul),
      style: {
        fill: 0xecd6aa,
        fontFamily: "sans-serif",
        fontSize: 18,
        fontWeight: "700",
      },
    });
    this.groupsContainer.addChild(header);

    const packs = this.gameContext.definitions.starterPacksForSoul(soul);
    const soulDef = this.resolveSoulDef(soul);
    const visuals: SoulGroup["packs"] = [];
    for (const pack of packs) {
      const visual = new CardFace();
      // Pack card inherits the soul's style + object but takes the
      // pack id as its title (`packCardDef` swaps the `key`).
      // Per-pack seed so each card reads as the *same* portrait
      // across re-layouts; the `onLoad` listener below redraws
      // once any pack finishes lazy-loading.
      visual.draw(
        packCardDef(soulDef, pack.packId),
        "top",
        undefined,
        {
          lodTextures: this.gameContext.lodTextures,
          textureRegistry: getTextureRegistry(),
          seed: pack.id,
        },
      );
      visual.eventMode = "static";
      visual.cursor = "pointer";
      const packRef = pack;
      visual.on("pointertap", () => {
        this.onSelect(packRef);
      });
      this.groupsContainer.addChild(visual);
      visuals.push({ pack, visual });
    }

    this.groups.push({ soul, header, packs: visuals });
  }

  private resolveSoulDef(soul: string): CardDefinition | null {
    const packed = this.gameContext.definitions.findPackedByKey(soul);
    if (packed === undefined) return null;
    return this.gameContext.definitions.decode(packed);
  }

  protected override layout(): void {
    this.bg.clear().rect(0, 0, this.width, this.height).fill({ color: PANEL_BG });

    // Per-group block: header text at the left, then a horizontal
    // row of pack cards wrapping to the next line when out of
    // width. Groups stack vertically with `SOUL_GAP` padding.
    const innerLeft = PANEL_INSET;
    const innerWidth = Math.max(0, this.width - PANEL_INSET * 2);
    const cellW = RECT_CARD_WIDTH + CARD_GAP;
    const cellH = RECT_CARD_HEIGHT + CARD_GAP;
    const cellsPerRow = Math.max(1, Math.floor(innerWidth / cellW));

    let cursorY = PANEL_INSET;
    let selectedVisual: CardFace | null = null;
    for (const group of this.groups) {
      group.header.position.set(innerLeft, cursorY);
      cursorY += HEADER_HEIGHT + HEADER_GAP;

      let i = 0;
      const rowStart = cursorY;
      for (const { pack, visual } of group.packs) {
        const col = i % cellsPerRow;
        const row = Math.floor(i / cellsPerRow);
        const x = innerLeft + col * cellW;
        const y = rowStart + row * cellH;
        visual.position.set(x, y);
        if (pack.id === this.selectedPackId) selectedVisual = visual;
        i++;
      }
      const rows = Math.max(1, Math.ceil(group.packs.length / cellsPerRow));
      cursorY = rowStart + rows * cellH + SOUL_GAP - CARD_GAP;
    }

    // Selection outline — yellow stroke around the picked pack card.
    this.selectionOutline.clear();
    if (selectedVisual !== null) {
      this.selectionOutline
        .rect(
          selectedVisual.x - 2,
          selectedVisual.y - 2,
          RECT_CARD_WIDTH + 4,
          RECT_CARD_HEIGHT + 4,
        )
        .stroke({ color: SELECTION_COLOR, width: SELECTION_WIDTH });
    }

    // Two-button strip at the bottom: [Create] [Back]. Mirrors the
    // OwnedCardsPanel layout so the player sees buttons in the same
    // place across modes.
    const buttonTop = this.height - BUTTON_HEIGHT - BUTTON_PAD;
    const totalButtonsW = Math.max(0, this.width - BUTTON_PAD * 3);
    const halfW = Math.floor(totalButtonsW / 2);
    this.createButton.position.set(BUTTON_PAD, buttonTop);
    this.backButton.position.set(BUTTON_PAD + halfW + BUTTON_PAD, buttonTop);
    this.createButton.hitArea = new Rectangle(0, 0, halfW, BUTTON_HEIGHT);
    this.backButton.hitArea = new Rectangle(0, 0, halfW, BUTTON_HEIGHT);

    const createEnabled = this.selectedPackId !== null;
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
    this.createButtonLabel.position.set(halfW / 2, BUTTON_HEIGHT / 2);

    const backColor = this.backHovered ? BUTTON_BG_HOVER : BUTTON_BG;
    this.backButtonBg
      .clear()
      .roundRect(0, 0, halfW, BUTTON_HEIGHT, 4)
      .fill({ color: backColor })
      .stroke({ color: 0x5a5a6a, width: 1 });
    this.backButtonLabel.position.set(halfW / 2, BUTTON_HEIGHT / 2);
  }
}

/** Build a fake `CardDefinition` for rendering a pack card. The
 *  card inherits the soul's style + color palette (so a
 *  "human:default" card looks like the human soul) but swaps the
 *  display name to the pack's sub-category id (e.g. `"default"`).
 *  Aspects / flags / traits are zeroed since they're not read by
 *  the visual.
 *
 *  Falls back to a neutral gray style + the pack id as the name
 *  when the soul def is missing — covers the registry-build-error
 *  case and the "author declared a pack for a soul that doesn't
 *  exist" case (which `find_starter_pack` rejects at build time,
 *  but defending here keeps the panel honest). */
function packCardDef(soulDef: CardDefinition | null, packId: string): CardDefinition {
  if (soulDef === null) {
    return {
      cardType: 0,
      definitionId: 0,
      key: packId,
      style: ["#3a3a4a", "#7a7a8a", "#ecd6aa"] as const,
      aspects: [],
      flags: 0,
      stock: [],
    };
  }
  return {
    ...soulDef,
    key: packId,
  };
}

/** Capitalize the first letter of `s`. `"default"` → `"Default"`,
 *  `"human"` → `"Human"`. Cheap stand-in for an i18n display
 *  helper. */
function titleCase(s: string): string {
  if (s.length === 0) return s;
  return s[0].toUpperCase() + s.slice(1);
}

