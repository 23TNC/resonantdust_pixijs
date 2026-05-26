import type { Application, RenderTexture } from "pixi.js";
import type { ActionManager } from "./game/actions/ActionManager";
import type { TextureManager } from "./assets/textures/TextureManager";
import type { CardTextureManager } from "./assets/textures/CardTextureManager";
import type { LodTextureManager } from "./assets/textures/LodTextureManager";
import type { ObjectManager } from "./assets/ObjectManager";
import type { CardManager } from "./game/cards/CardManager";
import type { DrawCallCounter } from "./debug/DrawCallCounter";
import type { DefinitionManager } from "./game/definitions/DefinitionManager";
import type { LifecycleResolutionManager } from "./game/lifecycle/LifecycleResolutionManager";
// import type { RecipeManager } from "./definitions/RecipeManager";
import type { PlayerManager } from "./server/player/PlayerManager";
import type { SoulManager } from "./server/player/SoulManager";
import type { MainManager } from "./scenes/main/MainManager";
import type { InputManager } from "./game/input/InputManager";
import type { LayoutManager } from "./game/layout/LayoutManager";
import type { SceneManager } from "./scenes/SceneManager";
import type { ConnectionRegistry } from "./server/spacetime/ConnectionRegistry";
import type { ReducerManager } from "./server/spacetime/ReducerManager";
import type { DataManager } from "./server/data/DataManager";
// LayoutWorld is owned by MainLayout; world consumers reach the
// world-card surface via `ctx.layout.surfaceFor(zoneId)`.
import type { ZoneManager } from "./game/zones/ZoneManager";
import type { LogManager } from "./game/chat/LogManager";
import type { PanelManager } from "./ui/panels/PanelManager";
import type { PanelTaskbar } from "./ui/dom/PanelTaskbar";
import type { UiEditMode } from "./ui/dom/UiEditMode";
import type { DebugPanel } from "./game/titlebar/DebugPanel";
import type { SettingsMenu } from "./game/titlebar/SettingsMenu";

export interface GameContext {
  readonly app: Application;
  readonly textures: TextureManager;
  readonly cardTextures: CardTextureManager;
  readonly lodTextures: LodTextureManager;
  readonly objects: ObjectManager;
  readonly drawCallCounter: DrawCallCounter;
  readonly scenes: SceneManager;
  readonly definitions: DefinitionManager;
  // readonly recipes: RecipeManager;
  readonly connections: ConnectionRegistry;
  readonly reducers: ReducerManager;
  readonly playerSession: PlayerManager;
  readonly souls: SoulManager;
  /** Client-side lifecycle-resolution state machine. Bootstrap-
   *  scoped; observes owned lifecycle-pending cards and submits
   *  success / failure recipes via `reducers.proposeAction`. See
   *  `docs/LIFECYCLE_REWRITE.md`. */
  readonly lifecycle: LifecycleResolutionManager;
  readonly data: DataManager;
  readonly zones: ZoneManager;
  /** Bottom-anchored taskbar for primary app surfaces (chat,
   *  inventory, world panels). Panels constructed with
   *  `taskbar: ctx.taskbar` minimize-to-taskbar; panels without fall
   *  back to rolling up in place. */
  readonly taskbar: PanelTaskbar;
  /** Top-anchored taskbar for system surfaces (debug HUD, settings).
   *  Same shape as `taskbar` — a separate instance so panels can
   *  pick which edge their entry lives on. */
  readonly topTaskbar: PanelTaskbar;
  /** App-wide UI edit-mode flag. While enabled, panels expose extra
   *  action buttons (grid-snap, lock, hide-title-bar) and force
   *  their title bars visible regardless of the user's hide
   *  preference. Toggled from the settings menu. */
  readonly uiEditMode: UiEditMode;
  /** Pinned debug HUD. Lives across scenes; scenes pump stats into
   *  it each frame via `setStats(deltaMS, drawCalls, ...)`. */
  readonly debugPanel: DebugPanel;
  /** Pinned settings dropdown. Persistent across scenes — each scene
   *  wires its own callbacks (`onLogOut`, etc.) on enter and clears
   *  them on exit. */
  readonly settingsMenu: SettingsMenu;
  /** Scene-scoped: set by MainScene on enter, cleared on exit. Null
   *  otherwise. Central registry of open panels with get-or-create
   *  semantics. Replaces the old per-owner panel fields that lived
   *  on `MainLayout` (`inventoryPanel`, etc.); panels self-register
   *  in their factory via `ctx.panels.ensure(id, factory)`. */
  panels: PanelManager | null;
  /** Scene-scoped: set by MainScene on enter, cleared on exit. Null otherwise. */
  cards: CardManager | null;
  /** Scene-scoped: set by MainScene on enter, cleared on exit. Null otherwise. */
  layout: LayoutManager | null;
  /** Scene-scoped: set by MainScene on enter, cleared on exit. Null otherwise. */
  game: MainManager | null;
  /** Scene-scoped: set by MainScene on enter, cleared on exit. Null otherwise. */
  input: InputManager | null;
  /** Scene-scoped: set by MainScene on enter, cleared on exit. Null otherwise. */
  actions: ActionManager | null;
  /** Scene-scoped: set by MainScene on enter, cleared on exit. Null otherwise.
   *  Client-only flavor-text feed rendered by `ChatPanel`'s `logs` tab. */
  logs: LogManager | null;
  /** Scene-scoped: set by LayoutWorld on construction, cleared on
   *  destroy. Renders a per-card "objects in front of this card"
   *  snapshot into a caller-provided RenderTexture sized
   *  (width, height). Returns true if any sprite was drawn. Used by
   *  hex cards on world surfaces to overlay nearby trees / rocks at
   *  50% alpha and imply depth without scene-tree reshuffling. */
  worldOverlay:
    | ((
        q: number,
        r: number,
        target: RenderTexture,
        width: number,
        height: number,
        offsetX?: number,
        offsetY?: number,
      ) => boolean)
    | null;
  /** Scene-scoped: set by LayoutWorld on construction, cleared on
   *  destroy. Maps a global pixel coord (Pixi stage frame) to the
   *  axial hex `(q, r)` underneath it. Cards pass their own
   *  `container.getGlobalPosition()` (plus a half-size offset to land
   *  on the centre) — works whether the card is parented to the
   *  world-card surface or to the drag overlay, since both resolve to
   *  global coords. Cards use this per frame while dragging or
   *  tweening to detect tile-boundary crossings and refresh their
   *  overlay. */
  worldHexAt:
    | ((
        globalX: number,
        globalY: number,
      ) => { q: number; r: number; offsetX: number; offsetY: number })
    | null;
  /** Scene-scoped: set by LayoutWorld on construction, cleared on
   *  destroy. Subscribe to be notified whenever the world's tile
   *  cache updates — cards use this to re-bake their in-front-objects
   *  overlay when nearby tiles arrive / change. Returns an
   *  unsubscribe function. */
  onTilesChanged: ((callback: () => void) => () => void) | null;
}
