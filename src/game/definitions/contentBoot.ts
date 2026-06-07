/** Content bootstrap — load the DSL corpus + locales from the gate, server-
 *  authoritatively, into the wasm `Content` / `Locales` runtimes.
 *
 *  The gate serves `GET /content` → `{ version, rd: [[name,text]…],
 *  locales: [[domain,json]…] }` (the exact bytes it validates against, so the
 *  client and gate agree by construction). We init the wasm module once, fetch
 *  the corpus, and construct the two runtimes. `DefinitionManager` /
 *  `panelStrings` read the shared singletons; nothing here is build-time —
 *  reloading picks up live content.
 *
 *  Call `initContent()` once during `main.ts` startup, before constructing
 *  anything that touches `DefinitionManager`. */

import init, { Content, Locales } from "../../shared/pkg/resonantdust_shared";

/** Shape of the gate's `/content` payload. */
interface ContentPayload {
  version: string;
  /** `[name, text]` pairs of `.rd` sources — feeds `new Content(...)`. */
  rd: [string, string][];
  /** `[domain, json]` pairs of locale catalogs — feeds `new Locales(...)`. */
  locales: [string, string][];
}

let content: Content | null = null;
let locales: Locales | null = null;
let contentVersion = "";
let initPromise: Promise<void> | null = null;

/** HTTP origin of the gate, derived from its WS URI (ws→http, drop `/ws`). */
function gateHttpBase(): string {
  const ws =
    (import.meta.env.VITE_GATE_URI as string | undefined) ?? "ws://localhost:8473/ws";
  return ws.replace(/^ws/, "http").replace(/\/ws$/, "");
}

/** Load the wasm runtime + fetch the gate corpus into `Content` / `Locales`.
 *  Idempotent — one in-flight promise; subsequent calls await it. Throws on a
 *  failed fetch or an unparseable corpus (loud at boot, not mid-game). */
export async function initContent(): Promise<void> {
  if (content) return;
  if (!initPromise) {
    initPromise = (async () => {
      await init();
      const resp = await fetch(`${gateHttpBase()}/content`);
      if (!resp.ok) {
        throw new Error(`content fetch failed: ${resp.status} ${resp.statusText}`);
      }
      const payload = (await resp.json()) as ContentPayload;
      content = new Content(JSON.stringify(payload.rd));
      locales = new Locales(JSON.stringify(payload.locales));
      contentVersion = payload.version;
    })();
  }
  await initPromise;
}

const reloadListeners = new Set<() => void>();

/** Subscribe to content reloads (a runtime add/modify pushed by the gate).
 *  Fired after `Content`/`Locales` are swapped, so listeners re-derive any
 *  content-derived caches and re-render. Returns an unsubscribe fn. */
export function onContentReloaded(cb: () => void): () => void {
  reloadListeners.add(cb);
  return () => reloadListeners.delete(cb);
}

/** Re-fetch `/content` and rebuild the `Content`/`Locales` singletons in place,
 *  then notify listeners. Driven by the gate's `content_changed` push. No-op (no
 *  notify) if the version is unchanged. Returns the new version. The wasm module
 *  is already initialised, so this only refetches + reconstructs. */
export async function reloadContent(): Promise<string> {
  const resp = await fetch(`${gateHttpBase()}/content`);
  if (!resp.ok) {
    throw new Error(`content reload failed: ${resp.status} ${resp.statusText}`);
  }
  const payload = (await resp.json()) as ContentPayload;
  if (payload.version === contentVersion) return contentVersion;
  content = new Content(JSON.stringify(payload.rd));
  locales = new Locales(JSON.stringify(payload.locales));
  contentVersion = payload.version;
  for (const cb of [...reloadListeners]) {
    try {
      cb();
    } catch (err) {
      console.error("[contentBoot] reload listener threw", err);
    }
  }
  return contentVersion;
}

/** The loaded content runtime. Throws if `initContent()` hasn't resolved. */
export function sharedContent(): Content {
  if (!content) throw new Error("content not initialised — await initContent() first");
  return content;
}

/** The loaded locale runtime. Throws if `initContent()` hasn't resolved. */
export function sharedLocales(): Locales {
  if (!locales) throw new Error("locales not initialised — await initContent() first");
  return locales;
}

/** The loaded corpus version fingerprint (hex). Empty until `initContent()`. */
export function getContentVersion(): string {
  return contentVersion;
}
