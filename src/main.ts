import { Application } from "pixi.js";
import { setApp } from "./app";
import { bootstrap as loadDebugData } from "./spacetime/DebugData";
import { LoginScene, SceneManager } from "./scenes";

async function startApp(): Promise<void> {
  const root = document.getElementById("app");

  if (!root) {
    throw new Error("Missing #app root element");
  }

  document.documentElement.style.width = "100%";
  document.documentElement.style.height = "100%";
  document.body.style.margin = "0";
  document.body.style.width = "100%";
  document.body.style.height = "100%";

  root.style.width = "100vw";
  root.style.height = "100vh";
  root.style.overflow = "hidden";

  const app = new Application();
  await app.init({
    antialias: true,
    background: 0x0b111b,
    resizeTo: root,
  });

  setApp(app);

  root.appendChild(app.canvas);
  app.canvas.style.display = "block";

  loadDebugData();

  const sceneManager = new SceneManager(app.stage);
  sceneManager.setScene(new LoginScene(sceneManager));

  app.ticker.add((ticker) => {
    sceneManager.update(ticker);
  });

  console.log("[respoiler] debug data loaded, entering login scene");
}

void startApp();
