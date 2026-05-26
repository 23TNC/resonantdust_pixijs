import { Container, Graphics, Rectangle, Text } from "pixi.js";
import type { GameContext } from "../../GameContext";
import { LayoutNode } from "../../game/layout/LayoutNode";
import type { ManagedPanel } from "../../ui/panels/PanelManager";
import { GameViewPanel } from "../../game/world/GameViewPanel";
import { PanelTaskbar } from "../../ui/dom/PanelTaskbar";
import { PixiPanel } from "../../ui/dom/PixiPanel";
import {
  PLAYER_DIMENSION_LAYER,
  MINI_ZONE_LAYER,
  WORLD_LAYER,
  unpackMacroZone,
  unpackMicroZone,
} from "../../server/data/packing";
import { hexDistance } from "../../game/world/pathfind";

const SOUL_CARD_TYPE = 6;
const FLAG_OWNED_BY_PLAYER = 1 << 4;

const DEFAULT_WIDTH  = 200;
const DEFAULT_HEIGHT = 220;
const BUTTON_HEIGHT  = 36;
const BUTTON_GAP     = 6;
const BUTTON_PAD_X   = 12;
const PANEL_BG        = 0x121922;
const BUTTON_BG       = 0x3a3a4a;
const BUTTON_BG_HOVER = 0x4a4a5a;
const BUTTON_TEXT     = 0xecd6aa;

function surfaceLabel(surface: number): string {
  if (surface === PLAYER_DIMENSION_LAYER) return "Pocket Dimension";
  if (surface === MINI_ZONE_LAYER) return "Mini Zone";
  if (surface === WORLD_LAYER) return "World";
  return `Surface ${surface}`;
}

interface ButtonHandle {
  surface: number;
  container: Container;
  bg: Graphics;
  text: Text;
  hovered: boolean;
}

/**
 * Inner LayoutNode for the LocationPanel button list. Renders one
 * button per surface the local player has reachable: always the
 * pocket dimension (PLAYER_DIMENSION_LAYER), plus every distinct
 * world-layer surface (≥ WORLD_LAYER) that at least one owned soul
 * card currently occupies. Re-renders on any cardsLocal change.
 *
 * Click hands off to the parent panel's `onSurfaceClick` callback,
 * which resolves the target hex and routes to either an existing
 * top-most GameViewPanel or a freshly-opened one.
 */
