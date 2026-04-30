import { Application } from "pixi.js";
import { initApp } from "./app";
import { LoginScene, SceneManager } from "./scenes";
import { bootstrapCardDefinitions } from "@/definitions";

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

  initApp(app);
  root.appendChild(app.canvas);
  app.canvas.style.display = "block";

  bootstrapCardDefinitions();

  const sceneManager = new SceneManager();
  sceneManager.setScene(new LoginScene(sceneManager));
}

void startApp();
