import { Application } from "pixi.js";
import { debug } from "./debug";
import { DrawCallCounter } from "./debug/DrawCallCounter";
import { TextureManager } from "./assets/TextureManager";
import { DefinitionManager, initDefinitions } from "./game/definitions/DefinitionManager";
// import { RecipeManager } from "./definitions/RecipeManager";
import { PlayerManager } from "./server/player/PlayerManager";
import type { GameContext } from "./GameContext";
import { LoginScene } from "./scenes/login/LoginScene";
import { SceneManager } from "./scenes/SceneManager";
import { ConnectionManager } from "./server/spacetime/ConnectionManager";
import { ReducerManager } from "./server/spacetime/ReducerManager";
import { DataManager } from "./server/data/DataManager";
import { ZoneManager } from "./game/zones/ZoneManager";
import { unpackZoneId, WORLD_LAYER } from "./server/data/packing";

interface Runtime {
  app: Application;
  scenes: SceneManager;
  connection: ConnectionManager;
  playerSession: PlayerManager;
  data: DataManager;
  zones: ZoneManager;
}

let runtime: Runtime | null = null;

async function main(): Promise<Runtime> {
  const app = new Application();
  await app.init({
    background: 0x101418,
    resizeTo: window,
    antialias: true,
  });

  const host = document.getElementById("app");
  if (!host) throw new Error("#app element not found");
  host.appendChild(app.canvas);

  const scenes = new SceneManager(app);
  const textures = new TextureManager(app.renderer);
  const drawCallCounter = new DrawCallCounter();
  drawCallCounter.patch(app.renderer);

  // Bootstrap the wasm-built content crate before any code calls into the
  // definitions API. `initDefinitions` is idempotent — safe to await
  // multiple times.
  await initDefinitions();
  const definitions = new DefinitionManager();
  // const recipes = new RecipeManager(definitions);
  const zones = new ZoneManager();

  const connection = new ConnectionManager({
    uri: import.meta.env.VITE_SPACETIME_URI ?? "http://localhost:3000",
    databaseName: import.meta.env.VITE_SPACETIME_DB ?? "resonantdust-dev",
  });
  connection.addListener({
    onConnected: (_conn, identity) => {
      debug.log(["spacetime"], `[spacetime] connected as ${identity.toHexString()}`);
    },
    onConnectError: (error) => {
      console.error("[spacetime] connect error", error);
    },
    onDisconnected: (error) => {
      if (error) debug.warn(["spacetime"], `[spacetime] disconnected ${String(error)}`);
      else debug.log(["spacetime"], "[spacetime] disconnected");
    },
  });
  const reducers = new ReducerManager(connection);
  const data = new DataManager(connection);

  // Per-frame promote: lifts elapsed `valid_at` rows from each table's
  // `server` map into `current` and fires `added`/`updated`/`removed` events
  // to subscribers. Without this, subscribers never see inbound data and
  // anything waiting on `current` (e.g. PlayerManager.waitForPlayer) hangs.
  app.ticker.add(() => data.promote(Date.now() / 1000));

  // Drive per-zone SDK subscriptions off the ZoneManager refcount.
  // Anything that calls `zones.ensure(zoneId)` (GameScene for the
  // inventory zone) or that ZoneManager's anchor-driven recompute
  // adds (world zones around each anchor) bumps the zone to "active"
  // → we open the matching SDK subscription so the server starts
  // pushing rows.
  //
  // Two flavors, branched on the zoneId's layer:
  //
  //  - World zones (`layer >= WORLD_LAYER`): subscribeWorldZone pulls
  //    both the `zones` row (tile data for LayoutWorld) AND world-
  //    surface `cards` for that macro_zone. Pulling just
  //    `subscribeCards` leaves the tile grid empty because the
  //    `zones` table never gets data.
  //  - Inventory / non-world zones: subscribeCards pulls cards for
  //    `(macro_zone, surface)`. No `zones` row to fetch.
  const subscribeZone = (zoneId: number) => {
    const { macroZone, layer } = unpackZoneId(zoneId);
    if (layer >= WORLD_LAYER) {
      void data.subscriptions.subscribeWorldZone(macroZone);
    } else {
      void data.subscriptions.subscribeCards(zoneId);
    }
  };
  const unsubscribeZone = (zoneId: number) => {
    const { macroZone, layer } = unpackZoneId(zoneId);
    if (layer >= WORLD_LAYER) {
      data.subscriptions.unsubscribeWorldZone(macroZone);
    } else {
      data.subscriptions.unsubscribeCards(zoneId);
    }
  };
  // Catch zones already in "active" — ZoneManager's constructor runs
  // `recomputeWorldZones` and seeds the active tier before any listener
  // can register. `onAdded` does NOT replay existing entries, so a
  // listener registered after construction would miss everything that
  // landed during construction. Iterate the initial set explicitly,
  // then subscribe for future additions.
  for (const zoneId of zones.zonesIn("active")) subscribeZone(zoneId);
  zones.onAdded("active", subscribeZone);
  zones.onRemoved("active", unsubscribeZone);

  const playerSession = new PlayerManager(connection, data);

  const ctx: GameContext = {
    app,
    scenes,
    textures,
    drawCallCounter,
    definitions,
    // recipes,
    connection,
    reducers,
    playerSession,
    data,
    zones,
    cards: null,
    layout: null,
    game: null,
    input: null,
    actions: null,
  };
  scenes.setContext(ctx);

  connection.connect().catch(() => undefined);

  await scenes.change(new LoginScene());

  return { app, scenes, connection, playerSession, data, zones };
}

function showFatalError(error: unknown): void {
  const host = document.getElementById("app") ?? document.body;
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  const overlay = document.createElement("div");
  overlay.setAttribute("data-fatal-error", "");
  overlay.style.cssText =
    "position:fixed;inset:0;background:#1a0a0a;color:#ff8a80;font-family:ui-monospace,monospace;font-size:13px;padding:24px;white-space:pre-wrap;overflow:auto;z-index:9999";
  overlay.textContent = `Bootstrap failed:\n\n${message}`;
  host.appendChild(overlay);
}

main()
  .then((rt) => {
    runtime = rt;
  })
  .catch((err) => {
    console.error("[main] bootstrap failed", err);
    showFatalError(err);
  });

if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    const rt = runtime;
    runtime = null;
    if (!rt) return;
    rt.zones.dispose();
    rt.data.dispose();
    rt.playerSession.dispose();
    rt.connection.disconnect();
    await rt.scenes.dispose();
    rt.app.destroy(true, { children: true, texture: true });
    document
      .querySelectorAll("[data-fatal-error]")
      .forEach((el) => el.remove());
  });
}
