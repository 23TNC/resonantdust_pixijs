import type { Application } from "pixi.js";
// import type { ActionManager } from "./actions/ActionManager";
import type { TextureManager } from "./assets/TextureManager";
import type { CardManager } from "./game/cards/CardManager";
import type { DrawCallCounter } from "./debug/DrawCallCounter";
// import type { DefinitionManager } from "./definitions/DefinitionManager";
// import type { RecipeManager } from "./definitions/RecipeManager";
import type { PlayerManager } from "./server/player/PlayerManager";
import type { GameManager } from "./scenes/game/GameManager";
import type { InputManager } from "./game/input/InputManager";
import type { LayoutManager } from "./game/layout/LayoutManager";
import type { SceneManager } from "./scenes/SceneManager";
import type { ConnectionManager } from "./server/spacetime/ConnectionManager";
import type { ReducerManager } from "./server/spacetime/ReducerManager";
import type { DataManager } from "./server/data/DataManager";
// import type { LayoutWorld } from "./world/LayoutWorld";
import type { ZoneManager } from "./game/zones/ZoneManager";

export interface GameContext {
  readonly app: Application;
  readonly textures: TextureManager;
  readonly drawCallCounter: DrawCallCounter;
  readonly scenes: SceneManager;
  // readonly definitions: DefinitionManager;
  // readonly recipes: RecipeManager;
  readonly connection: ConnectionManager;
  readonly reducers: ReducerManager;
  readonly playerSession: PlayerManager;
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
  // actions: ActionManager | null;
}
