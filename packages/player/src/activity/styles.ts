/**
 * Component stylesheet for the learner surface (report §10.1, native.md N4). 0.3 presentation: warm-neutral surfaces,
 * hairline separators instead of nested boxes, small radii, no pills, a neutral primary action, the prose serif for the
 * title and stage instruction and the interface font elsewhere; colour stays on data marks and meaningful states, and
 * every state keeps a non-colour cue (glyph, dash, rule or label). Applied as a constructable stylesheet:
 * `mountStudyActivity` adopts it into its shadow root; React hosts use `adoptActivityStyles(document)` (the component
 * also adopts it into whatever root it renders in). Every selector is scoped under `.ema`, so it is safe in a document.
 * Layout responds to the card's own width through container queries, not the viewport:
 * narrow side panel (≤ 360px), inline conversation card (≈ 390–640px) and expanded workspace (≥ 800px, controls beside
 * the scene). Colours come only from `--ema-*` tokens; motion tokens collapse under reduced motion.
 */
import { adoptSheet, createSheet, supportsConstructableSheets } from './assets.js';
import { stylesheetAssetUrl } from './asset-urls.js';

export const ACTIVITY_STYLESHEET = String.raw`
:host{display:block;min-width:0}
.ema{--ema-s1:calc(var(--ema-space) * .5);--ema-s2:var(--ema-space);--ema-s3:calc(var(--ema-space) * 1.5);--ema-s4:calc(var(--ema-space) * 2);--ema-s5:calc(var(--ema-space) * 3);
  container:ema-card/inline-size;display:block;box-sizing:border-box;min-width:0;max-width:100%;color:var(--ema-text);background:var(--ema-background);
  font-family:var(--ema-font-family);font-size:var(--ema-font-size);line-height:1.5;font-variant-numeric:tabular-nums;text-size-adjust:100%;-webkit-text-size-adjust:100%;
  border:1px solid var(--ema-border);border-radius:var(--ema-radius);color-scheme:light;overflow-wrap:break-word;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.ema[data-theme=dark]{color-scheme:dark}
.ema[data-variant=embedded]{border:0;border-radius:0}
.ema *,.ema *::before,.ema *::after{box-sizing:border-box}
.ema :where(h1,h2,h3,h4,h5,h6,p,ul,ol,dl,dd,figure,fieldset,legend,blockquote){margin:0;padding:0}
.ema :where(ul,ol){list-style:none}
.ema fieldset{border:0;min-width:0}
.ema :where(button,input,select,textarea){font:inherit;color:inherit;letter-spacing:inherit}
.ema :focus{outline:none}
.ema :focus-visible{outline:2px solid var(--ema-focus);outline-offset:2px;border-radius:2px}
.ema svg :focus-visible{outline:none}
.ema-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}

.ema-card{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--ema-s3);padding:var(--ema-s4) var(--ema-s4) var(--ema-s3);min-width:0}
.ema[data-variant=embedded] .ema-card{padding:0;gap:var(--ema-s3)}
.ema-main,.ema-side,.ema-panel,.ema-nav,.ema-control,.ema-figure,.ema-equations,.ema-equation,.ema-alternatives{grid-template-columns:minmax(0,1fr)}
.ema-header{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:var(--ema-s1) var(--ema-s3);min-width:0}
.ema-heading{display:grid;gap:2px;min-width:0;flex:1 1 16em}
.ema-title{font-family:var(--ema-prose-family);font-size:1.25em;line-height:1.3;font-weight:600;overflow-wrap:anywhere}
.ema-subtitle{color:var(--ema-text-muted);font-size:.8125em}
.ema-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--ema-s1)}
.ema-chip{display:inline-flex;align-items:baseline;gap:.35em;font-size:.8125em;line-height:1.3;color:var(--ema-text-muted);white-space:nowrap}
.ema-chip[data-tone]{color:var(--ema-text)}
.ema-chip .ema-glyph{color:var(--ema-tone,var(--ema-text-muted))}
.ema-instruction{font-family:var(--ema-prose-family);font-size:1.0625em;line-height:1.55;max-width:68ch;border-radius:3px}
.ema[data-variant=embedded] .ema-instruction{font-family:var(--ema-font-family);font-size:.875em;line-height:1.45;color:var(--ema-text-muted)}
.ema-instruction:focus-visible{outline-offset:4px}
.ema-glyph{display:inline-block;min-width:1em;text-align:center;font-weight:700;line-height:1}

[data-tone=info]{--ema-tone:var(--ema-reference)}
[data-tone=success]{--ema-tone:var(--ema-positive)}
[data-tone=warning]{--ema-tone:var(--ema-warning)}
[data-tone=error]{--ema-tone:var(--ema-error)}
[data-tone=neutral]{--ema-tone:var(--ema-muted)}
.ema-banner{display:flex;flex-wrap:wrap;align-items:flex-start;gap:var(--ema-s1) var(--ema-s2);padding:var(--ema-s2) var(--ema-s3);border:0;border-left:2px solid var(--ema-tone);border-radius:0 calc(var(--ema-radius) - 2px) calc(var(--ema-radius) - 2px) 0;background:var(--ema-surface)}
.ema-banner>.ema-glyph{color:var(--ema-tone);margin-top:.2em}
.ema-banner-body{flex:1 1 14em;min-width:0;display:grid;gap:2px}
.ema-banner-title{font-weight:600}
.ema-banner-actions{display:flex;flex-wrap:wrap;gap:var(--ema-s1)}

.ema-button{display:inline-flex;align-items:center;justify-content:center;gap:.4em;min-height:2rem;min-width:2rem;padding:0 .75em;border:1px solid var(--ema-border-strong);border-radius:calc(var(--ema-radius) - 2px);background:var(--ema-surface);color:var(--ema-text);font-size:.875em;font-weight:500;line-height:1.2;cursor:pointer;transition:background-color var(--ema-motion-duration) ease,border-color var(--ema-motion-duration) ease;text-align:center}
.ema-button:hover{background:var(--ema-surface-strong)}
.ema-button[aria-pressed=true]{background:var(--ema-surface-strong);border-color:var(--ema-text);box-shadow:inset 0 -2px 0 var(--ema-text)}
.ema-button[aria-disabled=true],.ema-button:disabled{opacity:.5;cursor:not-allowed}
.ema-button-primary{background:var(--ema-action);border-color:var(--ema-action);color:var(--ema-on-action);font-weight:600}
.ema-button-primary:hover{background:var(--ema-action);box-shadow:inset 0 0 0 99em color-mix(in srgb,var(--ema-on-action) 10%,transparent)}
.ema-button-quiet{border-color:transparent;background:transparent;color:var(--ema-text-muted);text-decoration:underline;text-decoration-color:var(--ema-border-strong);text-underline-offset:.2em;padding:0 .4em}
.ema-button-quiet:hover{background:transparent;color:var(--ema-text);text-decoration-color:currentColor}
.ema-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s1)}
.ema-play{display:inline-grid;place-items:center;min-width:6.25em}
.ema-play-face{grid-area:1/1;display:inline-flex;align-items:center;justify-content:center;gap:.4em}
.ema-play-spare{visibility:hidden}

.ema-workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--ema-s4);align-items:start;min-width:0}
.ema-main,.ema-side{display:grid;gap:var(--ema-s3);min-width:0;align-content:start}
.ema-panel{display:grid;gap:var(--ema-s2);min-width:0;padding:var(--ema-s3) 0 0;border:0;border-top:1px solid var(--ema-border);background:transparent}
.ema-side>.ema-panel:first-child{padding-top:0;border-top:0}
.ema-panel-title{font-size:.8125em;font-weight:600;line-height:1.3;color:var(--ema-text-muted)}
.ema-panel-note{color:var(--ema-text-muted);font-size:.8125em}

.ema-figure{display:grid;min-width:0;border:1px solid var(--ema-border);border-radius:var(--ema-radius);background:var(--ema-background);overflow:hidden}
.ema-figure[data-tentative=true]{border-style:dashed;border-color:var(--ema-border-strong)}
.ema-figure-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--ema-s1) var(--ema-s2);padding:var(--ema-s2) var(--ema-s3) 0}
.ema-figure-title{font-size:.875em;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
.ema-figure-body{position:relative;min-width:0;padding:var(--ema-s1) var(--ema-s2) 0}
.ema-figure-foot{display:grid;gap:var(--ema-s1);padding:var(--ema-s1) var(--ema-s3) var(--ema-s2)}
.ema-plot{display:block;width:100%;height:auto;max-width:100%;touch-action:pan-y;user-select:none;-webkit-user-select:none}
.ema-plot-area{cursor:grab}
.ema-plot-area[data-panning=true]{cursor:grabbing}
.ema-plot-focus{fill:none;stroke:var(--ema-focus);stroke-width:2.5;visibility:hidden}
.ema-canvas:focus-visible .ema-plot-focus{visibility:visible}
.ema-grid-line{stroke:var(--ema-border);stroke-width:1}
.ema-axis-line{stroke:var(--ema-border-strong);stroke-width:1}
.ema-zero-line{stroke:var(--ema-muted);stroke-width:1}
.ema-tick{fill:var(--ema-text-muted);font-size:.75em}
.ema-axis-title{fill:var(--ema-text);font-size:.8125em;font-weight:500}
.ema-legend-text{fill:var(--ema-text);font-size:.8125em}
.ema-label{fill:var(--ema-text);font-size:.8125em;font-weight:600;paint-order:stroke;stroke:var(--ema-background);stroke-width:3px;stroke-linejoin:round}
.ema-leader{stroke:var(--ema-text-muted);stroke-width:1;stroke-dasharray:2 2}
.ema-callout-plate{fill:var(--ema-background);stroke:var(--ema-border-strong);stroke-width:1}
.ema-callout{stroke:none}
.ema-role-primary{--ema-mark:var(--ema-primary)}
.ema-role-secondary{--ema-mark:var(--ema-secondary)}
.ema-role-accent{--ema-mark:var(--ema-accent)}
.ema-role-muted{--ema-mark:var(--ema-muted)}
.ema-role-positive{--ema-mark:var(--ema-positive)}
.ema-role-negative{--ema-mark:var(--ema-negative)}
.ema-role-warning{--ema-mark:var(--ema-warning)}
.ema-role-reference{--ema-mark:var(--ema-reference)}
.ema-stroke{stroke:var(--ema-mark);fill:none;stroke-linecap:round;stroke-linejoin:round}
.ema-fill{fill:var(--ema-mark);stroke:var(--ema-mark)}
.ema-region{fill:var(--ema-mark);fill-opacity:.14;stroke:var(--ema-mark)}
.ema-hollow{fill:var(--ema-background);stroke:var(--ema-mark)}
.ema-handle{cursor:pointer}
.ema-handle[data-draggable=true]{cursor:grab;touch-action:none}
.ema-focus-ring{fill:none;stroke:var(--ema-focus);stroke-width:2;visibility:hidden}
.ema-handle:focus-visible .ema-focus-ring,.ema-handle[aria-selected=true] .ema-focus-ring{visibility:visible}
.ema-hit{fill:transparent;stroke:none}
.ema-marks,.ema-labels,.ema-axes{pointer-events:none}
.ema-clip,.ema-clip-sizer{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s1) var(--ema-s2);padding:var(--ema-s1) var(--ema-s2);border:1px dashed var(--ema-warning);border-radius:calc(var(--ema-radius) - 2px);background:var(--ema-surface);font-size:.8125em}
.ema-clip .ema-glyph,.ema-clip-sizer .ema-glyph{color:var(--ema-warning)}
.ema-clip-text{flex:1 1 12em;min-width:0}
.ema-clip-slot{display:grid;align-items:start}
.ema-clip-slot>*{grid-area:1/1;min-width:0}
.ema-clip-sizer{visibility:hidden}
.ema-clip-sizer [data-ema-sizer-text]::before{content:attr(data-ema-sizer-text)}
.ema-clip-none{display:flex;align-items:center;gap:var(--ema-s1);padding:var(--ema-s1) var(--ema-s2);border:1px solid transparent;font-size:.8125em;color:var(--ema-text-muted)}
.ema-clip-none .ema-glyph{color:var(--ema-muted)}
.ema-notes{display:grid;gap:2px;font-size:.8125em;color:var(--ema-text-muted)}
.ema-notes li::before{content:"•";color:var(--ema-muted);margin-right:.45em}
.ema-description{font-family:var(--ema-prose-family);font-size:.9375em;max-width:68ch}

.ema-nav{display:grid;gap:var(--ema-s2)}
.ema-nav-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s1) var(--ema-s2)}
.ema-position{font-weight:600;font-variant-numeric:tabular-nums;min-width:7.5em}
.ema-terminal{font-size:.8125em;color:var(--ema-text-muted)}

.ema-control{display:grid;gap:var(--ema-s1);min-width:0}
.ema-control+.ema-control{padding-top:var(--ema-s2)}
.ema-control-section{display:grid;gap:var(--ema-s2);min-width:0}
.ema-control-section+.ema-control-section,.ema-control+.ema-control-section,.ema-control-section+.ema-control{padding-top:var(--ema-s3);border-top:1px solid var(--ema-border)}
.ema-section-title{font-size:.8125em;font-weight:600;line-height:1.3;color:var(--ema-text-muted)}
.ema-inline-status{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px var(--ema-s2);padding:var(--ema-s1) 0 var(--ema-s1) var(--ema-s2);border:0;border-left:2px solid var(--ema-tone,var(--ema-border-strong));font-size:.8125em}
.ema-inline-status>.ema-glyph{color:var(--ema-tone)}
.ema-inline-text{flex:1 1 12em;min-width:0}
.ema-inline-actions{display:inline-flex;flex-wrap:wrap;gap:var(--ema-s1)}
.ema-inline-actions .ema-button{min-height:2rem}
.ema-control-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px var(--ema-s2)}
.ema-control-label{font-weight:500}
.ema-control-value{font-variant-numeric:tabular-nums;color:var(--ema-text);font-weight:600}
.ema-control-value[data-tentative=true]{font-style:italic}
.ema-control-hint{font-size:.8125em;color:var(--ema-text-muted)}
.ema-reset{display:grid;gap:var(--ema-s1);justify-items:start;min-width:0;padding-top:var(--ema-s2);border-top:1px solid var(--ema-border)}
.ema-slider{width:100%;min-width:0;margin:0;height:1.75rem;accent-color:var(--ema-text);touch-action:pan-y;cursor:pointer;background:transparent}
.ema-slider[aria-disabled=true]{cursor:not-allowed;opacity:.5}
.ema-exact{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s1)}
.ema-input{min-width:0;width:6em;flex:1 1 6em;max-width:11em;min-height:2rem;padding:0 .55em;border:1px solid var(--ema-border-strong);border-radius:calc(var(--ema-radius) - 2px);background:var(--ema-background);font-variant-numeric:tabular-nums}
.ema-input[aria-invalid=true]{border-color:var(--ema-error);box-shadow:inset 0 0 0 1px var(--ema-error)}
.ema-input[readonly]{background:var(--ema-surface);color:var(--ema-text-muted)}
.ema-select{min-height:2rem;min-width:0;max-width:100%;padding:0 .45em;border:1px solid var(--ema-border-strong);border-radius:calc(var(--ema-radius) - 2px);background:var(--ema-background)}
.ema-unit{color:var(--ema-text-muted)}
.ema-error{display:flex;gap:.4em;align-items:flex-start;color:var(--ema-error);font-size:.8125em;font-weight:500}
.ema-reason{display:flex;gap:.4em;align-items:flex-start;font-size:.8125em;color:var(--ema-text-muted)}

.ema-values{display:grid;gap:var(--ema-s1)}
.ema-value-row{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:0 var(--ema-s3);min-width:0}
.ema-value-row dt{flex:1 1 9em;min-width:0;color:var(--ema-text-muted)}
.ema-value-row dd{flex:0 1 auto;margin-left:auto;min-width:0;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;overflow-wrap:anywhere}
.ema-value-row:is([data-status=undefined],[data-status=numerical-limit]) dd{font-weight:500;font-style:italic}
.ema-badge{display:inline-block;margin-left:.45em;padding:0;border:0;font-size:.75em;font-style:normal;font-weight:500;color:var(--ema-text-muted);letter-spacing:.02em}
.ema-value-row dd.ema-value-reason{flex:1 1 100%;margin:0;text-align:left;font-size:.8125em;font-weight:400;font-style:normal;color:var(--ema-text-muted)}
.ema-value-row dd.ema-value-unit{flex:1 1 100%;margin:0;display:flex;justify-content:flex-end}
.ema-select-compact{min-height:1.75rem;font-size:.8125em}

.ema-equations{display:grid;gap:var(--ema-s2)}
.ema-equation{display:grid;gap:2px;min-width:0}
.ema-equation-label{font-size:.8125em;color:var(--ema-text-muted)}
.ema-math{max-width:100%;overflow-x:auto;overflow-y:hidden;padding:var(--ema-s1) 0;scrollbar-width:thin}
.ema-math[data-overflow]{padding:var(--ema-s1);border:1px dashed var(--ema-border-strong);border-radius:calc(var(--ema-radius) - 2px);overflow-x:scroll}
.ema-math-hint{display:flex;gap:.4em;align-items:baseline;font-size:.8125em;color:var(--ema-text-muted)}
.ema-math[tabindex]{background:linear-gradient(to left,var(--ema-surface) 40%,transparent) right center/1.5rem 100% no-repeat local,radial-gradient(farthest-side at 100% 50%,color-mix(in srgb,var(--ema-text) 22%,transparent),transparent) right center/.75rem 100% no-repeat scroll}
.ema-math .katex-display{margin:0;text-align:left}
.ema-math .katex-display>.katex{text-align:left}
.ema-math .katex{font-size:1.12em}
.ema-plain{font-family:var(--ema-font-family);white-space:pre-wrap;overflow-wrap:anywhere}

.ema-scenarios{display:flex;flex-wrap:wrap;gap:var(--ema-s1)}
.ema-comparison{display:grid;gap:var(--ema-s1);padding-top:var(--ema-s1)}
.ema-comparison+.ema-comparison{border-top:1px solid var(--ema-border);padding-top:var(--ema-s2)}
.ema-comparison-runs{font-weight:600;display:flex;flex-wrap:wrap;align-items:center;gap:0 .4em}
.ema-comparison-name{font-weight:500;overflow-wrap:anywhere}
.ema-swatch{flex:none;overflow:visible}
.ema-comparison-boundary{display:flex;gap:.4em;align-items:baseline;font-size:.8125em}
.ema-comparison-boundary .ema-glyph{color:var(--ema-warning)}
.ema-comparison-missing{font-style:italic;color:var(--ema-text-muted)}
.ema-comparison-reason{display:block;max-width:12em;margin:.15em 0 0 auto;text-align:left;font-size:.8125em;font-weight:400;color:var(--ema-text-muted)}
.ema-diff{font-size:.8125em}
.ema-diff-table{border-collapse:collapse;width:100%;font-size:.8125em;font-variant-numeric:tabular-nums}
.ema-diff-table th,.ema-diff-table td{padding:.25em .5em;border-bottom:1px solid var(--ema-border);text-align:right;overflow-wrap:anywhere}
.ema-diff-table :is(th[scope=row],thead th:first-child){text-align:left;font-weight:500}
.ema-diff-table thead th{font-weight:600;color:var(--ema-text-muted)}

.ema-table-region{max-width:100%;max-height:22rem;overflow:auto;border:1px solid var(--ema-border);border-radius:calc(var(--ema-radius) - 2px);background:var(--ema-background)}
.ema-table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:.8125em}
.ema-table caption{text-align:left;font-weight:600;padding:var(--ema-s1) var(--ema-s2)}
.ema-table th,.ema-table td{padding:.35em .7em;border-bottom:1px solid var(--ema-border);text-align:right;white-space:nowrap}
.ema-table th:first-child,.ema-table td:first-child{text-align:left}
.ema-table thead th{position:sticky;top:0;background:var(--ema-surface);font-weight:600;color:var(--ema-text-muted)}
.ema-table td.ema-table-note{white-space:normal;text-align:left;color:var(--ema-text-muted)}
.ema-table td.ema-table-missing{white-space:normal;text-align:left;min-width:9em;color:var(--ema-text-muted);font-style:italic}

.ema-response{display:grid;gap:var(--ema-s2);padding:var(--ema-s3) 0 0;border:0;border-top:1px solid var(--ema-border)}
.ema-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--ema-s2);padding-top:var(--ema-s2);border-top:1px solid var(--ema-border)}
.ema[data-variant=embedded] .ema-footer{padding-top:0;border-top:0}
.ema-footer-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s2)}
.ema-review{flex:1 1 16em;font-size:.75em;color:var(--ema-text-muted)}
.ema-next-status{font-size:.8125em;color:var(--ema-text-muted)}
.ema-pending{display:flex;gap:var(--ema-s2);align-items:flex-start;padding:var(--ema-s1) 0 var(--ema-s1) var(--ema-s2);border:0;border-left:2px dashed var(--ema-border-strong);font-size:.875em}
.ema-alternatives{display:grid;gap:var(--ema-s2)}
.ema-alternatives details>summary{cursor:pointer;font-size:.8125em;color:var(--ema-text-muted);padding:2px 0}
.ema-alternatives dl{display:grid;gap:var(--ema-s1);font-size:.8125em;padding-top:var(--ema-s1)}
.ema-alternatives dt{font-weight:600}
.ema-more{min-width:0;padding-top:var(--ema-s1);border-top:1px solid var(--ema-border)}
.ema-more>summary{display:inline-flex;align-items:center;gap:.5em;min-height:2rem;cursor:pointer;list-style:none;font-size:.875em;color:var(--ema-text-muted);border-radius:3px}
.ema-more>summary::-webkit-details-marker{display:none}
.ema-more>summary::before{content:"";width:.4em;height:.4em;margin-left:.15em;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform var(--ema-motion-duration) ease}
.ema-more[open]>summary::before{transform:rotate(45deg)}
.ema-more>summary:hover{color:var(--ema-text)}
.ema-more-body{display:grid;gap:var(--ema-s3);padding:var(--ema-s1) 0 var(--ema-s2)}
.ema-more-body>.ema-panel{padding-top:var(--ema-s2)}
.ema-spatial{position:relative;min-height:16rem;border-radius:calc(var(--ema-radius) - 2px);overflow:hidden;background:var(--ema-surface)}
.ema-segmented{display:inline-flex;flex-wrap:wrap;gap:var(--ema-s1)}

@container ema-card (max-width:360px){
  .ema-card{padding:var(--ema-s2);gap:var(--ema-s2)}
  .ema[data-variant=embedded] .ema-card{padding:0}
  .ema-figure-head{padding:var(--ema-s1) var(--ema-s2) 0}
  .ema-figure-body{padding:var(--ema-s1) 2px 0}
  .ema-figure-foot{padding:var(--ema-s1) var(--ema-s2) var(--ema-s2)}
  .ema-title{font-size:1.125em}
  .ema-button{padding:0 .6em}
}
@container ema-card (min-width:800px){
  .ema[data-layout=auto] .ema-workspace,.ema[data-layout=expanded] .ema-workspace{grid-template-columns:minmax(0,1fr) minmax(16rem,22rem)}
}
@container ema-card (min-width:600px){
  .ema[data-layout=expanded] .ema-workspace{grid-template-columns:minmax(0,1fr) minmax(15rem,19rem)}
}
.ema .ema-workspace[data-single=true]{grid-template-columns:minmax(0,1fr)}
.ema[data-layout=side] .ema-card{padding:var(--ema-s2);gap:var(--ema-s2)}
.ema[data-layout=side][data-variant=embedded] .ema-card{padding:0}
@media (prefers-reduced-motion:reduce){.ema *,.ema *::before,.ema *::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
@media (forced-colors:active){
  .ema-banner,.ema-clip,.ema-clip-sizer,.ema-panel,.ema-figure,.ema-more,.ema-inline-status,.ema-pending{border-color:CanvasText}
  .ema-button-primary{forced-color-adjust:none;background:ButtonText;color:ButtonFace;border-color:ButtonText}
  .ema :focus-visible{outline-color:Highlight}
  .ema-focus-ring,.ema-plot-focus{stroke:Highlight}
}
`;

