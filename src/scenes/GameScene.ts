import { GameView } from "@/ui/components/GameView";

/**
 * Main game scene. Extends GameView so it IS the layout root — SceneManager
 * adds it directly to the stage and ticks it each frame.
 *
 * The constructor forces one layout pass before centring the camera so that
 * World.innerRect has valid dimensions when centerOnHex computes the initial
 * pan offset.
 *
 * SpacetimeDB subscriptions will be established here once the connection
 * layer exists.  For now, bootstrap() in LoginScene populates client tables.
 */
export class GameScene extends GameView {
  constructor() {
    super();
    this.tick();
    this.centerCameraOnViewedSoul();
  }
}
