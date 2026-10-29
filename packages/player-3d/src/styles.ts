/**
 * Stylesheet of the spatial renderer, applied as a constructable stylesheet adopted into the root that contains the
 * mount element (the learner card's shadow root, or the document), reference-counted per root (native.md N4: no
 * `style` attributes, no `<style>` text). Layout that the renderer cannot work without (overlay positioning, canvas
 * sizing) is also set through CSSOM on the elements, so the view stays usable where constructable sheets are missing.
 * Colours come only from the surface's `--eka-*` tokens, with the surface's light defaults as fallbacks.
 */
export const SPATIAL_STYLESHEET = String.raw`
.eka-spatial:has(>.ek3){overflow:visible;min-height:0;background:transparent}
.ek3 [hidden]{display:none!important}
.ek3{display:grid;gap:var(--eka-s1,.25rem);min-width:0;color:var(--eka-text,#17212b)}
.ek3-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--eka-s1,.25rem)}
.ek3-button{display:inline-flex;align-items:center;justify-content:center;min-height:2.25rem;min-width:2.25rem;padding:0 .7em;border:1px solid var(--eka-border-strong,#7a8692);border-radius:6px;background:var(--eka-background,#fff);color:var(--eka-text,#17212b);font:inherit;font-size:.875em;font-weight:550;line-height:1.2;cursor:pointer}
.ek3-button:hover{background:var(--eka-surface-strong,#e9eef3)}
.ek3-button[aria-pressed=true]{background:var(--eka-surface-strong,#e9eef3);border-color:var(--eka-text,#17212b);box-shadow:inset 0 -3px 0 var(--eka-primary,#1d5fa6)}
.ek3-button:focus-visible{outline:3px solid var(--eka-focus,#1a62c7);outline-offset:2px}
.ek3-sep{width:1px;align-self:stretch;margin:2px 2px;background:var(--eka-border,#c9d2db)}
.ek3-viewport{position:relative;width:100%;aspect-ratio:4/3;min-height:15rem;max-height:34rem;overflow:hidden;border-radius:6px;background:var(--eka-surface,#f5f7f9);touch-action:pan-y;cursor:grab;user-select:none;-webkit-user-select:none}
.ek3-viewport[data-dragging=true]{cursor:grabbing}
.ek3-viewport:focus-visible{outline:3px solid var(--eka-focus,#1a62c7);outline-offset:2px}
.ek3-canvas{display:block;width:100%;height:100%}
.ek3-labels{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.ek3-label{position:absolute;left:0;top:0;white-space:nowrap;font-size:.8125em;font-weight:650;line-height:1.2;color:var(--eka-text,#17212b);
  text-shadow:0 0 2px var(--eka-surface,#f5f7f9),0 0 2px var(--eka-surface,#f5f7f9),0 0 4px var(--eka-surface,#f5f7f9)}
.ek3-label[data-kind=tick]{font-size:.75em;font-weight:450;color:var(--eka-text-muted,#4a5866)}
.ek3-label[data-kind=axis]{font-size:.875em;font-style:italic}
.ek3-label[data-select]{pointer-events:auto;cursor:pointer}
.ek3-label[data-selected=true]{text-decoration:underline;text-underline-offset:.15em}
.ek3-state{position:absolute;inset:0;display:grid;align-content:center;justify-items:center;gap:var(--eka-s2,.5rem);padding:var(--eka-s3,.75rem);text-align:center;
  background:var(--eka-surface,#f5f7f9);background:color-mix(in srgb,var(--eka-surface,#f5f7f9) 92%,transparent);font-size:.9375em}
.ek3-state[hidden]{display:none}
.ek3-state-title{font-weight:650}
.ek3-hint,.ek3-key{font-size:.8125em;color:var(--eka-text-muted,#4a5866)}
.ek3-notes{display:grid;gap:2px;margin:0;padding:0;list-style:none;font-size:.875em;color:var(--eka-text-muted,#4a5866)}
.ek3-notes li::before{content:"•";margin-right:.45em;color:var(--eka-muted,#66727f)}
.ek3-notes li[data-kind=limit],.ek3-notes li[data-kind=undefined],.ek3-notes li[data-kind=numerical-limit]{color:var(--eka-text,#17212b)}
.ek3-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
@media (forced-colors:active){.ek3-viewport:focus-visible,.ek3-button:focus-visible{outline-color:Highlight}}
`;

const sheets = new WeakMap<Document, CSSStyleSheet>();
const users = new WeakMap<Document | ShadowRoot, number>();

type ViewWindow = Window & typeof globalThis;
const supported = (doc: Document): boolean => {
  const view = doc.defaultView as ViewWindow | null;
  try { return !!view && 'adoptedStyleSheets' in doc && typeof view.CSSStyleSheet === 'function' && 'replaceSync' in view.CSSStyleSheet.prototype; } catch { return false; }
};

/** Adopts the stylesheet into the root containing `element`; returns its (idempotent) release function. */
export function adoptSpatialStyles(element: Element): () => void {
  const doc = element.ownerDocument;
  const node = element.getRootNode();
  const root = (node instanceof (doc.defaultView as ViewWindow).ShadowRoot ? node : doc) as Document | ShadowRoot;
  if (!supported(doc)) return () => undefined;
  let sheet = sheets.get(doc);
  if (!sheet) {
    sheet = new (doc.defaultView as ViewWindow).CSSStyleSheet();
    sheet.replaceSync(SPATIAL_STYLESHEET);
    sheets.set(doc, sheet);
  }
  const count = users.get(root) ?? 0;
  if (count === 0 && !root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  users.set(root, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (users.get(root) ?? 1) - 1;
    if (left > 0) { users.set(root, left); return; }
    users.delete(root);
    root.adoptedStyleSheets = root.adoptedStyleSheets.filter(item => item !== sheet);
  };
}
