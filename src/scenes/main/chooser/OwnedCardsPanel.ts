import { Container, Graphics, Rectangle, Text, type FederatedPointerEvent } from "pixi.js";
import type { GameContext } from "../../../GameContext";
import type { LocalCard } from "../../../server/data/DataManager";
import { LayoutNode } from "../../../game/layout/LayoutNode";
import { CardFace } from "../../../game/cards/CardFace";
import { GameViewPanel } from "../../../game/world/GameViewPanel";
import { LayoutHexCard } from "../../../game/cards/layout/hexagon/HexCard";
import { HexCardVisual } from "../../../game/cards/layout/hexagon/HexVisual";
import { getTextureRegistry } from "../../../game/definitions/TextureRegistry";
import { RECT_CARD_TITLE_HEIGHT, RECT_CARD_WIDTH } from "../../../game/cards/layout/rectangle/RectCard";
import { GRID_H, GRID_W } from "../../../game/inventory/InventoryGame";
import { unpackMacroZone, unpackMicroZone } from "../../../server/data/packing";

/** Card-type id for soul cards. Mirrors `content/cards/types.json`
 *  — kept inline here to avoid an async definitions-registry round
 *  trip just for the eye-button visibility check. */
const SOUL_CARD_TYPE = 6;

/** Eye-button visuals: a small `👁` glyph in the top-right of each
 *  soul card. Pressing it jumps the most-recently-focused
 *  GameViewPanel to wherever the soul currently is. */
const EYE_SIZE = 22;
const EYE_PAD = 4;

const PANEL_BG = 0x121922;
const SELECTION_COLOR = 0xffff00;
const SELECTION_WIDTH = 3;

const BUTTON_PAD = 12;
const BUTTON_BG = 0x3a3a4a;
const BUTTON_BG_HOVER = 0x4a4a5a;
const BUTTON_TEXT = 0xecd6aa;

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
 * `onSelectionChange` fires when the active soul changes — the
 * MainLayout owner uses it to drive per-soul side panels (inventory
 * open + active-soul activation). Navigation to the soul's tile is
 * handled by the 👁 button on each soul card (see `makeEyeButton`),
 * not a separate Play button.
 */
