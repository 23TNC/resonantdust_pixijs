import { debug } from "../../debug";
import type { ConnectionRegistry } from "./ConnectionRegistry";

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
 * `serverNowMs()`, which interpolates from the last capture forward
 * using the local monotonic delta — so even between updates the
 * estimate stays current. Used by `DataManager.promote()` to align
 * `ValidAtTable` promotion to the server's timeline instead of
 * `Date.now()`, eliminating the artificial "future-row" delay when
 * the client clock drifts behind the server's.
 *
 * Routing: all reducers go to `registry.shard` except `sendChatMessage`,
 * which targets `registry.chat`.
 */
export class ReducerManager {
  /** Server `Timestamp.microsSinceUnixEpoch` from the most recent
   *  reducer event we observed. `null` before the first event lands. */
  private serverMicrosAtCapture: bigint | null = null;

  /** Local `Date.now()` at the moment we captured the server timestamp.
   *  Paired with `serverMicrosAtCapture` to interpolate forward. */
  private localMillisAtCapture = 0;

  constructor(private readonly registry: ConnectionRegistry) {}

  /** Record a fresh server timestamp from a reducer event. Pairs it
   *  with `Date.now()` so `serverNowMs()` can interpolate forward
   *  using local monotonic time deltas. The newer capture replaces
   *  the older — no averaging, since SpacetimeDB timestamps already
   *  reflect actual server wall-clock at reducer-run time. */
  noteServerTime(microsSinceUnixEpoch: bigint): void {
    this.serverMicrosAtCapture = microsSinceUnixEpoch;
    this.localMillisAtCapture = Date.now();
  }

  /** Server wall-clock now, in unix milliseconds (float).
   *  Computed as `lastServerMicros/1000 + (Date.now() - lastLocalMillis)`
   *  to interpolate from the last capture forward.
   *
   *  Falls back to `Date.now()` before the first server timestamp
   *  lands (initial connect, before any reducer event has flowed
   *  through). Once a timestamp has been captured, this is the
   *  source of truth for "now" everywhere the client compares
   *  against server `valid_at` values (which are also unix ms). */
  serverNowMs(): number {
    if (this.serverMicrosAtCapture === null) return Date.now();
    const elapsedMillis = Date.now() - this.localMillisAtCapture;
    const nowMicros = this.serverMicrosAtCapture + BigInt(elapsedMillis) * 1000n;
    return Number(nowMicros) / 1_000;
  }

  /** Move the caller's soul along a client-computed path. Client
   *  A* runs in [pixijs/src/game/world/pathfind.ts](../../game/world/pathfind.ts);
   *  this just submits the result. The server validates adjacency +
   *  traversability per step and queues the per-step row writes. See
   *  [docs/MOVEMENT_REWRITE.md](../../../../docs/MOVEMENT_REWRITE.md). */
  async moveSoul(args: {
    soulId: number;
    path: Array<{ surface: number; macroZone: number; microZone: number }>;
  }): Promise<void> {
    debug.log(
      ["spacetime"],
      `[spacetime] moveSoul soul=${args.soulId} steps=${args.path.length}`,
      5,
    );
    const conn = await this.registry.shard.connect();
    await conn.reducers.moveSoul(args);
  }

  async equipCard(args: { cardId: number }): Promise<void> {
    debug.log(["spacetime"], `[spacetime] equipCard card=${args.cardId}`, 5);
    const conn = await this.registry.shard.connect();
    await conn.reducers.equipCard(args);
  }

  async createCharacter(args: { starterPackId: number }): Promise<void> {
    debug.log(
      ["spacetime"],
      `[spacetime] createCharacter starterPackId=${args.starterPackId}`,
      5,
    );
    const conn = await this.registry.shard.connect();
    await conn.reducers.createCharacter(args);
  }

  async proposeAction(args: {
    hex: number;
    root: number;
    slots: number[];
    surface: number;
    macroZone: number;
    microZone: number;
    microLocation: number;
    recipeId: number;
    rootDist: number;
  }): Promise<void> {
    debug.log(
      ["spacetime"],
      `[spacetime] proposeAction recipe=${args.recipeId} hex=${args.hex} root=${args.root} slots=[${args.slots.join(",")}] rootDist=${args.rootDist} surface=${args.surface} macroZone=${args.macroZone} microZone=0x${args.microZone.toString(16)} microLocation=${args.microLocation}`,
      5,
    );
    const conn = await this.registry.shard.connect();
    await conn.reducers.proposeAction(args);
  }

  async setLastLogin(): Promise<void> {
    debug.log(["spacetime", "chat"], "[spacetime] setLastLogin", 5);
    const conn = await this.registry.shard.connect();
    await conn.reducers.setLastLogin({});
  }

  /** Routes to the chat module (`registry.chat`). The chat module has no
   *  players table, so the caller must supply `senderPlayerId` and `senderName`
   *  explicitly (resolved from `PlayerManager.getPlayer()`). */
  async sendChatMessage(args: {
    senderPlayerId: number;
    senderName: string;
    body: string;
  }): Promise<void> {
    debug.log(
      ["spacetime", "chat"],
      `[spacetime] sendChatMessage len=${args.body.length}`,
      5,
    );
    const conn = await this.registry.chat.connect();
    await conn.reducers.sendChatMessage(args);
  }
}
