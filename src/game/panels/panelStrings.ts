/** Panel UI string lookups. Thin TS layer over the `localeLabel` /
 *  `localeVariant` wasm wrappers, scoped to the `panels` locale
 *  domain (`content/locales/panels/<lang>.json`). Panel strings are
 *  client-only chrome — titles, buttons, row labels, placeholders —
 *  so they resolve here rather than round-tripping through any
 *  sim-side path.
 *
 *  Schema: each panel is one locale entry keyed by its
 *  `content/panels/defaults.json` panel key. Its `label` is the
 *  title-bar text; every other string is a flat variant. So
 *  `panelTitle("settingsMenu")` → "Settings" and
 *  `panelText("settingsMenu", "logOut")` → "Log Out".
 *
 *  Both lookups fall back to the bare key on a miss (mirroring the
 *  card/aspect label callers) so a missing translation renders the
 *  dev-side key instead of throwing. The wasm module must be
 *  initialised (`initDefinitions()`) before these are called — same
 *  precondition as every other content lookup. */

import {
  localeLabel as wasmLocaleLabel,
  localeVariant as wasmLocaleVariant,
} from "../../content/pkg/resonantdust_content";

/** Active UI language. Single chokepoint — swap or make reactive when
 *  a language selector lands; every panel string flows through here. */
const LANG = "en";

const DOMAIN = "panels";

/** Title-bar text for `panelKey` (its `defaults.json` key). Falls back
 *  to `panelKey` if the locale has no entry. */
export function panelTitle(panelKey: string): string {
  try {
    return wasmLocaleLabel(DOMAIN, panelKey, LANG) ?? panelKey;
  } catch {
    return panelKey;
  }
}

/** A non-title string (`key`) declared on `panelKey`'s entry — button
 *  captions, row labels, placeholders. Falls back to `key` on a miss. */
export function panelText(panelKey: string, key: string): string {
  try {
    return wasmLocaleVariant(DOMAIN, panelKey, key, LANG) ?? key;
  } catch {
    return key;
  }
}
