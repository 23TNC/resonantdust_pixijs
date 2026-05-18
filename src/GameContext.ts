import type { Application, RenderTexture } from "pixi.js";
import type { ActionManager } from "./game/actions/ActionManager";
import type { TextureManager } from "./assets/textures/TextureManager";
import type { CardTextureManager } from "./assets/textures/CardTextureManager";
import type { ObjectTextureManager } from "./assets/textures/ObjectTextureManager";
import type { ObjectManager } from "./assets/ObjectManager";
import type { CardManager } from "./game/cards/CardManager";
import type { DrawCallCounter } from "./debug/DrawCallCounter";
import type { DefinitionManager } from "./game/definitions/DefinitionManager";
import type { LifecycleResolutionManager } from "./game/lifecycle/LifecycleResolutionManager";
// import type { RecipeManager } from "./definitions/RecipeManager";
import type { PlayerManager } from "./server/player/PlayerManager";
import type { SoulManager } from "./server/player/SoulManager";
import type { GameManager } from "./scenes/game/GameManager";
import type { InputManager } from "./game/input/InputManager";
import type { LayoutManager } from "./game/layout/LayoutManager";
import type { SceneManager } from "./scenes/SceneManager";
import type { ConnectionRegistry } from "./server/spacetime/ConnectionRegistry";
import type { ReducerManager } from "./server/spacetime/ReducerManager";
import type { DataManager } from "./server/data/DataManager";
// LayoutWorld is owned by GameLayout; world consumers reach the
// world-card surface via `ctx.layout.surfaceFor(zoneId)`.
import type { ZoneManager } from "./game/zones/ZoneManager";
import type { LogManager } from "./game/chat/LogManager";

export interface GameContext {
  readonly app: Application;
  readonly textures: TextureManager;
  readonly cardTextures: CardTextureManager;
  readonly objectTextures: ObjectTextureManager;
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
  /** Scene-scoped: set by GameScene on enter, cleared on exit. Null otherwise. */
  cards: CardManager | null;
  /** Scene-scoped: set by GameScene on enter, cleared on exit. Null otherwise. */
  layout: LayoutManager | null;
  /** Scene-scoped: set by GameScene on enter, cleared on exit. Null otherwise. */
  game: GameManager | null;
  /** Scene-scoped: set by GameScene on enter, cleared on exit. Null otherwise. */
  input: InputManager | null;
  /** Scene-scoped: set by GameScene on enter, cleared on exit. Null otherwise. */
  actions: ActionManager | null;
  /** Scene-scoped: set by GameScene on enter, cleared on exit. Null otherwise.
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
