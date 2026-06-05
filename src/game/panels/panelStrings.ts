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

import { sharedLocales } from "../definitions/contentBoot";

const DOMAIN = "panels";

/** Title-bar text for `panelKey` (its `defaults.json` key). Falls back
 *  to `panelKey` if the locale has no entry. Key: `panels.<panelKey>.label`. */
export function panelTitle(panelKey: string): string {
  try {
    return sharedLocales().string(`${DOMAIN}.${panelKey}.label`) ?? panelKey;
  } catch {
    return panelKey;
  }
}

/** A non-title string (`key`) declared on `panelKey`'s entry — button
 *  captions, row labels, placeholders. Falls back to `key` on a miss.
 *  Key: `panels.<panelKey>.<key>`. */
export function panelText(panelKey: string, key: string): string {
  try {
    return sharedLocales().string(`${DOMAIN}.${panelKey}.${key}`) ?? key;
  } catch {
    return key;
  }
}
