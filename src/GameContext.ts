import type { Application } from "pixi.js";
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
import type { LogManager } from "./game/panels/chat/LogManager";
import type { PanelManager } from "./ui/panels/PanelManager";
import type { PanelTaskbar } from "./ui/dom/PanelTaskbar";
import type { UiEditMode } from "./ui/dom/UiEditMode";
import type { DebugPanel } from "./game/panels/titlebar/DebugPanel";
import type { SettingsMenu } from "./game/panels/titlebar/SettingsMenu";

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
  /** Resolves once the 64px LOD prewarm floor has finished loading.
   *  Kicked off (but NOT awaited) during bootstrap so the login form
   *  paints immediately; the LoginScene → MainScene transition awaits
   *  it before entering the world, guaranteeing the white-floor
   *  fallback is backed by real textures before any tile renders.
   *  By login time the prewarm is almost always already done, so the
   *  await is effectively free. */
  readonly assetsReady: Promise<void>;
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
}
