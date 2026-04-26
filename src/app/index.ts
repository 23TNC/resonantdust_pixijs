import type { Application } from "pixi.js";

let _app: Application | null = null;

export function initApp(app: Application): void {
  if (_app) throw new Error("App already initialized.");
  _app = app;
}

export function getApp(): Application {
  if (!_app) throw new Error("App not initialized.");
  return _app;
}
