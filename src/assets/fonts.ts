import { BitmapFont } from "pixi.js";

/** Font-loading. Browsers won't pick up a font referenced by Pixi's
 *  canvas-based `Text` rendering unless it's registered in
 *  `document.fonts` before the first text rasterisation. We use the
 *  `FontFace` API for the registration so it sits in plain JS — no
 *  separate CSS file required. Also bakes the card-title bitmap font
 *  (`BitmapFont.install`) so generic-card text shares one glyph atlas.
 *
 *  Awaiting `loadFonts()` once at bootstrap (see `main.ts`) blocks the
 *  first render until every font is ready, which sidesteps the
 *  fallback-cache trap where Pixi rasterises with the fallback font
 *  and never re-renders the same Text with the real one. */
/** Per-face spec. `weight` follows CSS numeric weights so the browser
 *  picks the right face for a given `Text.style.fontWeight`. Today
 *  every consumer uses the default `"normal"` weight (≈ 400), but
 *  the others are registered so we can vary weight later without
 *  re-touching this list. */
const FONTS: { family: string; url: string; weight: string }[] = [
  { family: "Noto Emoji", url: "/fonts/NotoEmoji/NotoEmoji-Light.ttf",    weight: "300" },
  { family: "Noto Emoji", url: "/fonts/NotoEmoji/NotoEmoji-Regular.ttf",  weight: "400" },
  { family: "Noto Emoji", url: "/fonts/NotoEmoji/NotoEmoji-Medium.ttf",   weight: "500" },
  { family: "Noto Emoji", url: "/fonts/NotoEmoji/NotoEmoji-SemiBold.ttf", weight: "600" },
  { family: "Noto Emoji", url: "/fonts/NotoEmoji/NotoEmoji-Bold.ttf",     weight: "700" },
];

/** Family name to use in Pixi `Text` styles for emoji glyphs (gear,
 *  toolbar icons). Exported so consumers don't repeat the literal. */
export const NOTO_EMOJI_FAMILY = "Noto Emoji";

/** The generic-card text primitive (`TextPrim`) bakes ONE bitmap font at this
 *  size and family and scales the node to hit each label's px height — so every
 *  card title shares a single glyph atlas (batched quads) and zoom is a free
 *  transform, never a re-rasterization. The browser font is system `sans-serif`
 *  for now (no FontFace load needed; `BitmapFont.install` rasterizes from it). */
export const TEXT_FONT = "card";
export const TEXT_BAKE_PX = 64;

let loadPromise: Promise<void> | null = null;

/** Idempotent. Resolves once every font in `FONTS` is loaded and
 *  registered (and the baked card-title bitmap font is installed). Subsequent
 *  calls return the cached promise. Awaited once at bootstrap, so the bitmap
 *  font exists before the first card draws. */
export function loadFonts(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await Promise.all(
      FONTS.map(async ({ family, url, weight }) => {
        const face = new FontFace(family, `url(${url})`, { weight });
        await face.load();
        document.fonts.add(face);
      }),
    );
    // Bake the card-title font once (after the FontFaces are registered, so a
    // custom family would be available; today it's system sans-serif). `fill`
    // is white so the prim's `tint` is the colour.
    BitmapFont.install({ name: TEXT_FONT, style: { fontFamily: "sans-serif", fontSize: TEXT_BAKE_PX, fill: 0xffffff } });
  })();
  return loadPromise;
}
