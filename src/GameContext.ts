import type { Application } from "pixi.js";
import type { ActionManager } from "./game/actions/ActionManager";
import type { TextureManager } from "./assets/TextureManager";
import type { CardManager } from "./game/cards/CardManager";
import type { DrawCallCounter } from "./debug/DrawCallCounter";
import type { DefinitionManager } from "./game/definitions/DefinitionManager";
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
  readonly drawCallCounter: DrawCallCounter;
  readonly scenes: SceneManager;
  readonly definitions: DefinitionManager;
  // readonly recipes: RecipeManager;
  readonly connections: ConnectionRegistry;
  readonly reducers: ReducerManager;
  readonly playerSession: PlayerManager;
  readonly souls: SoulManager;
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
}
