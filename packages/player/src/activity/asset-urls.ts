/**
 * Static URLs of the lazily used local assets. Each file is referenced with its own literal
 * `new URL('…', import.meta.url)` so module bundlers (Vite, Rollup, webpack) can discover and emit it; the URLs are
 * created only when called. In the source tree they point into `node_modules`; the package build (`build.mjs`)
 * rewrites the two prefixes to `./math/` and `./fonts/inter/` and copies exactly these files there, so the
 * published layout is `dist/activity/{math/katex.min.css, math/fonts/*.woff2, fonts/inter/*.woff2}`.
 * The Inter table below and the deferred KaTeX table in math-font-urls.ts mirror their packages' `@font-face` rules
 * (woff2 only); a unit test checks both against those stylesheets.
 */

export interface FontFile {
  family: string;
  style: 'normal' | 'italic';
  weight: string;
  unicodeRange: string | null;
  display: 'block' | 'swap';
  /** Path relative to an `assetBase` laid out like `dist/activity/`. */
  path: string;
  url(): URL;
}

export const katexStylesheetUrl = (): URL => new URL('../../../../node_modules/katex/dist/katex.min.css', import.meta.url);

const inter = (file: string, unicodeRange: string, url: () => URL): FontFile =>
  ({ family: 'Inter Variable', style: 'normal', weight: '100 900', unicodeRange, display: 'swap', path: `fonts/inter/${file}`, url });

/** Latin, Latin Extended and Greek subsets of Inter (Greek letters are common in STEM labels); other scripts use system fonts. */
export const INTER_FONT_FILES: readonly FontFile[] = Object.freeze([
  inter('inter-greek-wght-normal.woff2', 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF',
    () => new URL('../../../../node_modules/@fontsource-variable/inter/files/inter-greek-wght-normal.woff2', import.meta.url)),
  inter('inter-latin-ext-wght-normal.woff2', 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
    () => new URL('../../../../node_modules/@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2', import.meta.url)),
  inter('inter-latin-wght-normal.woff2', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
    () => new URL('../../../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', import.meta.url)),
]);

const STYLESHEET_FILE = './activity.css';
declare const __EMA_PACKAGE_BUILD__: boolean | undefined;
/** True only in the esbuild package output, where `build.mjs` defines the constant. */
export const PACKAGED = typeof __EMA_PACKAGE_BUILD__ === 'boolean' && __EMA_PACKAGE_BUILD__;
/**
 * Component stylesheet asset (`dist/activity/activity.css`), used only where constructable stylesheets are missing.
 * Not a literal URL on purpose: hosts that rebundle the package and need the fallback pass `assetBase`.
 */
export const stylesheetAssetUrl = (): URL | null => PACKAGED ? new URL(STYLESHEET_FILE, import.meta.url) : null;
