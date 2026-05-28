import { Application } from "pixi.js";
import { debug, installPixiWarnInterceptor } from "./debug";

// Route PixiJS' internal `console.warn` chatter through `debug` so
// the `"pixi"` tag in `debug/config` gates visibility. Has to run
// before `new Application()` because Pixi can warn during init.
installPixiWarnInterceptor();
import { DrawCallCounter } from "./debug/DrawCallCounter";
import { TextureManager } from "./assets/textures/TextureManager";
import { CardTextureManager } from "./assets/textures/CardTextureManager";
import { LodTextureManager } from "./assets/textures/LodTextureManager";
import { ObjectManager } from "./assets/ObjectManager";
import { smallestLodUrls } from "./assets/lodUrls";
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
import { DomPanel } from "./ui/dom/DomPanel";
import panelDefaults from "./content/panels/defaults.json";
import { ZoneManager } from "./game/zones/ZoneManager";
import { unpackZoneId, WORLD_LAYER } from "./server/data/packing";
import { PanelTaskbar } from "./ui/dom/PanelTaskbar";
import { UiEditMode } from "./ui/dom/UiEditMode";
import { PanelSettingsPopup } from "./ui/dom/PanelSettingsPopup";
import { DebugPanel } from "./game/titlebar/DebugPanel";
import { SettingsMenu } from "./game/titlebar/SettingsMenu";

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
  const lodTextures = new LodTextureManager(textures, app.renderer);
  const objects = new ObjectManager(lodTextures);
  const drawCallCounter = new DrawCallCounter();
  drawCallCounter.patch(app.renderer);
  // App-level taskbars — appended to `#app` and live for the
  // session. `taskbar` is the bottom bar (primary app surfaces:
  // chat, future inventory / world panels). `topTaskbar` is the
  // top bar (system surfaces: debug HUD, settings). Each panel
  // picks which one it registers with via its `taskbar` option.
  const taskbar    = new PanelTaskbar({ position: "bottom" });
  const topTaskbar = new PanelTaskbar({ position: "top" });
  // App-wide UI-edit-mode flag. Off at session start; toggled
  // from the settings menu. Panels subscribe to it for the extra
  // action buttons + forced title-bar visibility while editing.
  // The grid avoids the two taskbar strips so snapped panels can't
  // partially overlap them — the available viewport between the
  // taskbars gets divided into whole cells.
  const uiEditMode = new UiEditMode({
    reservedTop:    PanelTaskbar.HEIGHT,
    reservedBottom: PanelTaskbar.HEIGHT,
  });
  // Shared per-panel settings popup, attached to the UiEditMode
  // after construction so the popup itself can reference DomPanel
  // without the import-cycle (UiEditMode → popup → DomPanel →
  // UiEditMode). When edit mode flips off, auto-close the popup
  // — its controls only make sense while editing.
  const panelSettingsPopup = new PanelSettingsPopup();
  uiEditMode.settingsPopup = panelSettingsPopup;
  uiEditMode.on((enabled) => {
    if (!enabled) panelSettingsPopup.close();
  });
  // App-level debug HUD + settings menu. Both pinned in the top
  // taskbar; the user opens / closes them via their pinned entries
  // (📊 and ⛯ on the right side of the top bar). Persistent across
  // scenes — the old per-scene title bar used to own these.
  const debugPanel   = new DebugPanel(topTaskbar,   uiEditMode);
  const settingsMenu = new SettingsMenu(topTaskbar, uiEditMode);
  // Edit mode is normally entered by clicking "Enter UI Edit
  // Mode" inside the settings menu, which leaves the menu
  // sitting on top of the panel that's about to be edited. Drop
  // the menu when edit mode flips on so the user has a clean
  // surface to interact with — and a fresh re-open later
  // restacks it above whatever else moved during editing.
  uiEditMode.on((enabled) => {
    if (enabled) settingsMenu.close();
  });

  // Bootstrap the wasm-built content crate before any code calls into the
  // definitions API. `initDefinitions` is idempotent — safe to await
  // multiple times. Run in parallel with font loading + card-sprite
  // pre-warm so cold start doesn't pay for them serially. Fonts must
  // finish before Pixi renders anything that uses them — otherwise
  // canvas-based Text caches a fallback-font rasterisation and never
  // re-renders.
  //
  // Pre-warm the smallest LOD bucket (64×64) for every aspect in
  // the catalog. This guarantees the LodTextureManager's fallback
  // chain (ideal LOD → cached substitute → white 64×64) always
  // lands on a real texture rather than the white floor while the
  // ideal LOD races to load. Higher LODs lazy-load on first
  // reference and fire `onLoad` so consumers re-resolve.
  await Promise.all([
    initDefinitions(),
    loadFonts(),
    lodTextures.prewarm(smallestLodUrls()),
  ]);

  // TextureRegistry reads its data from the wasm content crate, so it
  // must be initialised after initDefinitions resolves. Sync — just a
  // Map build.
  initTextures();

  // Content-shipped panel defaults — first-launch layout for every
  // panel that opts in via `defaultsKey`. Loaded once here so the
  // registry is populated before any DomPanel constructor runs.
  // Precedence: localStorage > content defaults > constructor
  // `defaultRect`. File is the FLAT map produced by the
  // "Copy All JSON" button in PanelSettingsPopup — top-level keys
  // are panel `defaultsKey`s, values are `PanelStateJSON` blobs.
  // Any key starting with `_` is treated as a comment / metadata
  // slot and filtered out by `setPanelDefaults` before lookup
  // (lets the JSON carry inline docs without a wrapper key
  // re-introducing the paste-format mismatch).
  // The cast is safe — every enum field is re-validated at apply
  // time by `readAnchor` / `readPin` / etc.
  DomPanel.setPanelDefaults(panelDefaults as Parameters<typeof DomPanel.setPanelDefaults>[0]);

  const definitions = new DefinitionManager();
  // const recipes = new RecipeManager(definitions);
  const zones = new ZoneManager();

  const connections = new ConnectionRegistry({
    uri: import.meta.env.VITE_SPACETIME_URI ?? "http://localhost:3000",
    env: import.meta.env.VITE_SPACETIME_ENV ?? "dev",
  });
  const reducers = new ReducerManager(connections);
  debugPanel.setReducers(reducers);
  connections.shard.addListener({
    onConnected: (_conn, identity) => {
      debug.log(["spacetime"], `[spacetime] shard connected as ${identity.toHexString()}`, 4);
      // Clock sync happens implicitly via `claim_or_login`: PlayerManager
      // subscribes to the player row before calling the reducer, so the
      // resulting row write is delivered as a `Reducer`-tagged event and
      // `captureReducerTimestamp` seeds `noteServerTime` from it. No
      // separate sync_clock call is needed — and wouldn't help anyway,
      // since sync_clock writes no rows and therefore produces no row
      // callback to capture the timestamp from.
    },
    onConnectError: (error: Error) => {
      console.error("[spacetime] shard connect error", error);
    },
    onDisconnected: (error?: Error) => {
      if (error) debug.warn(["spacetime"], `[spacetime] shard disconnected ${String(error)}`, 4);
      else debug.log(["spacetime"], "[spacetime] shard disconnected", 4);
    },
  });
  connections.chat.addListener({
    onConnected: (_conn, identity) => {
      debug.log(["spacetime"], `[spacetime] chat connected as ${identity.toHexString()}`, 4);
    },
    onConnectError: (error: Error) => {
      console.error("[spacetime] chat connect error", error);
    },
    onDisconnected: (error?: Error) => {
      if (error) debug.warn(["spacetime"], `[spacetime] chat disconnected ${String(error)}`, 4);
      else debug.log(["spacetime"], "[spacetime] chat disconnected", 4);
    },
  });
  const data = new DataManager(connections, reducers, definitions);

  // Per-frame promote: lifts elapsed `valid_at` rows from each table's
  // `server` map into `current` and fires `added`/`updated`/`removed` events
  // to subscribers. Without this, subscribers never see inbound data and
  // anything waiting on `current` (e.g. PlayerManager.waitForPlayer) hangs.
  // `promote()` reads server time from `ReducerManager.serverNowMs()`
  // internally (re-baselined on every reducer commit) — see `DataManager.promote`.
  app.ticker.add(() => data.promote());

  // Drive per-zone SDK subscriptions off the ZoneManager refcount.
  // Anything that calls `zones.ensure(zoneId)` /
  // `zones.ensureInventory(soulCardId)` (MainScene + MainLayout)
  // or that ZoneManager's anchor-driven recompute adds (zones
  // around each `setAnchor` target, on that anchor's surface)
  // bumps the zone to "active" → we open the matching SDK
  // subscription so the server starts pushing rows. Note: with
  // ZoneManager no longer seeding a default viewport anchor at
  // (0, 0), the "active" set starts empty at app boot — no zone
  // subscriptions until a caller actually sets an anchor.
  //
  // Two flavors, branched on the zoneId's layer:
  //
  //  - World zones (`layer === WORLD_LAYER`): `subscribeWorldZone`
  //    pulls both the `zones` row (tile data) AND world-surface
  //    `cards` / `souls` for that macro_zone.
  //  - Inventory / non-world zones: `subscribeCards` pulls cards
  //    for `(macro_zone, surface)`. No `zones` row to fetch.
  const subscribeZone = (zoneId: number) => {
    const { macroZone, layer } = unpackZoneId(zoneId);
    if (layer === WORLD_LAYER) {
      void data.subscriptions.subscribeWorldZone(macroZone);
    } else {
      void data.subscriptions.subscribeCards(zoneId);
    }
  };
  const unsubscribeZone = (zoneId: number) => {
    const { macroZone, layer } = unpackZoneId(zoneId);
    if (layer === WORLD_LAYER) {
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

  const playerSession = new PlayerManager(reducers, data);
  const souls = new SoulManager(playerSession, data, zones);

  // Feed the player_id into ZoneManager so client-local "who am I
  // signed in as" lookups (e.g. `localPlayerFactionFolder`) resolve.
  playerSession.on((player) => {
    zones.setPlayerId(player?.playerId ?? null);
    if (player) {
      // PlayerProfile mirror — covers blueprint_info / soul_info
      // capacity readouts and the player-scope blueprint
      // discovery bitfield. One-off install per login (the row is
      // keyed by player_id and the SDK dedupes by subscription
      // name).
      void data.subscriptions.subscribePlayerProfile(player.playerId);
    }
  });

  // Reconnect-time clock re-sync. On the FIRST connect of a session,
  // `PlayerManager.claimOrLogin` is the sync primitive — its server
  // row write is delivered as a `Reducer`-tagged event that seeds
  // `noteServerTime`. But on a mid-session reconnect, `claim_or_login`
  // doesn't fire (the player is already cached), so the offset window
  // is left with stale captures from the previous connection.
  // `setLastLogin` is the per-reconnect re-sync hook: it updates the
  // already-subscribed player row, which delivers as a `Reducer`-tagged
  // event and re-seeds the window. `setLastLogin` is grace-exempt
  // server-side (see `players::set_last_login`) so a stale-capture
  // submission won't be rejected.
  connections.shard.addListener({
    onConnected: () => {
      if (!playerSession.isLoggedIn()) return;
      void reducers.setLastLogin().catch((err) => {
        debug.warn(["spacetime"], `[spacetime] reconnect setLastLogin failed: ${String(err)}`, 4);
      });
    },
  });

  // RTT is measured by bookending `performance.now()` around every
  // shard reducer call inside `ReducerManager`. Each user action
  // contributes a sample to the rolling window; the panel's
  // `bestRttMs` reads the minimum over the window (closest to pure
  // network RTT, since cheap reducers bottom out near network-only
  // timing). No periodic polling — the estimate refreshes on
  // activity. Stale during idle, which is fine for a diagnostic
  // surface.

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

  const ctx: GameContext = {
    app,
    scenes,
    textures,
    cardTextures,
    lodTextures,
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
    taskbar,
    topTaskbar,
    uiEditMode,
    debugPanel,
    settingsMenu,
    panels: null,
    cards: null,
    layout: null,
    game: null,
    input: null,
    actions: null,
    logs: null,
    worldOverlay: null,
    worldHexAt: null,
    onTilesChanged: null,
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
