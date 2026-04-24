import { Application } from "pixi.js";
import { bootstrap as loadDebugData } from './spacetime/debug_data';
import { GameView } from "./ui/game_view";

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
    width: Math.max(1, root.clientWidth),
    height: Math.max(1, root.clientHeight),
  });

  root.appendChild(app.canvas);
  app.canvas.style.display = "block";

  loadDebugData();
  const viewedId: number = 1;
  const gameView = new GameView({ app, viewedId });

  const resizeApp = (): void => {
    gameView.resize(root.clientWidth, root.clientHeight);
  };

  const resizeObserver = new ResizeObserver(() => {
    resizeApp();
  });

  resizeObserver.observe(root);
  window.addEventListener("resize", resizeApp);

  console.log("[respoiler] debug data loaded, rendering game view");
  gameView.render();
}

void startApp();
