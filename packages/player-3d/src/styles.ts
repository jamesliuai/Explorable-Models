/**
 * Stylesheet of the spatial renderer, applied as a constructable stylesheet adopted into the root that contains the
 * mount element (the learner card's shadow root, or the document), reference-counted per root (native.md N4: no
 * `style` attributes, no `<style>` text). Layout that the renderer cannot work without (overlay positioning, canvas
 * sizing) is also set through CSSOM on the elements, so the view stays usable where constructable sheets are missing.
 * Colours come only from the surface's `--ema-*` tokens, with the surface's light defaults as fallbacks (0.3 warm-neutral
 * presentation: neutral pressed state, small radii, no coloured control chrome).
 */
export const SPATIAL_STYLESHEET = String.raw`
.ema-spatial:has(>.em3){overflow:visible;min-height:0;background:transparent}
.em3 [hidden]{display:none!important}
.em3{display:grid;gap:var(--ema-s1,.25rem);min-width:0;color:var(--ema-text,#1f1e1c)}
.em3-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s1,.25rem)}
.em3-button{display:inline-flex;align-items:center;justify-content:center;min-height:2rem;min-width:2rem;padding:0 .7em;border:1px solid var(--ema-border-strong,#8b877e);border-radius:5px;background:var(--ema-surface,#f3f2ee);color:var(--ema-text,#1f1e1c);font:inherit;font-size:.8125em;font-weight:500;line-height:1.2;cursor:pointer}
.em3-button:hover{background:var(--ema-surface-strong,#e8e6e0)}
.em3-button[aria-pressed=true]{background:var(--ema-surface-strong,#e8e6e0);border-color:var(--ema-text,#1f1e1c);box-shadow:inset 0 -2px 0 var(--ema-text,#1f1e1c)}
.em3-button:focus-visible{outline:2px solid var(--ema-focus,#1f1e1c);outline-offset:2px}
.em3-sep{width:1px;align-self:stretch;margin:2px 2px;background:var(--ema-border,#dedbd3)}
.em3-viewport{position:relative;width:100%;aspect-ratio:4/3;min-height:15rem;max-height:34rem;overflow:hidden;border-radius:5px;background:var(--ema-surface,#f3f2ee);touch-action:pan-y;cursor:grab;user-select:none;-webkit-user-select:none}
.em3-viewport[data-dragging=true]{cursor:grabbing}
.em3-viewport:focus-visible{outline:2px solid var(--ema-focus,#1f1e1c);outline-offset:2px}
.em3-canvas{display:block;width:100%;height:100%}
.em3-labels{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.em3-label{position:absolute;left:0;top:0;white-space:nowrap;font-size:.8125em;font-weight:600;line-height:1.2;color:var(--ema-text,#1f1e1c);
  text-shadow:0 0 2px var(--ema-surface,#f3f2ee),0 0 2px var(--ema-surface,#f3f2ee),0 0 4px var(--ema-surface,#f3f2ee)}
.em3-label[data-kind=tick]{font-size:.75em;font-weight:450;color:var(--ema-text-muted,#57544d)}
.em3-label[data-kind=axis]{font-size:.875em;font-style:italic}
.em3-label[data-select]{pointer-events:auto;cursor:pointer}
.em3-label[data-selected=true]{text-decoration:underline;text-underline-offset:.15em}
.em3-state{position:absolute;inset:0;display:grid;align-content:center;justify-items:center;gap:var(--ema-s2,.5rem);padding:var(--ema-s3,.75rem);text-align:center;
  background:var(--ema-surface,#f3f2ee);background:color-mix(in srgb,var(--ema-surface,#f3f2ee) 92%,transparent);font-size:.875em}
.em3-state[hidden]{display:none}
.em3-state-title{font-weight:600}
.em3-hint,.em3-key{font-size:.8125em;color:var(--ema-text-muted,#57544d)}
.em3-notes{display:grid;gap:2px;margin:0;padding:0;list-style:none;font-size:.8125em;color:var(--ema-text-muted,#57544d)}
.em3-notes li::before{content:"•";margin-right:.45em;color:var(--ema-muted,#6f6b63)}
.em3-notes li[data-kind=limit],.em3-notes li[data-kind=undefined],.em3-notes li[data-kind=numerical-limit]{color:var(--ema-text,#1f1e1c)}
.em3-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
@media (forced-colors:active){.em3-viewport:focus-visible,.em3-button:focus-visible{outline-color:Highlight}}
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
