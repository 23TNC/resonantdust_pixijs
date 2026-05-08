import type { GameContext } from "../../GameContext";
import type { GameInventory } from "../../game/inventory/InventoryGame";

const TICK_HZ = 30;
const TICK_INTERVAL_MS = 1000 / TICK_HZ;
const MAX_CATCHUP_TICKS = 5;

/**
 * Scene-scoped game-logic orchestrator. Runs at a slower rate than the Pixi
 * render loop (default 30Hz); accumulates frame deltas and steps fixed-size
 * game ticks. Iterates registered `GameInventory` (and eventually GameWorld)
 * per tick and dispatches `update(dt)` with delta-time in seconds.
 */
export class GameManager {
  private readonly inventories = new Set<GameInventory>();
  private accumulator = 0;

  constructor(private readonly _ctx: GameContext) {}

  add(inventory: GameInventory): void {
    this.inventories.add(inventory);
  }

  remove(inventory: GameInventory): void {
    this.inventories.delete(inventory);
  }

  /** Call from the scene's per-frame update loop with the Pixi `deltaMS`. */
  tick(deltaMS: number): void {
    this.accumulator += deltaMS;
    let safety = MAX_CATCHUP_TICKS;
    while (this.accumulator >= TICK_INTERVAL_MS && safety > 0) {
      this.accumulator -= TICK_INTERVAL_MS;
      safety--;
      const dt = TICK_INTERVAL_MS / 1000;
      for (const inv of this.inventories) {
        try {
          inv.update(dt);
        } catch (err) {
          console.error("[GameManager] inventory.update threw", err);
        }
      }
    }
    if (safety === 0 && this.accumulator > TICK_INTERVAL_MS) {
      // Spiral-of-death guard: drop accumulated time we couldn't catch up to.
      this.accumulator = 0;
    }
  }

  dispose(): void {
    for (const inv of this.inventories) inv.dispose();
    this.inventories.clear();
  }
}
