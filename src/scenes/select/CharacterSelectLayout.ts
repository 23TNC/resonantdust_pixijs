import type { GameContext } from "../../GameContext";
import type { StarterPack } from "../../game/definitions/DefinitionManager";
import { LayoutNode } from "../../game/layout/LayoutNode";
import { OwnedCardsPanel } from "./OwnedCardsPanel";
import { PackChooserPanel } from "./PackChooserPanel";
import { PackContentsPanel } from "./PackContentsPanel";
import { SoulInventoryPanel } from "./SoulInventoryPanel";
import { TitleBar } from "../../game/titlebar/TitleBar";

const MIN_PANEL_WIDTH = 360;
const PREFERRED_PANEL_FRACTION = 0.35;
const MAX_PANEL_WIDTH = 600;

/** Souls offered in the character-create flow. Today only `"human"`
 *  ships starter packs; the chooser panel renders one section per
 *  entry so adding more is data-only. */
const CREATE_SOULS: readonly string[] = ["human"];

type Mode = "select" | "create";

/**
 * Scene layout for character select. Right is always the chooser
 * (the selectable thing); left is always the display (the
 * contents of whatever's selected on the right). Consistent
 * across both modes:
 *
 * - `"select"` — right: `OwnedCardsPanel` (the player's souls +
 *   Play / Create character buttons). Left:
 *   `SoulInventoryPanel` showing the cards owned by the currently
 *   selected soul.
 * - `"create"` — right: `PackChooserPanel` (one card per starter
 *   pack, grouped by soul, + Create / Back buttons). Left:
 *   `PackContentsPanel` showing the selected pack's soul card +
 *   contents.
 *
 * In select mode the layout also tracks the selected soul card's
 * id and asks the scene to subscribe to that soul's owner-cards
 * (via `onSelectedSoulChange`) so the soul's inventory rows
 * actually land in `cardsLocal` for the left panel to read.
 *
 * Mode swaps destroy and rebuild both panels so transient state
 * (selection, hover) doesn't survive a round-trip; `selectedSoul`
 * and `selectedPack` reset.
 */
export class CharacterSelectLayout extends LayoutNode {
  readonly titleBar: TitleBar;
  private leftPanel: LayoutNode;
  private rightPanel: OwnedCardsPanel | PackChooserPanel;
  private mode: Mode = "select";
  private selectedPack: StarterPack | null = null;
  private selectedSoulId: number | null = null;

  private readonly gameContext: GameContext;
  private readonly playerId: number;
  private readonly onPlay: (cardId: number) => void;
  private readonly onCreateCharacter: (pack: StarterPack) => void;
  private readonly onSelectedSoulChange: (soulId: number | null) => void;

  constructor(
    ctx: GameContext,
    playerName: string,
    playerId: number,
    onPlay: (cardId: number) => void,
    onCreateCharacter: (pack: StarterPack) => void,
    onSelectedSoulChange: (soulId: number | null) => void,
  ) {
    super();
    this.gameContext = ctx;
    this.playerId = playerId;
    this.onPlay = onPlay;
    this.onCreateCharacter = onCreateCharacter;
    this.onSelectedSoulChange = onSelectedSoulChange;
    this.titleBar = new TitleBar(playerName);
    this.leftPanel = this.buildSelectLeftPanel();
    this.rightPanel = this.buildSelectRightPanel();
    this.addChild(this.leftPanel);
    this.addChild(this.titleBar);
    this.addChild(this.rightPanel);
  }

  private buildSelectLeftPanel(): SoulInventoryPanel {
    const panel = new SoulInventoryPanel(this.gameContext);
    // Apply any pre-existing selection (e.g. coming back from
    // create-mode that left a stale id, though we reset on mode
    // swap so this is usually `null`).
    panel.setSoulId(this.selectedSoulId);
    return panel;
  }

  private buildSelectRightPanel(): OwnedCardsPanel {
    return new OwnedCardsPanel(
      this.gameContext,
      this.playerId,
      this.onPlay,
      () => this.setMode("create"),
      (cardId) => {
        this.selectedSoulId = cardId;
        if (this.leftPanel instanceof SoulInventoryPanel) {
          this.leftPanel.setSoulId(cardId);
        }
        this.onSelectedSoulChange(cardId);
      },
    );
  }

  private buildCreateLeftPanel(): PackContentsPanel {
    return new PackContentsPanel(this.gameContext);
  }

  private buildCreateRightPanel(): PackChooserPanel {
    const panel = new PackChooserPanel(
      this.gameContext,
      CREATE_SOULS,
      (pack) => {
        this.selectedPack = pack;
        panel.setSelectedPackId(pack.id);
        if (this.leftPanel instanceof PackContentsPanel) {
          this.leftPanel.setPack(pack);
        }
      },
      (pack) => this.onCreateCharacter(pack),
      () => this.setMode("select"),
    );
    return panel;
  }

  /** External hook for the scene to flip back to select-mode
   *  after a successful side effect (e.g. `createCharacter`
   *  reducer resolves). Same path the in-panel `[Back]` button
   *  uses; resets selection state so the just-created soul
   *  doesn't carry forward as a stale pick. */
  returnToSelectMode(): void {
    this.setMode("select");
  }

  /** Swap both body panels in lockstep. Tears down the existing
   *  ones (each panel's `destroy` unsubscribes its listeners and
   *  drops its visuals) and builds fresh ones for the new mode.
   *  Selection state resets so transient picks don't persist
   *  across mode round-trips. */
  private setMode(next: Mode): void {
    if (this.mode === next) return;
    this.mode = next;
    this.selectedPack = null;
    this.selectedSoulId = null;
    // Notify the scene that the selection cleared so it can
    // unsubscribe the previous soul's inventory.
    this.onSelectedSoulChange(null);

    this.removeChild(this.leftPanel);
    this.removeChild(this.rightPanel);
    this.leftPanel.destroy();
    this.rightPanel.destroy();

    if (next === "create") {
      this.leftPanel = this.buildCreateLeftPanel();
      this.rightPanel = this.buildCreateRightPanel();
    } else {
      this.leftPanel = this.buildSelectLeftPanel();
      this.rightPanel = this.buildSelectRightPanel();
    }
    this.addChild(this.leftPanel);
    this.addChild(this.rightPanel);
    this.invalidate();
  }

  protected override layout(): void {
    const titleH = TitleBar.HEIGHT;
    const panelW = Math.min(
      MAX_PANEL_WIDTH,
      Math.max(MIN_PANEL_WIDTH, this.width * PREFERRED_PANEL_FRACTION),
    );
    const bodyTop = titleH;
    const bodyH = Math.max(0, this.height - titleH);
    const leftW = Math.max(0, this.width - panelW);

    this.titleBar.setBounds(0, 0, this.width, titleH);
    this.leftPanel.setBounds(0, bodyTop, leftW, bodyH);
    this.rightPanel.setBounds(leftW, bodyTop, panelW, bodyH);
  }
}