const sheets = new WeakMap<Document, CSSStyleSheet>();
const users = new WeakMap<Document | ShadowRoot, { count: number; release: () => void }>();

/**
 * Adopts the component stylesheet into a document or shadow root (reference-counted; call the returned function to
 * release). Without constructable stylesheet support it links the packaged `activity.css` asset when one is known;
 * `false` is returned in `ok` when no styling mechanism is available.
 */
export function adoptActivityStyles(root: Document | ShadowRoot = document, assetBase?: string | URL): { ok: boolean; release: () => void } {
  const doc = 'createElement' in root ? root as Document : (root as ShadowRoot).ownerDocument;
  const existing = users.get(root);
  if (existing) { existing.count++; return { ok: true, release: releaser(root) }; }
  if (supportsConstructableSheets(doc)) {
    let sheet = sheets.get(doc);
    if (!sheet) { sheet = createSheet(doc, ACTIVITY_STYLESHEET); sheets.set(doc, sheet); }
    users.set(root, { count: 1, release: adoptSheet(root, sheet) });
    return { ok: true, release: releaser(root) };
  }
  const href = assetBase !== undefined ? new URL('activity.css', String(assetBase).endsWith('/') ? String(assetBase) : `${String(assetBase)}/`).href : stylesheetAssetUrl()?.href;
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
