import { debug } from "../../debug";
import type { ConnectionManager } from "./ConnectionManager";

/**
 * Owns reducer calls. Each reducer is a thin wrapper that awaits the
 * connection and forwards to the SDK's typed reducers. Centralising them
 * here keeps the SDK boundary in one file and gives us a single place to
 * add cross-cutting concerns (logging, retry, telemetry).
 *
 * Also owns the client's notion of **server time**. Every reducer
 * SpacetimeDB processes delivers an `EventContext` to its onInsert /
 * onUpdate / onDelete callbacks; the context's `event.value.timestamp`
 * is the server's wall-clock at the moment the reducer ran. The
 * `SubscriptionManager` forwards that timestamp to `noteServerTime`,
 * which records the (server-micros, local-millis) pair. Callers that
 * need to ask "what does the server think now is?" call
 * `serverNowSecs()`, which interpolates from the last capture forward
 * using the local monotonic delta — so even between updates the
 * estimate stays current. Used by `DataManager.promote()` to align
 * `ValidAtTable` promotion to the server's timeline instead of
 * `Date.now()/1000`, eliminating the artificial "future-row" delay
 * when the client clock drifts behind the server's.
 */
export class ReducerManager {
  /** Server `Timestamp.microsSinceUnixEpoch` from the most recent
   *  reducer event we observed. `null` before the first event lands. */
  private serverMicrosAtCapture: bigint | null = null;

  /** Local `Date.now()` at the moment we captured the server timestamp.
   *  Paired with `serverMicrosAtCapture` to interpolate forward. */
  private localMillisAtCapture = 0;

  constructor(private readonly connection: ConnectionManager) {}

  /** Record a fresh server timestamp from a reducer event. Pairs it
   *  with `Date.now()` so `serverNowSecs()` can interpolate forward
   *  using local monotonic time deltas. The newer capture replaces
   *  the older — no averaging, since SpacetimeDB timestamps already
   *  reflect actual server wall-clock at reducer-run time. */
  noteServerTime(microsSinceUnixEpoch: bigint): void {
    this.serverMicrosAtCapture = microsSinceUnixEpoch;
    this.localMillisAtCapture = Date.now();
  }

  /** Server wall-clock now, in unix seconds (float with ms precision).
   *  Computed as `lastServerMicros + (Date.now() - lastLocalMillis)*1000`
   *  to interpolate from the last capture forward.
   *
   *  Falls back to `Date.now() / 1000` before the first server
   *  timestamp lands (initial connect, before any reducer event has
   *  flowed through). Once a timestamp has been captured, this is
   *  the source of truth for "now" everywhere the client compares
   *  against server `valid_at` values. */
  serverNowSecs(): number {
    if (this.serverMicrosAtCapture === null) return Date.now() / 1000;
    const elapsedMillis = Date.now() - this.localMillisAtCapture;
    const nowMicros = this.serverMicrosAtCapture + BigInt(elapsedMillis) * 1000n;
    return Number(nowMicros) / 1_000_000;
  }

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
      `[spacetime] proposeAction recipe=${args.recipeId} hex=${args.hex} root=${args.root} slots=[${args.slots.join(",")}] rootDist=${args.rootDist} surface=${args.surface} macroZone=${args.macroZone} microZone=0x${args.microZone.toString(16)} microLocation=${args.microLocation}`,
      5,
    );
    const conn = await this.connection.connect();
    await conn.reducers.proposeAction(args);
  }
}
