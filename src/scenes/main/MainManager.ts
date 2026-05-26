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
 *
 * Always-on inside `MainScene` regardless of mode — registered inventories
 * are what's mode-dependent: in browse mode the set is empty (no
 * `GameInventory` constructed yet) so `tick` runs the loop and exits
 * cheaply; in play mode the active soul's `GameInventory` is added.
 */
export class MainManager {
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
          console.error("[MainManager] inventory.update threw", err);
        }
      }
    }
    if (safety === 0 && this.accumulator > TICK_INTERVAL_MS) {
      // Spiral-of-death guard: drop accumulated time we couldn't catch up to.
      this.accumulator = 0;
    }
  }

  dispose(): void {
    // Just drop the tick registrations. Inventory ownership lives
    // with the caller of `add` (today `MainLayout`, paired with the
    // inventory panel's lifecycle), so they're responsible for
    // calling `inv.dispose()` before / alongside their own
    // teardown. Double-disposing here would unsubscribe-then-
    // unsubscribe a CardManager listener that's already gone.
    this.inventories.clear();
  }
}
