import type { Application } from "pixi.js";
import type { ActionManager } from "./actions/ActionManager";
import type { TextureManager } from "./assets/TextureManager";
import type { CardManager } from "./cards/CardManager";
import type { DrawCallCounter } from "./debug/DrawCallCounter";
import type { DefinitionManager } from "./definitions/DefinitionManager";
import type { RecipeManager } from "./definitions/RecipeManager";
import type { PlayerSession } from "./features/PlayerSession";
import type { GameManager } from "./game/GameManager";
import type { InputManager } from "./input/InputManager";
import type { LayoutManager } from "./layout/LayoutManager";
import type { SceneManager } from "./scenes/SceneManager";
import type { SpacetimeManager } from "./server/SpacetimeManager";
import type { DataManager } from "./state/DataManager";
import type { LayoutWorld } from "./world/LayoutWorld";
import type { ZoneManager } from "./zones/ZoneManager";

export interface GameContext {
  readonly app: Application;
  readonly textures: TextureManager;
  readonly drawCallCounter: DrawCallCounter;
  readonly scenes: SceneManager;
  readonly definitions: DefinitionManager;
  readonly recipes: RecipeManager;
  readonly spacetime: SpacetimeManager;
  readonly playerSession: PlayerSession;
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
  /** Scene-scoped: the world surface. Used by world-layer cards to compute screen position. */
  world: LayoutWorld | null;
}
