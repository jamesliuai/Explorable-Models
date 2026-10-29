/**
 * Component stylesheet for the learner surface (report §10.1, native.md N4). Applied as a constructable stylesheet:
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
  border:1px solid var(--ema-border);border-radius:var(--ema-radius);color-scheme:light;overflow-wrap:break-word}
.ema[data-theme=dark]{color-scheme:dark}
.ema *,.ema *::before,.ema *::after{box-sizing:border-box}
.ema :where(h1,h2,h3,h4,h5,h6,p,ul,ol,dl,dd,figure,fieldset,legend,blockquote){margin:0;padding:0}
.ema :where(ul,ol){list-style:none}
.ema fieldset{border:0;min-width:0}
.ema :where(button,input,select,textarea){font:inherit;color:inherit;letter-spacing:inherit}
.ema :focus{outline:none}
.ema :focus-visible{outline:3px solid var(--ema-focus);outline-offset:2px;border-radius:2px}
.ema svg :focus-visible{outline:none}
.ema-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}

.ema-card{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--ema-s3);padding:var(--ema-s4);min-width:0}
.ema-main,.ema-side,.ema-panel,.ema-nav,.ema-control,.ema-figure,.ema-equations,.ema-equation,.ema-alternatives{grid-template-columns:minmax(0,1fr)}
.ema-header{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:var(--ema-s1) var(--ema-s3);min-width:0}
.ema-heading{display:grid;gap:2px;min-width:0;flex:1 1 16em}
.ema-title{font-size:1.2em;line-height:1.3;font-weight:650;letter-spacing:-.005em;overflow-wrap:anywhere}
.ema-subtitle{color:var(--ema-text-muted);font-size:.875em}
.ema-meta{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s1)}
.ema-chip{display:inline-flex;align-items:center;gap:.4em;min-height:1.75em;padding:0 .65em;border:1px solid var(--ema-border);border-radius:999px;font-size:.8125em;line-height:1.2;color:var(--ema-text-muted);background:var(--ema-surface);white-space:nowrap}
.ema-chip[data-tone]{border-color:var(--ema-tone);color:var(--ema-text)}
.ema-chip .ema-glyph{color:var(--ema-tone,var(--ema-text-muted))}
.ema-chip-labels{display:inline-grid;justify-items:center}
.ema-chip-labels::before{content:"Not saved yet";grid-area:1/1;visibility:hidden}
.ema-chip-label{grid-area:1/1}
.ema-instruction{font-size:1em;line-height:1.55;max-width:70ch;border-radius:4px}
.ema-instruction:focus-visible{outline-offset:4px}
.ema-glyph{display:inline-block;min-width:1em;text-align:center;font-weight:700;line-height:1}

[data-tone=info]{--ema-tone:var(--ema-primary)}
[data-tone=success]{--ema-tone:var(--ema-positive)}
[data-tone=warning]{--ema-tone:var(--ema-warning)}
[data-tone=error]{--ema-tone:var(--ema-error)}
[data-tone=neutral]{--ema-tone:var(--ema-muted)}
.ema-banner{display:flex;flex-wrap:wrap;align-items:flex-start;gap:var(--ema-s1) var(--ema-s2);padding:var(--ema-s2) var(--ema-s3);border:1px solid var(--ema-border);border-left:4px solid var(--ema-tone);border-radius:calc(var(--ema-radius) - 2px);background:var(--ema-surface);background:color-mix(in srgb,var(--ema-tone) 7%,var(--ema-background))}
.ema-banner>.ema-glyph{color:var(--ema-tone);margin-top:.2em}
.ema-banner-body{flex:1 1 14em;min-width:0;display:grid;gap:2px}
.ema-banner-title{font-weight:650}
.ema-banner-actions{display:flex;flex-wrap:wrap;gap:var(--ema-s1)}

.ema-button{display:inline-flex;align-items:center;justify-content:center;gap:.4em;min-height:2.25rem;min-width:2.25rem;padding:0 .8em;border:1px solid var(--ema-border-strong);border-radius:calc(var(--ema-radius) - 2px);background:var(--ema-background);color:var(--ema-text);font-weight:550;line-height:1.2;cursor:pointer;transition:background-color var(--ema-motion-duration) ease;text-align:center}
.ema-button:hover{background:var(--ema-surface-strong)}
.ema-button[aria-pressed=true]{background:var(--ema-surface-strong);border-color:var(--ema-text);box-shadow:inset 0 -3px 0 var(--ema-primary)}
.ema-button[aria-disabled=true],.ema-button:disabled{opacity:.55;cursor:not-allowed}
.ema-button-primary{background:var(--ema-primary);border-color:var(--ema-primary);color:var(--ema-on-primary)}
.ema-button-primary:hover{background:color-mix(in srgb,var(--ema-primary) 88%,var(--ema-text))}
.ema-button-quiet{border-color:transparent;background:transparent;text-decoration:underline;text-underline-offset:.2em;padding:0 .4em}
.ema-button-quiet:hover{background:var(--ema-surface)}
.ema-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s1)}
.ema-play{display:inline-grid;place-items:center;min-width:6.25em}
.ema-play-face{grid-area:1/1;display:inline-flex;align-items:center;justify-content:center;gap:.4em}
.ema-play-spare{visibility:hidden}

.ema-workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--ema-s3);align-items:start;min-width:0}
.ema-main,.ema-side{display:grid;gap:var(--ema-s3);min-width:0;align-content:start}
.ema-panel{display:grid;gap:var(--ema-s2);min-width:0;padding:var(--ema-s3);border:1px solid var(--ema-border);border-radius:calc(var(--ema-radius) - 2px);background:var(--ema-surface)}
.ema-panel-title{font-size:.9375em;font-weight:650;line-height:1.3}
.ema-panel-note{color:var(--ema-text-muted);font-size:.875em}

.ema-figure{display:grid;min-width:0;border:1px solid var(--ema-border);border-radius:calc(var(--ema-radius) - 2px);background:var(--ema-background);overflow:hidden}
.ema-figure[data-tentative=true]{border-style:dashed;border-color:var(--ema-primary)}
.ema-figure-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--ema-s1) var(--ema-s2);padding:var(--ema-s2) var(--ema-s3) 0}
.ema-figure-title{font-size:.9375em;font-weight:650;line-height:1.3;overflow-wrap:anywhere}
.ema-figure-body{position:relative;min-width:0;padding:var(--ema-s1) var(--ema-s2) 0}
.ema-figure-foot{display:grid;gap:var(--ema-s1);padding:var(--ema-s1) var(--ema-s3) var(--ema-s2)}
.ema-plot{display:block;width:100%;height:auto;max-width:100%;touch-action:pan-y;user-select:none;-webkit-user-select:none}
.ema-plot-area{cursor:grab}
.ema-plot-area[data-panning=true]{cursor:grabbing}
.ema-plot-focus{fill:none;stroke:var(--ema-focus);stroke-width:3;visibility:hidden}
.ema-canvas:focus-visible .ema-plot-focus{visibility:visible}
.ema-grid-line{stroke:var(--ema-border);stroke-width:1}
.ema-axis-line{stroke:var(--ema-border-strong);stroke-width:1.25}
.ema-zero-line{stroke:var(--ema-muted);stroke-width:1}
.ema-tick{fill:var(--ema-text-muted);font-size:.75em}
.ema-axis-title{fill:var(--ema-text);font-size:.8125em;font-weight:600}
.ema-legend-text{fill:var(--ema-text);font-size:.8125em}
.ema-label{fill:var(--ema-text);font-size:.8125em;font-weight:600;paint-order:stroke;stroke:var(--ema-background);stroke-width:3px;stroke-linejoin:round}
.ema-leader{stroke:var(--ema-text-muted);stroke-width:1;stroke-dasharray:2 2}
.ema-callout-plate{fill:var(--ema-background);stroke:var(--ema-text);stroke-width:1}
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
.ema-focus-ring{fill:none;stroke:var(--ema-focus);stroke-width:2.5;visibility:hidden}
.ema-handle:focus-visible .ema-focus-ring,.ema-handle[aria-selected=true] .ema-focus-ring{visibility:visible}
.ema-hit{fill:transparent;stroke:none}
.ema-marks,.ema-labels,.ema-axes{pointer-events:none}
.ema-clip,.ema-clip-sizer{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s1) var(--ema-s2);padding:var(--ema-s1) var(--ema-s2);border:1px dashed var(--ema-warning);border-radius:calc(var(--ema-radius) - 2px);background:var(--ema-surface);background:color-mix(in srgb,var(--ema-warning) 6%,var(--ema-background));font-size:.875em}
.ema-clip .ema-glyph,.ema-clip-sizer .ema-glyph{color:var(--ema-warning)}
.ema-clip-text{flex:1 1 12em;min-width:0}
.ema-clip-slot{display:grid;align-items:start}
.ema-clip-slot>*{grid-area:1/1;min-width:0}
.ema-clip-sizer{visibility:hidden}
.ema-clip-sizer [data-ema-sizer-text]::before{content:attr(data-ema-sizer-text)}
.ema-clip-none{display:flex;align-items:center;gap:var(--ema-s1);padding:var(--ema-s1) var(--ema-s2);border:1px solid transparent;font-size:.875em;color:var(--ema-text-muted)}
.ema-clip-none .ema-glyph{color:var(--ema-muted)}
.ema-notes{display:grid;gap:2px;font-size:.875em;color:var(--ema-text-muted)}
.ema-notes li::before{content:"•";color:var(--ema-muted);margin-right:.45em}
.ema-description{font-size:.9375em;max-width:70ch}

.ema-nav{display:grid;gap:var(--ema-s2)}
.ema-nav-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s1) var(--ema-s2)}
.ema-position{font-weight:650;font-variant-numeric:tabular-nums;min-width:7.5em}
.ema-terminal{font-size:.875em;color:var(--ema-text-muted)}

.ema-control{display:grid;gap:var(--ema-s1);min-width:0}
.ema-control+.ema-control{padding-top:var(--ema-s2);border-top:1px solid var(--ema-border)}
.ema-control-section{display:grid;gap:var(--ema-s2);min-width:0}
.ema-control-section+.ema-control-section,.ema-control+.ema-control-section,.ema-control-section+.ema-control{padding-top:var(--ema-s2);border-top:1px solid var(--ema-border-strong)}
.ema-section-title{font-size:.9375em;font-weight:650;line-height:1.3}
.ema-inline-status{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px var(--ema-s2);padding:var(--ema-s1) var(--ema-s2);border:1px dashed var(--ema-tone,var(--ema-border-strong));border-radius:calc(var(--ema-radius) - 3px);font-size:.875em}
.ema-inline-status>.ema-glyph{color:var(--ema-tone)}
.ema-inline-text{flex:1 1 12em;min-width:0}
.ema-inline-actions{display:inline-flex;flex-wrap:wrap;gap:var(--ema-s1)}
.ema-inline-actions .ema-button{min-height:2rem}
.ema-control-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px var(--ema-s2)}
.ema-control-label{font-weight:600}
.ema-control-value{font-variant-numeric:tabular-nums;color:var(--ema-text)}
.ema-control-value[data-tentative=true]{font-style:italic}
.ema-control-hint{font-size:.8125em;color:var(--ema-text-muted)}
.ema-reset{display:grid;gap:var(--ema-s1);justify-items:start;min-width:0;padding-top:var(--ema-s2);border-top:1px solid var(--ema-border-strong)}
.ema-slider{width:100%;min-width:0;margin:0;height:2rem;accent-color:var(--ema-primary);touch-action:pan-y;cursor:pointer;background:transparent}
.ema-slider[aria-disabled=true]{cursor:not-allowed;opacity:.55}
.ema-exact{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s1)}
.ema-input{min-width:0;width:6em;flex:1 1 6em;max-width:12em;min-height:2.25rem;padding:0 .6em;border:1px solid var(--ema-border-strong);border-radius:calc(var(--ema-radius) - 3px);background:var(--ema-background);font-variant-numeric:tabular-nums}
.ema-input[aria-invalid=true]{border-color:var(--ema-error);box-shadow:inset 0 0 0 1px var(--ema-error)}
.ema-input[readonly]{background:var(--ema-surface);color:var(--ema-text-muted)}
.ema-select{min-height:2.25rem;min-width:0;max-width:100%;padding:0 .5em;border:1px solid var(--ema-border-strong);border-radius:calc(var(--ema-radius) - 3px);background:var(--ema-background)}
.ema-unit{color:var(--ema-text-muted)}
.ema-error{display:flex;gap:.4em;align-items:flex-start;color:var(--ema-error);font-size:.875em;font-weight:550}
.ema-reason{display:flex;gap:.4em;align-items:flex-start;font-size:.8125em;color:var(--ema-text-muted)}

.ema-values{display:grid;gap:var(--ema-s1)}
.ema-value-row{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:0 var(--ema-s3);min-width:0}
.ema-value-row dt{flex:1 1 9em;min-width:0;color:var(--ema-text-muted)}
.ema-value-row dd{flex:0 1 auto;margin-left:auto;min-width:0;text-align:right;font-variant-numeric:tabular-nums;font-weight:550;overflow-wrap:anywhere}
.ema-value-row:is([data-status=undefined],[data-status=numerical-limit]) dd{font-weight:500;font-style:italic}
.ema-badge{display:inline-block;margin-left:.4em;padding:0 .4em;border:1px solid var(--ema-border-strong);border-radius:4px;font-size:.75em;font-style:normal;font-weight:600;color:var(--ema-text-muted);vertical-align:.1em}
.ema-value-row dd.ema-value-reason{flex:1 1 100%;margin:0;text-align:left;font-size:.8125em;font-weight:400;font-style:normal;color:var(--ema-text-muted)}
.ema-value-row dd.ema-value-unit{flex:1 1 100%;margin:0;display:flex;justify-content:flex-end}
.ema-select-compact{min-height:2rem;font-size:.875em}

.ema-equations{display:grid;gap:var(--ema-s2)}
.ema-equation{display:grid;gap:2px;min-width:0}
.ema-equation-label{font-size:.8125em;color:var(--ema-text-muted)}
.ema-math{max-width:100%;overflow-x:auto;overflow-y:hidden;padding:var(--ema-s1) 0;scrollbar-width:thin}
.ema-math[data-overflow]{padding:var(--ema-s1);border:1px dashed var(--ema-border-strong);border-radius:calc(var(--ema-radius) - 3px);overflow-x:scroll}
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
.ema-comparison-name{font-weight:550;overflow-wrap:anywhere}
.ema-swatch{flex:none;overflow:visible}
.ema-comparison-boundary{display:flex;gap:.4em;align-items:baseline;font-size:.875em}
.ema-comparison-boundary .ema-glyph{color:var(--ema-warning)}
.ema-comparison-missing{font-style:italic;color:var(--ema-text-muted)}
.ema-comparison-reason{display:block;max-width:12em;margin:.15em 0 0 auto;text-align:left;font-size:.8125em;font-weight:400;color:var(--ema-text-muted)}
.ema-diff{font-size:.875em}
.ema-diff-table{border-collapse:collapse;width:100%;font-size:.875em;font-variant-numeric:tabular-nums}
.ema-diff-table th,.ema-diff-table td{padding:.25em .5em;border-bottom:1px solid var(--ema-border);text-align:right;overflow-wrap:anywhere}
.ema-diff-table :is(th[scope=row],thead th:first-child){text-align:left;font-weight:550}
.ema-diff-table thead th{font-weight:650;color:var(--ema-text-muted)}

.ema-table-region{max-width:100%;max-height:22rem;overflow:auto;border:1px solid var(--ema-border);border-radius:calc(var(--ema-radius) - 3px);background:var(--ema-background)}
.ema-table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:.875em}
.ema-table caption{text-align:left;font-weight:650;padding:var(--ema-s1) var(--ema-s2)}
.ema-table th,.ema-table td{padding:.35em .7em;border-bottom:1px solid var(--ema-border);text-align:right;white-space:nowrap}
.ema-table th:first-child,.ema-table td:first-child{text-align:left}
.ema-table thead th{position:sticky;top:0;background:var(--ema-surface-strong);font-weight:650}
.ema-table td.ema-table-note{white-space:normal;text-align:left;color:var(--ema-text-muted)}
.ema-table td.ema-table-missing{white-space:normal;text-align:left;min-width:9em;color:var(--ema-text-muted);font-style:italic}

.ema-response{display:grid;gap:var(--ema-s2);padding:var(--ema-s3);border:1px solid var(--ema-border);border-radius:calc(var(--ema-radius) - 2px)}
.ema-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--ema-s2);padding-top:var(--ema-s2);border-top:1px solid var(--ema-border)}
.ema-footer-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s2)}
.ema-review{flex:1 1 16em;font-size:.8125em;color:var(--ema-text-muted)}
.ema-next-status{font-size:.875em;color:var(--ema-text-muted)}
.ema-pending{display:flex;gap:var(--ema-s2);align-items:flex-start;padding:var(--ema-s2) var(--ema-s3);border:1px dashed var(--ema-border-strong);border-radius:calc(var(--ema-radius) - 2px);font-size:.9375em}
.ema-alternatives{display:grid;gap:var(--ema-s2)}
.ema-alternatives details>summary{cursor:pointer;font-size:.875em;color:var(--ema-text-muted);padding:2px 0}
.ema-alternatives dl{display:grid;gap:var(--ema-s1);font-size:.875em;padding-top:var(--ema-s1)}
.ema-alternatives dt{font-weight:600}
.ema-spatial{position:relative;min-height:16rem;border-radius:calc(var(--ema-radius) - 3px);overflow:hidden;background:var(--ema-surface)}
.ema-segmented{display:inline-flex;flex-wrap:wrap;gap:var(--ema-s1)}

@container ema-card (max-width:360px){
  .ema-card{padding:var(--ema-s2);gap:var(--ema-s2)}
  .ema-panel{padding:var(--ema-s2)}
  .ema-figure-head{padding:var(--ema-s1) var(--ema-s2) 0}
  .ema-figure-body{padding:var(--ema-s1) 2px 0}
  .ema-figure-foot{padding:var(--ema-s1) var(--ema-s2) var(--ema-s2)}
  .ema-title{font-size:1.1em}
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
.ema[data-layout=side] .ema-panel{padding:var(--ema-s2)}
@media (prefers-reduced-motion:reduce){.ema *,.ema *::before,.ema *::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
@media (forced-colors:active){
  .ema-banner,.ema-clip,.ema-clip-sizer,.ema-chip,.ema-panel,.ema-figure{border-color:CanvasText}
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