export class OwnedCardsPanel extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly cardsContainer = new Container();
  private readonly selectionOutline = new Graphics();
  /** Card-shaped affordance that opens the character-create flow.
   *  Sits at the end of the visuals grid (after every owned soul).
   *  Replaces the legacy "Create character" button. */
  private readonly createCard = new Container();
  private readonly createCardBg = new Graphics();
  private readonly createCardLabel: Text;
  private readonly visuals = new Map<number, Container>();
  private readonly unsubLocalCard: () => void;
  /** Tear-down for the `ctx.souls.on` subscription. The chooser's
   *  yellow selection highlight tracks the active soul rather than
   *  a separate tap-driven selection state, so the outline jumps
   *  automatically whenever active soul changes (chooser tap,
   *  inventory focus, soul card click in the game view, drag-start
   *  on any owned card, etc.). */
  private readonly unsubActiveSoul: () => void;
  /** Tear-down for the `cardTextures.onArtLoad` listener. Soul
   *  portraits (and any other sprite under `/textures/cards/soul/` or
   *  `/tiles/`) may not have loaded by the time we first render —
   *  the listener re-`draw`s every rect visual once a sprite
   *  arrives so the gallery picks up the texture. */
  private readonly unsubArtLoad: () => void;
  private readonly gameContext: GameContext;
  private readonly ownerId: number;
  private readonly onCreateCharacter: () => void;
  private readonly onSelectionChange: (cardId: number | null) => void;
  private selectedCardId: number | null = null;
  private createHovered = false;

  constructor(
    ctx: GameContext,
    ownerId: number,
    onCreateCharacter: () => void,
    onSelectionChange: (cardId: number | null) => void,
  ) {
    super();
    this.gameContext = ctx;
    this.ownerId = ownerId;
    this.onCreateCharacter = onCreateCharacter;
    this.onSelectionChange = onSelectionChange;

    // Card-sized "+" tile. Lives inside `cardsContainer` so it
    // tiles in the grid alongside the owned-soul visuals; layout()
    // positions it at the slot after the last soul card.
    this.createCardLabel = new Text({
      text: "+",
      style: { fill: BUTTON_TEXT, fontFamily: "sans-serif", fontSize: 64, fontWeight: "600" },
    });
    this.createCardLabel.anchor.set(0.5);
    this.createCard.addChild(this.createCardBg);
    this.createCard.addChild(this.createCardLabel);
    this.createCard.eventMode = "static";
    this.createCard.cursor = "pointer";
    this.createCard.on("pointertap", () => {
      if (this.visuals.size >= MAX_SOULS_PER_PLAYER) return;
      this.onCreateCharacter();
    });
    this.createCard.on("pointerover", () => { this.createHovered = true; this.invalidate(); });
    this.createCard.on("pointerout",  () => { this.createHovered = false; this.invalidate(); });

    this.container.addChild(this.bg);
    this.container.addChild(this.cardsContainer);
    this.cardsContainer.addChild(this.createCard);
    this.container.addChild(this.selectionOutline);

    // Seed from anything already in cardsLocal — the subscription
    // only fires on diffs from registration forward. Deduplicate by
    // cardId so each card appears at most once even if cardsLocal is
    // iterated while a concurrent subscription push is in flight.
    // Soul-only filter: `subscribeOwnedCards(playerId)` pulls every
    // card whose `owner_id == playerId` — that includes player-
    // inventory items (e.g. the starter dust card) which carry
    // `FLAG_OWNED_BY_PLAYER`. The chooser is the character-select
    // surface, so non-soul cards don't belong here.
    const seenIds = new Set<number>();
    for (const row of this.gameContext.data.cardsLocal.values()) {
      if (row.ownerId !== this.ownerId) continue;
      if (((row.packedDefinition >> 12) & 0xf) !== SOUL_CARD_TYPE) continue;
      if (seenIds.has(row.cardId)) continue;
      seenIds.add(row.cardId);
      this.upsertVisual(row);
    }

    this.unsubArtLoad = this.gameContext.lodTextures.onLoad(() => {
      // Re-`upsertVisual` for each tracked card so its `CardFace`
      // picks up the freshly-loaded sprite. `upsertVisual` is
      // idempotent — it re-uses the existing visual when present
      // and only refreshes its `draw()` state.
      for (const cardId of this.visuals.keys()) {
        const row = this.gameContext.data.cardsLocal.get(cardId);
        if (row) this.upsertVisual(row);
      }
    });

    // Follow the active soul. `souls.on` fires immediately with
    // the current value so the initial selectedCardId is seeded
    // without a separate dance. Subsequent active-soul changes
    // (from anywhere in the app — drag, click, focus) move the
    // outline.
    this.unsubActiveSoul = this.gameContext.souls.on((soul) => {
      const next = soul?.cardId ?? null;
      if (this.selectedCardId === next) return;
      this.selectedCardId = next;
      this.invalidate();
    });

    this.unsubLocalCard = this.gameContext.data.subscribeLocalCard((change) => {
      if (change.kind === "removed") {
        this.removeVisual(change.key);
        return;
      }
      const row = change.kind === "added" ? change.row : change.newRow;
      const wasOurs = this.visuals.has(change.key);
      const isSoul = ((row.packedDefinition >> 12) & 0xf) === SOUL_CARD_TYPE;
      const isOurs = row.ownerId === this.ownerId && isSoul;
      if (isOurs) {
        this.upsertVisual(row);
      } else if (wasOurs) {
        this.removeVisual(change.key);
      }
    });
  }

  override destroy(): void {
    this.unsubActiveSoul();
    this.unsubLocalCard();
    this.unsubArtLoad();
    for (const visual of this.visuals.values()) {
      visual.destroy({ children: true });
    }
    this.visuals.clear();
    super.destroy();
  }

  /** Build or refresh the visual for a card. The visual is wired
   *  for `pointertap` → selection update; rect vs hex picks the
   *  right visual class. Rect cards use `CardFace` (body + title +
   *  sprite via the shared helper); hex cards keep their bare
   *  `HexCardVisual` since hex sprites aren't yet unified into a
   *  hex-shaped face. */
  private upsertVisual(row: LocalCard): void {
    const def = row.def ?? this.gameContext.definitions.decode(row.packedDefinition);
    const typeId = (row.packedDefinition >> 12) & 0xf;
    const isHex = this.gameContext.definitions.shape(typeId) === "hex";

    let visual = this.visuals.get(row.cardId);
    if (visual === undefined) {
      visual = isHex ? new HexCardVisual(LayoutHexCard.RADIUS) : new CardFace();
      visual.eventMode = "static";
      visual.cursor = "pointer";
      const cardId = row.cardId;
      visual.on("pointertap", () => this.select(cardId));
      // Eye button: only on soul cards. Attached as a CardFace
      // child so it travels with the visual through layout/destroy.
      // pointertap on the eye stops propagation so the body's
      // `select(cardId)` doesn't also fire. Color comes from the
      // def's `style[2]` (the same text-color the title bar uses)
      // so it reads as a card-native control rather than a
      // generic chrome element.
      if (visual instanceof CardFace && typeId === SOUL_CARD_TYPE) {
        const textColor = def?.style[2] ?? "#0b1426";
        const eye = this.makeEyeButton(cardId, textColor);
        visual.addChild(eye);
      }
      this.cardsContainer.addChild(visual);
      this.visuals.set(row.cardId, visual);
    }
    if (visual instanceof CardFace) {
      visual.draw(
        def,
        "top",
        this.gameContext.definitions.label(row.packedDefinition),
        {
          lodTextures: this.gameContext.lodTextures,
          textureRegistry: getTextureRegistry(),
          // Seed = the row's `cardId` so per-row variance is
          // preserved (a soul's portrait reads identically here
          // and in the player's inventory).
          seed: row.cardId,
        },
      );
    } else if (visual instanceof HexCardVisual) {
      visual.draw(def);
    }
    this.invalidate();
  }

  /** Build the `👁` button overlay for a soul card. Tap → look up
   *  the soul's current `(surface, q, r)` from `soulsLocal` and
   *  point the most-recently-focused `GameViewPanel` at it via
   *  `focusAt`. Sits just below the title bar, right-aligned
   *  inside the card body. `textColor` comes from `def.style[2]`
   *  so the glyph reads as a card-native control. No-op if no
   *  soul row is loaded or no game-view panel exists (in practice
   *  the dim panel is always open from login, so the latter
   *  shouldn't happen). */
  private makeEyeButton(soulCardId: number, textColor: string): Container {
    const eye = new Container();
    const text = new Text({
      text: "👁",
      style: { fill: textColor, fontFamily: "sans-serif", fontSize: 16 },
    });
    text.anchor.set(0.5);
    text.position.set(EYE_SIZE / 2, EYE_SIZE / 2);
    eye.addChild(text);
    // Title bar occupies y ∈ [0, RECT_CARD_TITLE_HEIGHT) at top
    // position; place the eye immediately below it, right-edge
    // aligned with the card.
    eye.position.set(
      RECT_CARD_WIDTH - EYE_SIZE - EYE_PAD,
      RECT_CARD_TITLE_HEIGHT + EYE_PAD,
    );
    eye.eventMode = "static";
    eye.cursor = "pointer";
    eye.hitArea = new Rectangle(0, 0, EYE_SIZE, EYE_SIZE);
    eye.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      // Tapping the eye implicitly selects the soul too — saves a
      // two-click "tap card → tap eye" dance. `select` notifies the
      // parent which routes the active-soul activation; the body's
      // `pointertap → this.select(cardId)` is what we suppressed
      // with stopPropagation, so we have to mirror it here.
      this.select(soulCardId);
      this.focusViewportOnSoul(soulCardId);
    });
    return eye;
  }

  /** Look up the soul's current position and snap the most-
   *  recently-focused `GameViewPanel` to it.
   *
   *  Reads the soul's `(surface, macroZone, microZone)` from
   *  `cardsLocal` (the soul card row) rather than `soulsLocal`
   *  (the public Soul mirror). The chooser is already subscribed
   *  to owned cards via `subscribeOwnedCards`, so the soul card
   *  row is immediately available. The Soul mirror row only
   *  arrives after `setActiveSoul → subscribeSoul` lands the
   *  per-id subscription — that's async, so on the first eye
   *  press the soul row wouldn't be in `soulsLocal` yet and we'd
   *  no-op until the user pressed twice. Using `cardsLocal`
   *  sidesteps that subscription race entirely.
   *
   *  Both tables carry the same positional fields (the
   *  `on_card_write` hook keeps them in sync); reading from the
   *  card side is just less round-trip-y for the chooser context. */
  private focusViewportOnSoul(soulCardId: number): void {
    const soulCard = this.gameContext.data.cardsLocal.get(soulCardId);
    if (!soulCard) return;
    const { zoneQ, zoneR } = unpackMacroZone(soulCard.macroZone);
    const { localQ, localR } = unpackMicroZone(soulCard.microZone);
    const q = zoneQ + localQ;
    const r = zoneR + localR;
    // `focused("gameview")` returns whichever game-view panel was
    // last focused — the one visually on top. The dim panel
    // (`gameview:dim`) and the soul-mode panel (`gameview`) share
    // the prefix, so either is selectable here.
    const panel = this.gameContext.panels?.focused("gameview");
    if (panel instanceof GameViewPanel) {
      panel.focusAt(q, r, soulCard.surface);
      panel.focus();
    }
  }

  private removeVisual(cardId: number): void {
    const visual = this.visuals.get(cardId);
    if (visual === undefined) return;
    this.cardsContainer.removeChild(visual);
    visual.destroy({ children: true });
    this.visuals.delete(cardId);
    // `selectedCardId` is now derived from active soul. If the
    // active soul's card row disappears, `souls.on` fires with
    // `null` and resets `selectedCardId` independently. Even if
    // it doesn't (visual removed for reasons unrelated to the
    // soul row), the layout pass just skips drawing the outline
    // when no visual matches `selectedCardId`.
    this.invalidate();
  }

  private select(cardId: number): void {
    // The outline is derived from active soul (see the
    // `souls.on` subscription in the constructor) — tapping a
    // card just notifies the parent, which decides whether to
    // activate the soul (via `tryActivateSoul`). The outline
    // then follows through the active-soul listener. Tapping an
    // unowned card has no visible effect: the parent's
    // `tryActivateSoul` rejects it and active soul doesn't change.
    this.onSelectionChange(cardId);
  }

  protected override layout(): void {
    this.bg.clear().rect(0, 0, this.width, this.height).fill({ color: PANEL_BG });

    // Card grid fills the panel body, leaving only a bottom pad
    // for breathing room. The old Play button strip was removed —
    // the 👁 button on each soul card handles navigation now.
    const gridBottom = this.height - BUTTON_PAD;

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
    // Use the soul-card visual size as the create card's footprint
    // so it tiles uniformly with the rest of the grid.
    const createCardW = CardFace.WIDTH;
    const createCardH = CardFace.HEIGHT;
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

    // Place the "+" create card in the slot right after the last
    // soul card. Hidden when the player's at the soul cap (matches
    // the legacy create-button-disabled state, just removes the
    // affordance entirely so the cap is unambiguous).
    const createEnabled = this.visuals.size < MAX_SOULS_PER_PLAYER;
    this.createCard.visible = createEnabled;
    if (createEnabled) {
      const col = i % cellsPerRow;
      const row = Math.floor(i / cellsPerRow);
      const cellX = ox + col * GRID_W;
      const cellY = oy + row * GRID_H;
      const x = cellX + (GRID_W - createCardW) / 2;
      const y = cellY + (GRID_H - createCardH) / 2;
      this.createCard.position.set(x, y);
      this.createCard.hitArea = new Rectangle(0, 0, createCardW, createCardH);
      const fillColor = this.createHovered ? BUTTON_BG_HOVER : BUTTON_BG;
      this.createCardBg
        .clear()
        .roundRect(0, 0, createCardW, createCardH, 8)
        .fill({ color: fillColor })
        .stroke({ color: 0x5a5a6a, width: 1 });
      this.createCardLabel.position.set(createCardW / 2, createCardH / 2);
      this.createCardLabel.style.fill = BUTTON_TEXT;
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
  }
}

function visualWidth(child: Container): number {
  if (child instanceof CardFace) return CardFace.WIDTH;
  if (child instanceof HexCardVisual) return LayoutHexCard.WIDTH;
  return child.width;
}

function visualHeight(child: Container): number {
  if (child instanceof CardFace) return CardFace.HEIGHT;
  if (child instanceof HexCardVisual) return LayoutHexCard.HEIGHT;
  return child.height;
}
