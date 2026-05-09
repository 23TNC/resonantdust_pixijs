import { debug } from "../../debug";
import type { ConnectionManager } from "./ConnectionManager";

/**
 * Owns reducer calls. Each reducer is a thin wrapper that awaits the
 * connection and forwards to the SDK's typed reducers. Centralising them
 * here keeps the SDK boundary in one file and gives us a single place to
 * add cross-cutting concerns (logging, retry, telemetry).
 */
export class ReducerManager {
  constructor(private readonly connection: ConnectionManager) {}

  /**
   * Propose a stack action against a matched recipe. The server validates
   * recipe eligibility (hex / root / slot entities) and the proposed
   * location, then sets `slot_hold` on every slot card and `position_hold`
   * on the actor / root / non-actor slots according to the rules in
   * `actions.rs::propose_action` — see that doc for the exact flag
   * derivation. Pass `0` for `hex` / `root` when the recipe has no
   * `hex` / `root` constraint.
   */
  async proposeAction(args: {
    hex: number;
    root: number;
    slots: number[];
    surface: number;
    macroZone: number;
    microZone: number;
    microLocation: number;
    recipeId: number;
    /** Distance of the actor (`slots[0]`) from `root` in the chain.
     *  Used by the server only when `root != 0` — pinned actor's
     *  `OnRoot` row gets `position = rootDist`. For a fresh chain
     *  (no held cards above the root) this is `1`; for sub-roots
     *  past held blocks, the full distance from the chain root. */
    rootDist: number;
  }): Promise<void> {
    debug.log(
      ["spacetime"],
      `[spacetime] proposeAction recipe=${args.recipeId} hex=${args.hex} root=${args.root} slots=[${args.slots.join(",")}] rootDist=${args.rootDist}`,
      5,
    );
    const conn = await this.connection.connect();
    await conn.reducers.proposeAction(args);
  }
}