class LocationContent extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly buttons = new Map<number, ButtonHandle>();
  private readonly unsubCards: () => void;
  private surfaces: number[] = [];
  private dirty = true;

  constructor(
    ctx: GameContext,
    private readonly onSurfaceClick: (surface: number) => void,
  ) {
    super();
    this.setContext(ctx);
    // Background sits behind every button. `PixiPanel` renders its
    // body as transparent — without this fill the buttons float on
    // whatever is behind the panel. Drawn each layout pass to track
    // the panel's current width/height.
    this.container.addChildAt(this.bg, 0);
    // Any card change can affect the surface set (souls arriving,
    // souls moving between surfaces, souls being destroyed). Cheap
    // to invalidate — render only walks owned-soul cards.
    this.unsubCards = ctx.data.subscribeLocalCard(() => {
      this.dirty = true;
      this.invalidate();
    });
  }

  override destroy(): void {
    this.unsubCards();
    super.destroy();
  }

  protected override layout(): boolean | void {
    if (this.dirty) {
      this.recomputeSurfaces();
      this.dirty = false;
    }
    this.bg.clear().rect(0, 0, this.width, this.height).fill({ color: PANEL_BG });
    this.paintButtons();
  }

  private recomputeSurfaces(): void {
    const next = new Set<number>([PLAYER_DIMENSION_LAYER]);
    const player = this.ctx.playerSession.getPlayer();
    if (player) {
      for (const row of this.ctx.data.cardsLocal.values()) {
        if (row.ownerId !== player.playerId) continue;
        if ((row.flagsState & FLAG_OWNED_BY_PLAYER) === 0) continue;
        if (((row.packedDefinition >> 12) & 0xf) !== SOUL_CARD_TYPE) continue;
        if (row.surface >= WORLD_LAYER) next.add(row.surface);
      }
    }
    this.surfaces = [...next].sort((a, b) => a - b);

    // Drop buttons whose surface is gone.
    for (const [s, b] of this.buttons) {
      if (!next.has(s)) {
        this.container.removeChild(b.container);
        b.container.destroy({ children: true });
        this.buttons.delete(s);
      }
    }
    // Add buttons whose surface is new.
    for (const s of this.surfaces) {
      if (!this.buttons.has(s)) this.buttons.set(s, this.makeButton(s));
    }
  }

  private paintButtons(): void {
    const w = Math.max(this.width - BUTTON_GAP * 2, 80);
    let y = BUTTON_GAP;
    for (const s of this.surfaces) {
      const b = this.buttons.get(s);
      if (!b) continue;
      b.container.x = BUTTON_GAP;
      b.container.y = y;
      b.bg.clear();
      b.bg.roundRect(0, 0, w, BUTTON_HEIGHT, 6);
      b.bg.fill(b.hovered ? BUTTON_BG_HOVER : BUTTON_BG);
      // Re-center text vertically; horizontally pinned via padding.
      b.text.x = BUTTON_PAD_X;
      b.text.y = (BUTTON_HEIGHT - b.text.height) / 2;
      b.container.hitArea = new Rectangle(0, 0, w, BUTTON_HEIGHT);
      y += BUTTON_HEIGHT + BUTTON_GAP;
    }
  }

  private makeButton(surface: number): ButtonHandle {
    const container = new Container();
    const bg = new Graphics();
    const text = new Text({
      text: surfaceLabel(surface),
      style: { fill: BUTTON_TEXT, fontFamily: "sans-serif", fontSize: 14 },
    });
    container.addChild(bg);
    container.addChild(text);
    container.eventMode = "static";
    container.cursor = "pointer";
    const handle: ButtonHandle = { surface, container, bg, text, hovered: false };
    container.on("pointerover", () => { handle.hovered = true; this.invalidate(); });
    container.on("pointerout",  () => { handle.hovered = false; this.invalidate(); });
    container.on("pointertap",  () => this.onSurfaceClick(surface));
    this.container.addChild(container);
    return handle;
  }
}

/**
 * Floating "Location" panel: one button per surface reachable to the
 * local player — pocket dimension (always) plus every world-layer
 * surface their owned souls currently occupy. Clicking a button
 * retargets the most-recently-focused GameViewPanel
 * (`panels.focused("gameview")`) via `focusAt(q, r, surface)`:
 *
 *   - Pocket Dimension → pan to (0, 0).
 *   - Other surface    → pan to the player-owned soul on that
 *                        surface closest in axial-hex distance to
 *                        the viewport's current centre (or to (0, 0)
 *                        if no viewport anchor exists yet).
 *
 * If no GameViewPanel exists, one is opened first — the dim panel
 * for the pocket-dim button, a soul-mode panel keyed on the
 * closest-soul for any other surface — then `focusAt` runs against
 * the freshly-created panel.
 *
 * Singleton: keyed `"location"` in PanelManager.
 */
export class LocationPanel implements ManagedPanel {
  readonly panel: PixiPanel;
  private readonly ctx: GameContext;
  private readonly content: LocationContent;
  private readonly unsubRect: () => void;
  private readonly openSoulView: (soulCardId: number) => GameViewPanel;
  private readonly openDimView: () => GameViewPanel;

