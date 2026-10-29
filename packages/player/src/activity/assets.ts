/**
 * Local asset loading under a strict CSP (native.md N3–N5): the component stylesheet fallback, KaTeX CSS/fonts and
 * the optional bundled Inter font. Stylesheets are fetched as text and applied as constructable stylesheets, never
 * `<style>` text or style attributes. `@font-face` rules are registered on the document (shadow-root `@font-face` is
 * unreliable) with absolute same-origin URLs, woff2 only. No remote origin is ever referenced.
 */
import { INTER_FONT_FILES, katexStylesheetUrl, stylesheetAssetUrl, type FontFile } from './asset-urls.js';

export type { FontFile };
export { INTER_FONT_FILES };

export interface AssetLocations {
  katexCss: URL;
  fontUrl(font: FontFile): URL;
  /** Component stylesheet asset for environments without constructable stylesheets, when one is available. */
  stylesheet: URL | null;
}

/**
 * Asset URLs: from an explicit base laid out like `dist/activity/` (hosts that relocate assets), otherwise the
 * bundler-visible defaults next to the module (package build) or in `node_modules` (source tree).
 */
export function assetLocations(base?: string | URL): AssetLocations {
  if (base === undefined) return { katexCss: katexStylesheetUrl(), fontUrl: font => font.url(), stylesheet: stylesheetAssetUrl() };
  const text = String(base);
  const root = new URL(text.endsWith('/') ? text : `${text}/`, typeof location === 'object' ? location.href : undefined);
  return { katexCss: new URL('math/katex.min.css', root), fontUrl: font => new URL(font.path, root), stylesheet: new URL('activity.css', root) };
}

export interface ParsedFontFace { family: string; style: string; weight: string; unicodeRange: string | null; src: string }
const FONT_FACE = /@font-face\s*\{([^}]*)\}/g;
const declaration = (block: string, name: string): string | null => {
  const match = new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+)`, 'i').exec(block);
  return match ? match[1].trim() : null;
};

/** Parses `@font-face` rules to their first woff2 source (relative URL as written). Used to verify the font tables. */
export function parseFontFaces(css: string): ParsedFontFace[] {
  const rules: ParsedFontFace[] = [];
  for (const match of css.matchAll(FONT_FACE)) {
    const block = match[1];
    const family = declaration(block, 'font-family'), src = declaration(block, 'src');
    const woff2 = src ? /url\(\s*(['"]?)([^'")]+)\1\s*\)\s*format\(\s*['"]?woff2(?:-variations)?['"]?\s*\)/.exec(src) : null;
    if (!family || !woff2) continue;
    rules.push({ family: family.replace(/^['"]|['"]$/g, ''), style: declaration(block, 'font-style') ?? 'normal', weight: declaration(block, 'font-weight') ?? '400', unicodeRange: declaration(block, 'unicode-range'), src: woff2[2] });
  }
  return rules;
}

/** Removes `@font-face` rules (KaTeX's rules carry relative URLs; the faces are registered on the document instead). */
export const stripFontFaces = (css: string): string => css.replace(FONT_FACE, '');

/** `@font-face` CSS for font files; `src` supplies the URL (absolute same-origin, or `data:` inside a capture). */
export function fontFaceCss(fonts: readonly FontFile[], src: (font: FontFile) => string): string {
  return fonts.map(font => `@font-face{font-family:"${font.family}";font-style:${font.style};font-weight:${font.weight};font-display:${font.display};src:url("${src(font).replace(/["\\\n]/g, '')}") format("woff2")${font.unicodeRange ? `;unicode-range:${font.unicodeRange}` : ''}}`).join('\n');
}

/** Whether a CSS `unicode-range` value (e.g. `U+0000-00FF,U+0131`) includes `codePoint`; a missing range includes all. */
export function unicodeRangeIncludes(range: string | null, codePoint: number): boolean {
  if (!range) return true;
  return range.split(',').some(part => {
    const text = part.trim().toUpperCase().replace(/^U\+/, '');
    if (text.includes('?')) return codePoint >= parseInt(text.replace(/\?/g, '0'), 16) && codePoint <= parseInt(text.replace(/\?/g, 'F'), 16);
    const [low, high = low] = text.split('-').map(value => parseInt(value, 16));
    return Number.isFinite(low) && codePoint >= low && codePoint <= high;
  });
}

/** Fonts of `fonts` whose unicode-range covers at least one character of `text`. */
export const fontsForText = (fonts: readonly FontFile[], text: string): FontFile[] => {
  const codePoints = new Set<number>();
  for (const char of text) codePoints.add(char.codePointAt(0)!);
  return fonts.filter(font => [...codePoints].some(point => unicodeRangeIncludes(font.unicodeRange, point)));
};

const texts = new Map<string, Promise<string>>();
/** Fetches same-origin CSS text once per URL (`accept: text/css` also makes a dev server return raw CSS). */
export function fetchCss(url: URL): Promise<string> {
  let pending = texts.get(url.href);
  if (!pending) {
    pending = fetch(url.href, { headers: { accept: 'text/css' }, credentials: 'same-origin' })
      .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); });
    pending.catch(() => texts.delete(url.href));
    texts.set(url.href, pending);
  }
  return pending;
}

type ViewWindow = Window & typeof globalThis;
export const supportsConstructableSheets = (doc: Document): boolean => {
  const view = doc.defaultView as ViewWindow | null;
  try { return !!view && 'adoptedStyleSheets' in doc && typeof view.CSSStyleSheet === 'function' && 'replaceSync' in view.CSSStyleSheet.prototype; } catch { return false; }
};
export const createSheet = (doc: Document, cssText: string): CSSStyleSheet => {
  const sheet = new (doc.defaultView as ViewWindow).CSSStyleSheet();
  sheet.replaceSync(cssText);
  return sheet;
};
export function adoptSheet(root: Document | ShadowRoot, sheet: CSSStyleSheet): () => void {
  if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  return () => { root.adoptedStyleSheets = root.adoptedStyleSheets.filter(item => item !== sheet); };
}

const registeredFaces = new WeakMap<Document, Set<string>>();
/** Registers `@font-face` rules for local font files on the document once per URL (fonts load lazily on use). */
export function registerFonts(doc: Document, fonts: readonly FontFile[], locations: AssetLocations): void {
  if (!supportsConstructableSheets(doc)) return;
  let done = registeredFaces.get(doc);
  if (!done) { done = new Set(); registeredFaces.set(doc, done); }
  const fresh = fonts.filter(font => !done!.has(locations.fontUrl(font).href));
  if (!fresh.length) return;
  for (const font of fresh) done.add(locations.fontUrl(font).href);
  adoptSheet(doc, createSheet(doc, fontFaceCss(fresh, font => locations.fontUrl(font).href)));
}

const mathSheets = new WeakMap<Document, Map<string, Promise<CSSStyleSheet>>>();
/** KaTeX's stylesheet without its `@font-face` rules, as a constructable sheet (one per document and URL). */
export function mathStylesheet(doc: Document, locations: AssetLocations): Promise<CSSStyleSheet> {
  let byUrl = mathSheets.get(doc);
  if (!byUrl) { byUrl = new Map(); mathSheets.set(doc, byUrl); }
  const href = locations.katexCss.href;
  let pending = byUrl.get(href);
  if (!pending) {
    pending = fetchCss(locations.katexCss).then(css => createSheet(doc, stripFontFaces(css)));
    pending.catch(() => byUrl!.delete(href));
    byUrl.set(href, pending);
  }
  return pending;
}

/** Base64 of bytes (chunked; used only to embed local fonts as `data:` inside capture SVG documents). */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
