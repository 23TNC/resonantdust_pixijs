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
 * Two robustness measures stack on top of the raw capture:
 *
 *   1. **Sliding-window offset selection.** A single capture pair is
 *      polluted by client-side JS event-loop jitter — when the runtime
 *      is busy (frame stalls, GC), the SDK callback fires noticeably
 *      after the bytes arrived, so `Date.now()` at callback-time lags
 *      the true receive moment and the captured offset reads
 *      artificially low. We keep the last `SAMPLE_WINDOW` captures and
 *      pick the one with the **largest** server-ahead-of-client offset
 *      — the freshest, least-queued measurement.
 *
 *   2. **Constant client lag (`CLIENT_LAG_MS`).** Even with smoothing,
 *      the estimate can overshoot the real server clock by a few ms,
 *      causing `promote()` to fire just before the server's wall-clock
 *      reaches `valid_at`. A subsequent client-issued reducer then
 *      races the row's validity window and bounces with `card not
 *      found`. Running `serverNowMs()` a constant `CLIENT_LAG_MS`
 *      behind absorbs that overshoot — at the cost of every progress
 *      bar / "ready" UI lagging by the same amount, which is
 *      imperceptible at 200ms.
 *
 * Routing: all reducers go to `registry.shard` except `sendChatMessage`,
 * which targets `registry.chat`.
 */
export class ReducerManager {
  /** Sliding window of recent reducer-event captures. Each entry pairs
   *  the server's `event.value.timestamp` (microseconds) with the
   *  local `Date.now()` (ms) at the moment the SDK callback fired.
   *  Bounded at `SAMPLE_WINDOW` — oldest entry evicted on insert. */
  private readonly captures: Array<{
    serverMicros: bigint;
    localMillis: number;
  }> = [];

  /** Window size for offset selection. Large enough to ride through a
   *  few jittery callbacks without losing the underlying signal, small
   *  enough that genuine clock drift on either side gets reflected
   *  within a few seconds of activity. */
  private static readonly SAMPLE_WINDOW = 16;

  /** Constant lag applied to `serverNowMs()` so the client treats
   *  rows as valid slightly later than the server stamped them. See
   *  class-level doc for the rationale. */
  private static readonly CLIENT_LAG_MS = 200;

  constructor(private readonly registry: ConnectionRegistry) {}

  /** Record a fresh server timestamp from a reducer event. Appends
   *  to the sliding window; `serverNowMs()` picks the
   *  largest-observed-offset entry out of the window, which
   *  corresponds to the least-jittered (freshest-delivered) sample. */
  noteServerTime(microsSinceUnixEpoch: bigint): void {
    this.captures.push({
      serverMicros: microsSinceUnixEpoch,
      localMillis: Date.now(),
    });
    if (this.captures.length > ReducerManager.SAMPLE_WINDOW) {
      this.captures.shift();
    }
  }

  /** Server wall-clock now, in unix milliseconds (float), minus
   *  `CLIENT_LAG_MS`. Picks the window entry with the largest
   *  `serverMicros/1000 - localMillis` offset and interpolates
   *  forward using `Date.now() - thatLocalMillis`. The max-offset
   *  pick discards captures whose `localMillis` was inflated by JS
   *  event-loop delays — those samples produce an artificially low
   *  offset and would cause `serverNowMs()` to lag.
   *
   *  Falls back to `Date.now() - CLIENT_LAG_MS` before the first
   *  capture lands (initial connect). Once any capture exists, this
   *  is the source of truth for "now" everywhere the client compares
   *  against server `valid_at` values. */
  serverNowMs(): number {
    if (this.captures.length === 0) {
      return Date.now() - ReducerManager.CLIENT_LAG_MS;
    }
    let best = this.captures[0];
    let bestOffsetMs = Number(best.serverMicros) / 1_000 - best.localMillis;
    for (let i = 1; i < this.captures.length; i++) {
      const c = this.captures[i];
      const offsetMs = Number(c.serverMicros) / 1_000 - c.localMillis;
      if (offsetMs > bestOffsetMs) {
        best = c;
        bestOffsetMs = offsetMs;
      }
    }
    const elapsedMillis = Date.now() - best.localMillis;
    const nowMicros = best.serverMicros + BigInt(elapsedMillis) * 1000n;
    return Number(nowMicros) / 1_000 - ReducerManager.CLIENT_LAG_MS;
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

  async unequipCard(args: {
    cardId: number;
    targetX: number;
    targetY: number;
  }): Promise<void> {
    debug.log(
      ["spacetime"],
      `[spacetime] unequipCard card=${args.cardId} target=(${args.targetX},${args.targetY})`,
      5,
    );
    const conn = await this.registry.shard.connect();
    await conn.reducers.unequipCard(args);
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

  /** Submit a recipe proposal. New wire format (per the unified
   *  card model — see docs/RECIPE_TAPE_REWRITE.md):
   *
   *  - `recipeId`: stable u16 from `recipes/id.json`.
   *  - `surface` / `macroZone` / `microZone`: root's intended world
   *    location (or inventory address).
   *  - `root`: root card_id.
   *  - `bindings`: per-iterator card_id lists. `bindings[i]` is the
   *    cards the recipe's `i`-th iterator binds to, in offset
   *    order. Branch 0 (tile) accepts `0` as the no-card sentinel
   *    when the action targets a synthetic tile. */
  async proposeAction(args: {
    recipeId: number;
    surface: number;
    macroZone: number;
    microZone: number;
    root: number;
    bindings: number[][];
  }): Promise<void> {
    debug.log(
      ["spacetime"],
      `[spacetime] proposeAction recipe=${args.recipeId} root=${args.root} surface=${args.surface} macroZone=${args.macroZone} microZone=0x${args.microZone.toString(16)} bindings=${JSON.stringify(args.bindings)}`,
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
