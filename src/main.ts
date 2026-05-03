import { Application } from "pixi.js";
import { DefinitionManager } from "./definitions/DefinitionManager";
import { RecipeManager } from "./definitions/RecipeManager";
import { PlayerSession } from "./features/PlayerSession";
import type { GameContext } from "./GameContext";
import { LoginScene } from "./scenes/LoginScene";
import { SceneManager } from "./scenes/SceneManager";
import { DbConnection } from "./server/bindings";
import { SpacetimeManager } from "./server/SpacetimeManager";
import { DataManager } from "./state/DataManager";
import { ZoneManager } from "./zones/ZoneManager";

interface Runtime {
  app: Application;
  scenes: SceneManager;
  spacetime: SpacetimeManager;
  playerSession: PlayerSession;
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
  const definitions = new DefinitionManager();
  const recipes = new RecipeManager(definitions);
  const data = new DataManager();
  const zones = new ZoneManager();

  const spacetime = new SpacetimeManager({
    uri: import.meta.env.VITE_SPACETIME_URI ?? "http://localhost:3000",
    databaseName: import.meta.env.VITE_SPACETIME_DB ?? "resonantdust-dev",
    builderFactory: () => DbConnection.builder(),
    data,
    onConnected: (_conn, identity) => {
      console.log("[spacetime] connected as", identity.toHexString());
    },
    onConnectError: (error) => {
      console.error("[spacetime] connect error", error);
    },
    onDisconnected: (error) => {
      if (error) console.warn("[spacetime] disconnected", error);
      else console.log("[spacetime] disconnected");
    },
  });

  data.attachSpacetime(spacetime);
  data.attachZones(zones);

  const playerSession = new PlayerSession(spacetime, data);

  const ctx: GameContext = {
    app,
    scenes,
    definitions,
    recipes,
    spacetime,
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

  spacetime.connect().catch(() => undefined);

  await scenes.change(new LoginScene());

  return { app, scenes, spacetime, playerSession, data, zones };
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
    rt.spacetime.disconnect();
    await rt.scenes.dispose();
    rt.app.destroy(true, { children: true, texture: true });
    document
      .querySelectorAll("[data-fatal-error]")
      .forEach((el) => el.remove());
  });
}
