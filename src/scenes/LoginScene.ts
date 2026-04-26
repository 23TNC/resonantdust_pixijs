import { LayoutRoot } from "@/ui/layout/LayoutRoot";
import { setPlayerId, setPlayerName } from "@/spacetime/Data";
import { bootstrap } from "@/spacetime/DebugData";
import { SceneManager } from "./SceneManager";
import { GameScene } from "./GameScene";

/**
 * Stub login scene. Sets player credentials, loads the debug data snapshot,
 * then hands off to GameScene before the first frame is painted.
 *
 * queueMicrotask defers the scene switch until after this scene is fully
 * registered with SceneManager, avoiding a setScene-within-setScene call.
 * The transition happens before any rendering, so LoginScene is never visible.
 */
export class LoginScene extends LayoutRoot {
  constructor(sceneManager: SceneManager) {
    super();

    setPlayerName("player1");
    setPlayerId(1);
    bootstrap();

    queueMicrotask(() => sceneManager.setScene(new GameScene()));
  }
}
