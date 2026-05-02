import type { Application } from "pixi.js";
import type { CardManager } from "./cards/CardManager";
import type { DefinitionManager } from "./definitions/DefinitionManager";
import type { PlayerSession } from "./features/PlayerSession";
import type { GameManager } from "./game/GameManager";
import type { InputManager } from "./input/InputManager";
import type { LayoutManager } from "./layout/LayoutManager";
import type { SceneManager } from "./scenes/SceneManager";
import type { SpacetimeManager } from "./server/SpacetimeManager";
import type { DataManager } from "./state/DataManager";
import type { ZoneManager } from "./zones/ZoneManager";

export interface GameContext {
  readonly app: Application;
  readonly scenes: SceneManager;
  readonly definitions: DefinitionManager;
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
}
