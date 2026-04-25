// src/app/AppContext.ts
import type { Application } from "pixi.js";

let app: Application | null = null;

export function setApp(value: Application): void {
  app = value;
}

export function getApp(): Application {
  if (!app) {
    throw new Error("Pixi Application has not been initialized.");
  }

  return app;
}