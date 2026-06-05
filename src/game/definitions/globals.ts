import { sharedContent } from "./contentBoot";

/**
 * Client mirror of the DSL `<globals>` constants — the single source of truth
 * for card/cell dimensions, read from the wasm `globals()` export (which
 * resolves the `<globals>` bucket: `card_width`, `card_height`, `title_height`,
 * `hex_radius`, `hex_width`, `hex_height`, …). The engine no longer hardcodes
 * `RECT_CARD_*` / hex radius; both the DSL and the client read from here, so a
 * size change is a one-line content edit.
 *
 * All values are pixels (or px-derived). Access via `globals()` after
 * `initGlobals()` (called once at startup, after the content runtime loads).
 */
export type Globals = Readonly<Record<string, number>>;

let cache: Globals | null = null;

/** Build the globals map from the wasm module. Call after `initContent()`. */
export function initGlobals(): void {
  cache = JSON.parse(sharedContent().globals()) as Globals;
}

/** The loaded globals. Throws if `initGlobals()` wasn't called first. */
export function globals(): Globals {
  if (!cache) throw new Error("globals not initialised — call initGlobals() first");
  return cache;
}

/** One global by name, or `0` if absent (with a dev warning would be noise here;
 *  missing dimensions surface as zero-sized prims, which is visible). */
export function global(name: string): number {
  return globals()[name] ?? 0;
}
