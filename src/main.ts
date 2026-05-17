import { Application } from "pixi.js";
import { debug } from "./debug";
import { DrawCallCounter } from "./debug/DrawCallCounter";
import { TextureManager } from "./assets/textures/TextureManager";
import { CardTextureManager } from "./assets/textures/CardTextureManager";
import { ObjectTextureManager } from "./assets/textures/ObjectTextureManager";
import { ObjectManager } from "./assets/ObjectManager";
import { initTextures } from "./game/definitions/TextureRegistry";
import { loadFonts } from "./assets/fonts";
import { DefinitionManager, initDefinitions } from "./game/definitions/DefinitionManager";
import { LifecycleResolutionManager } from "./game/lifecycle/LifecycleResolutionManager";
// import { RecipeManager } from "./definitions/RecipeManager";
import { PlayerManager } from "./server/player/PlayerManager";
import { SoulManager } from "./server/player/SoulManager";
import type { GameContext } from "./GameContext";
import { LoginScene } from "./scenes/login/LoginScene";
import { SceneManager } from "./scenes/SceneManager";
import { ConnectionRegistry } from "./server/spacetime/ConnectionRegistry";
import { ReducerManager } from "./server/spacetime/ReducerManager";
import { DataManager } from "./server/data/DataManager";
import { ZoneManager } from "./game/zones/ZoneManager";
import { unpackMacroZone, unpackZoneId, WORLD_LAYER } from "./server/data/packing";

interface Runtime {
  app: Application;
  scenes: SceneManager;
  connections: ConnectionRegistry;
  playerSession: PlayerManager;
  souls: SoulManager;
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
    // HiDPI rendering: rasterize the framebuffer + every Pixi
    // RenderTexture (card atlases, text, etc.) at the device's pixel
    // density so glyphs and strokes stay crisp. `autoDensity` lets
    // Pixi handle the CSS-size scaling so the stage coordinate space
    // still operates in CSS pixels — input handling and layout don't
    // need to know the difference.
    //
    // TODO(settings): expose this as a user-facing toggle once the
    // chat-settings panel grows into a real settings surface. Some
    // players on integrated GPUs / mobile will want to drop back to
    // resolution = 1 to recover fill-rate; the cap at 2 already
    // protects DPR-3 macOS/iOS devices from paying 9× cost.
    resolution: Math.min(window.devicePixelRatio, 2),
    autoDensity: true,
  });

  const host = document.getElementById("app");
  if (!host) throw new Error("#app element not found");
  host.appendChild(app.canvas);

  const scenes = new SceneManager(app);
  const textures = new TextureManager(app.renderer);
  const cardTextures = new CardTextureManager(app.renderer, textures);
  const objectTextures = new ObjectTextureManager(textures);
  const objects = new ObjectManager(objectTextures);
  const drawCallCounter = new DrawCallCounter();
  drawCallCounter.patch(app.renderer);

  // Bootstrap the wasm-built content crate before any code calls into the
  // definitions API. `initDefinitions` is idempotent — safe to await
  // multiple times. Run in parallel with font loading so cold start
  // doesn't pay for them serially. Fonts must finish before Pixi
  // renders anything that uses them — otherwise canvas-based Text
  // caches a fallback-font rasterisation and never re-renders.
  await Promise.all([
    initDefinitions(),
    loadFonts(),
  ]);

  // TextureRegistry reads its data from the wasm content crate, so it
  // must be initialised after initDefinitions resolves. Sync — just a
  // Map build.
  initTextures();

  const definitions = new DefinitionManager();
  // const recipes = new RecipeManager(definitions);
  const zones = new ZoneManager();

  const connections = new ConnectionRegistry({
    uri: import.meta.env.VITE_SPACETIME_URI ?? "http://47.222.135.56:3000",
    env: import.meta.env.VITE_SPACETIME_ENV ?? "dev",
  });
  connections.shard.addListener({
    onConnected: (_conn, identity) => {
      debug.log(["spacetime"], `[spacetime] shard connected as ${identity.toHexString()}`);
    },
    onConnectError: (error: Error) => {
      console.error("[spacetime] shard connect error", error);
    },
    onDisconnected: (error?: Error) => {
      if (error) debug.warn(["spacetime"], `[spacetime] shard disconnected ${String(error)}`);
      else debug.log(["spacetime"], "[spacetime] shard disconnected");
    },
  });
  connections.chat.addListener({
    onConnected: (_conn, identity) => {
      debug.log(["spacetime"], `[spacetime] chat connected as ${identity.toHexString()}`);
    },
    onConnectError: (error: Error) => {
      console.error("[spacetime] chat connect error", error);
    },
    onDisconnected: (error?: Error) => {
      if (error) debug.warn(["spacetime"], `[spacetime] chat disconnected ${String(error)}`);
      else debug.log(["spacetime"], "[spacetime] chat disconnected");
    },
  });
  const reducers = new ReducerManager(connections);
  const data = new DataManager(connections, reducers, definitions);

  // Per-frame promote: lifts elapsed `valid_at` rows from each table's
  // `server` map into `current` and fires `added`/`updated`/`removed` events
  // to subscribers. Without this, subscribers never see inbound data and
  // anything waiting on `current` (e.g. PlayerManager.waitForPlayer) hangs.
  // `promote()` reads server time from `ReducerManager.serverNowMs()`
  // internally (re-baselined on every reducer commit) — see `DataManager.promote`.
  app.ticker.add(() => data.promote());

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

  const playerSession = new PlayerManager(connections.shard, data);
  const souls = new SoulManager(playerSession, data);

  // Lifecycle resolution: client-side state machine that submits
  // propose_action calls for the success or failure recipe of any
  // owned lifecycle-pending card. See docs/LIFECYCLE_REWRITE.md
  // for context. Bootstrap-scoped — lives for the application
  // lifetime, observes cards via DataManager and login via
  // PlayerManager.
  const lifecycle = new LifecycleResolutionManager({
    data,
    reducers,
    definitions,
    playerSession,
  });
  lifecycle.start();

  // Drive ZoneManager's `"soul"` anchor off the local soul card's
  // current `macro_zone`. Whenever the soul row arrives or moves
  // between world chunks, the soul anchor follows — its surrounding
  // zone ring stays subscribed regardless of where the camera (the
  // `"viewport"` anchor) is panned. Without this, a player who pans
  // away from their soul would stop receiving updates about their own
  // avatar's neighbourhood.
  souls.on((soul) => {
    if (!soul || soul.surface < WORLD_LAYER) return;
    const { zoneQ, zoneR } = unpackMacroZone(soul.macroZone);
    zones.setAnchor("soul", zoneQ, zoneR);
  });

  const ctx: GameContext = {
    app,
    scenes,
    textures,
    cardTextures,
    objectTextures,
    objects,
    drawCallCounter,
    definitions,
    // recipes,
    connections,
    reducers,
    playerSession,
    souls,
    lifecycle,
    data,
    zones,
    cards: null,
    layout: null,
    game: null,
    input: null,
    actions: null,
    logs: null,
    worldOverlay: null,
  };
  scenes.setContext(ctx);

  connections.connectAll();

  await scenes.change(new LoginScene());

  return { app, scenes, connections, playerSession, souls, data, zones };
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
    rt.souls.dispose();
    rt.data.dispose();
    rt.playerSession.dispose();
    rt.connections.disconnectAll();
    await rt.scenes.dispose();
    rt.app.destroy(true, { children: true, texture: true });
    document
      .querySelectorAll("[data-fatal-error]")
      .forEach((el) => el.remove());
  });
}