  constructor(
    ctx: GameContext,
    parent: LayoutNode,
    openSoulView: (soulCardId: number) => GameViewPanel,
    openDimView: () => GameViewPanel,
  ) {
    this.ctx = ctx;
    this.openSoulView = openSoulView;
    this.openDimView = openDimView;

    this.content = new LocationContent(ctx, (surface) => this.handleClick(surface));

    this.panel = new PixiPanel({
      title: "Location",
      parent,
      storageKey: "locationPanel",
      defaultRect: {
        right:  "0",
        top:    `${PanelTaskbar.HEIGHT}px`,
        width:  `${DEFAULT_WIDTH}px`,
        height: `${DEFAULT_HEIGHT}px`,
      },
      minWidth:    140,
      minHeight:   100,
      minimizable: true,
      closable:    true,
      taskbar:     ctx.taskbar,
      uiEditMode:  ctx.uiEditMode,
    });
    this.panel.content.addChild(this.content);

    this.unsubRect = this.panel.onRectChange(() => {
      this.content.setBounds(0, 0, this.panel.content.width, this.panel.content.height);
    });

    ctx.panels?.registerNode(this.content, this);
    this.panel.onDestroy(() => this.cleanup());
  }

  focus(): void { this.panel.focus(); }
  destroy(): void { this.panel.destroy(); }
  onFocus(cb: () => void): () => void { return this.panel.onFocus(cb); }
  onDestroy(cb: () => void): () => void { return this.panel.onDestroy(cb); }

  private cleanup(): void {
    this.unsubRect();
    this.ctx.panels?.unregisterNode(this.content);
  }

  private handleClick(surface: number): void {
    const target = this.resolveTarget(surface);
    if (!target) return;
    const focused = this.ctx.panels?.focused("gameview");
    if (focused instanceof GameViewPanel) {
      focused.focusAt(target.q, target.r, surface);
      focused.focus();
      return;
    }
    // No game-view open yet — spawn one and snap it. Dim button
    // routes through the dim opener; everything else needs a soul
    // on the target surface to give soul-mode a subject.
    if (surface === PLAYER_DIMENSION_LAYER) {
      const p = this.openDimView();
      p.focusAt(target.q, target.r, surface);
      return;
    }
    const soul = this.firstOwnedSoulOnSurface(surface);
    if (!soul) return;
    const p = this.openSoulView(soul);
    p.focusAt(target.q, target.r, surface);
  }

  private resolveTarget(surface: number): { q: number; r: number } | null {
    if (surface === PLAYER_DIMENSION_LAYER) return { q: 0, r: 0 };
    const centre = this.viewportCentre() ?? { q: 0, r: 0 };
    let best: { q: number; r: number } | null = null;
    let bestDist = Infinity;
    const player = this.ctx.playerSession.getPlayer();
    if (!player) return null;
    for (const row of this.ctx.data.cardsLocal.values()) {
      if (row.surface !== surface) continue;
      if (row.ownerId !== player.playerId) continue;
      if ((row.flagsState & FLAG_OWNED_BY_PLAYER) === 0) continue;
      if (((row.packedDefinition >> 12) & 0xf) !== SOUL_CARD_TYPE) continue;
      const { zoneQ, zoneR } = unpackMacroZone(row.macroZone);
      const { localQ, localR } = unpackMicroZone(row.microZone);
      const coord = { q: zoneQ + localQ, r: zoneR + localR };
      const d = hexDistance(centre, coord);
      if (d < bestDist) {
        bestDist = d;
        best = coord;
      }
    }
    return best;
  }

  private viewportCentre(): { q: number; r: number } | null {
    const focused = this.ctx.panels?.focused("gameview");
    if (!(focused instanceof GameViewPanel)) return null;
    const anchor = this.ctx.zones.getAnchor(`viewport:${focused.panelId}`);
    if (!anchor) return null;
    return { q: anchor.q, r: anchor.r };
  }

  private firstOwnedSoulOnSurface(surface: number): number | null {
    const player = this.ctx.playerSession.getPlayer();
    if (!player) return null;
    for (const row of this.ctx.data.cardsLocal.values()) {
      if (row.surface !== surface) continue;
      if (row.ownerId !== player.playerId) continue;
      if ((row.flagsState & FLAG_OWNED_BY_PLAYER) === 0) continue;
      if (((row.packedDefinition >> 12) & 0xf) !== SOUL_CARD_TYPE) continue;
      return row.cardId;
    }
    return null;
  }
}
