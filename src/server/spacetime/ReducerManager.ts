import { debug } from "../../debug";
//import type { InventoryStack } from "./bindings/types";
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
   * Submit inventory stacks to trigger recipe matching on the server.
   * The server runs the upgrade machinery (`process_top_branch` /
   * `process_bottom_branch`) over each submitted stack — start, keep,
   * cancel, or upgrade decisions all flow from this single reducer.
   * There is intentionally no separate cancel reducer: the only way a
   * client influences action state is by submitting validated stacks
   * (or by causing card creation, which fires the on_create matcher).
   */
  /* async submitStacks(stacks: InventoryStack[]): Promise<void> {
    debug.log(
      ["spacetime"],
      `[spacetime] submitStacks count=${stacks.length}`,
      2,
    );
    const conn = await this.connection.connect();
    //await conn.reducers.submitInventoryStacks({ stacks });
  } */
} 
  
