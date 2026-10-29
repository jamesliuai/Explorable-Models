/**
 * Styles of the schema 2.0 document surface under a strict content security policy (report §16; F5 of
 * docs/study-harness/performance.md): the surface stylesheet is applied as a constructable stylesheet adopted into the
 * document or shadow root that contains the surface — never as a `<style>` element or style attribute — so the surface
 * runs with `style-src 'self'` and no `'unsafe-inline'`. Where constructable stylesheets are missing it links the
 * packaged `surface.css` asset (`dist/surface.css`) or `<assetBase>/surface.css`. Reference-counted per root; one sheet
 * per document.
 */
import { surfaceStyles } from './styles.js';

type ViewWindow = Window & typeof globalThis;
declare const __EKP_PACKAGE_BUILD__: boolean | undefined;
/** True only in the esbuild package output, where `build.mjs` defines the constant. */
const PACKAGED = typeof __EKP_PACKAGE_BUILD__ === 'boolean' && __EKP_PACKAGE_BUILD__;
const STYLESHEET_FILE = './surface.css';
/**
 * Packaged stylesheet asset, used only where constructable stylesheets are missing. Not a literal URL on purpose:
 * hosts that rebundle the package and need the fallback pass `assetBase` (as for `@experiment-kit/player/activity`).
 */
const packagedStylesheet = (): string | null => PACKAGED ? new URL(STYLESHEET_FILE, import.meta.url).href : null;

const supported = (doc: Document): boolean => {
  const view = doc.defaultView as ViewWindow | null;
  try { return !!view && 'adoptedStyleSheets' in doc && typeof view.CSSStyleSheet === 'function' && 'replaceSync' in view.CSSStyleSheet.prototype; } catch { return false; }
};
const sheets = new WeakMap<Document, CSSStyleSheet>();
const users = new WeakMap<Document | ShadowRoot, { count: number; release: () => void }>();

/**
 * Applies the surface stylesheet to `root` (the surface's document or shadow root). Returns `ok: false` when no styling
 * mechanism is available (no constructable stylesheets and no known stylesheet asset); call `release` on unmount.
 */
export function adoptSurfaceStyles(node: Node, assetBase?: string | URL): { ok: boolean; release: () => void } {
  // A host can detach the surface before React runs the layout effect. getRootNode() then returns an element (or a
  // plain DocumentFragment), neither of which can adopt stylesheets. Use its owner document, with the same refcount.
  const root = node.nodeType === 9 || node.nodeType === 11 && 'host' in node ? node as Document | ShadowRoot : node.ownerDocument;
  if (!root) return { ok: false, release: () => undefined };
  const doc = 'createElement' in root ? root as Document : (root as ShadowRoot).ownerDocument;
  const existing = users.get(root);
  if (existing) { existing.count++; return { ok: true, release: releaser(root) }; }
  if (supported(doc)) {
    let sheet = sheets.get(doc);
    if (!sheet) { sheet = new (doc.defaultView as ViewWindow).CSSStyleSheet(); sheet.replaceSync(surfaceStyles); sheets.set(doc, sheet); }
    if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    const adopted = sheet;
    users.set(root, { count: 1, release: () => { root.adoptedStyleSheets = root.adoptedStyleSheets.filter(item => item !== adopted); } });
    return { ok: true, release: releaser(root) };
  }
  const href = assetBase !== undefined ? new URL('surface.css', String(assetBase).endsWith('/') ? String(assetBase) : `${String(assetBase)}/`).href : packagedStylesheet();
  if (!href) return { ok: false, release: () => undefined };
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  ('head' in root ? (root as Document).head : root).appendChild(link);
  users.set(root, { count: 1, release: () => link.remove() });
  return { ok: true, release: releaser(root) };
}

function releaser(root: Document | ShadowRoot): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = users.get(root);
    if (!entry) return;
    if (--entry.count <= 0) { entry.release(); users.delete(root); }
  };
}
