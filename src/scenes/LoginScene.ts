import { LayoutRoot } from "@/ui/layout/LayoutRoot";
import { spacetime } from "@/spacetime/SpacetimeManager";
import { type ServerPlayer, setPlayerId, type PlayerId } from "@/spacetime/Data";
import { SceneManager } from "./SceneManager";
import { GameScene } from "./GameScene";

const SPACETIME_URI    = "ws://localhost:3000";
const SPACETIME_MODULE = "resonantdust-dev";

export class LoginScene extends LayoutRoot {
  constructor(sceneManager: SceneManager) {
    super();

    const unwatch = spacetime.registerPlayerListener("player1", (player: ServerPlayer) => {
      unwatch();
      setPlayerId(player.player_id as PlayerId);
      sceneManager.setScene(new GameScene(player));
    });

    spacetime.onConnected(() => spacetime.subscribePlayer(this, "player1"));
    spacetime.connect(SPACETIME_URI, SPACETIME_MODULE);
  }
}
