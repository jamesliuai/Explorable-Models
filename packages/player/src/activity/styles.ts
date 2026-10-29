/**
 * Component stylesheet for the learner surface (report §10.1, native.md N4). Applied as a constructable stylesheet:
 * `mountStudyActivity` adopts it into its shadow root; React hosts use `adoptActivityStyles(document)` (the component
 * also adopts it into whatever root it renders in). Every selector is scoped under `.eka`, so it is safe in a document.
 * Layout responds to the card's own width through container queries, not the viewport:
 * narrow side panel (≤ 360px), inline conversation card (≈ 390–640px) and expanded workspace (≥ 800px, controls beside
 * the scene). Colours come only from `--eka-*` tokens; motion tokens collapse under reduced motion.
 */
import { adoptSheet, createSheet, supportsConstructableSheets } from './assets.js';
import { stylesheetAssetUrl } from './asset-urls.js';

export const ACTIVITY_STYLESHEET = String.raw`
:host{display:block;min-width:0}
.eka{--eka-s1:calc(var(--eka-space) * .5);--eka-s2:var(--eka-space);--eka-s3:calc(var(--eka-space) * 1.5);--eka-s4:calc(var(--eka-space) * 2);--eka-s5:calc(var(--eka-space) * 3);
  container:eka-card/inline-size;display:block;box-sizing:border-box;min-width:0;max-width:100%;color:var(--eka-text);background:var(--eka-background);
  font-family:var(--eka-font-family);font-size:var(--eka-font-size);line-height:1.5;font-variant-numeric:tabular-nums;text-size-adjust:100%;-webkit-text-size-adjust:100%;
  border:1px solid var(--eka-border);border-radius:var(--eka-radius);color-scheme:light;overflow-wrap:break-word}
.eka[data-theme=dark]{color-scheme:dark}
.eka *,.eka *::before,.eka *::after{box-sizing:border-box}
.eka :where(h1,h2,h3,h4,h5,h6,p,ul,ol,dl,dd,figure,fieldset,legend,blockquote){margin:0;padding:0}
.eka :where(ul,ol){list-style:none}
.eka fieldset{border:0;min-width:0}
.eka :where(button,input,select,textarea){font:inherit;color:inherit;letter-spacing:inherit}
.eka :focus{outline:none}
.eka :focus-visible{outline:3px solid var(--eka-focus);outline-offset:2px;border-radius:2px}
.eka svg :focus-visible{outline:none}
.eka-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}

.eka-card{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--eka-s3);padding:var(--eka-s4);min-width:0}
.eka-main,.eka-side,.eka-panel,.eka-nav,.eka-control,.eka-figure,.eka-equations,.eka-equation,.eka-alternatives{grid-template-columns:minmax(0,1fr)}
.eka-header{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:var(--eka-s1) var(--eka-s3);min-width:0}
.eka-heading{display:grid;gap:2px;min-width:0;flex:1 1 16em}
.eka-title{font-size:1.2em;line-height:1.3;font-weight:650;letter-spacing:-.005em;overflow-wrap:anywhere}
.eka-subtitle{color:var(--eka-text-muted);font-size:.875em}
.eka-meta{display:flex;flex-wrap:wrap;align-items:center;gap:var(--eka-s1)}
.eka-chip{display:inline-flex;align-items:center;gap:.4em;min-height:1.75em;padding:0 .65em;border:1px solid var(--eka-border);border-radius:999px;font-size:.8125em;line-height:1.2;color:var(--eka-text-muted);background:var(--eka-surface);white-space:nowrap}
.eka-chip[data-tone]{border-color:var(--eka-tone);color:var(--eka-text)}
.eka-chip .eka-glyph{color:var(--eka-tone,var(--eka-text-muted))}
.eka-chip-labels{display:inline-grid;justify-items:center}
.eka-chip-labels::before{content:"Not saved yet";grid-area:1/1;visibility:hidden}
.eka-chip-label{grid-area:1/1}
.eka-instruction{font-size:1em;line-height:1.55;max-width:70ch;border-radius:4px}
.eka-instruction:focus-visible{outline-offset:4px}
.eka-glyph{display:inline-block;min-width:1em;text-align:center;font-weight:700;line-height:1}

[data-tone=info]{--eka-tone:var(--eka-primary)}
[data-tone=success]{--eka-tone:var(--eka-positive)}
[data-tone=warning]{--eka-tone:var(--eka-warning)}
[data-tone=error]{--eka-tone:var(--eka-error)}
[data-tone=neutral]{--eka-tone:var(--eka-muted)}
.eka-banner{display:flex;flex-wrap:wrap;align-items:flex-start;gap:var(--eka-s1) var(--eka-s2);padding:var(--eka-s2) var(--eka-s3);border:1px solid var(--eka-border);border-left:4px solid var(--eka-tone);border-radius:calc(var(--eka-radius) - 2px);background:var(--eka-surface);background:color-mix(in srgb,var(--eka-tone) 7%,var(--eka-background))}
.eka-banner>.eka-glyph{color:var(--eka-tone);margin-top:.2em}
.eka-banner-body{flex:1 1 14em;min-width:0;display:grid;gap:2px}
.eka-banner-title{font-weight:650}
.eka-banner-actions{display:flex;flex-wrap:wrap;gap:var(--eka-s1)}

.eka-button{display:inline-flex;align-items:center;justify-content:center;gap:.4em;min-height:2.25rem;min-width:2.25rem;padding:0 .8em;border:1px solid var(--eka-border-strong);border-radius:calc(var(--eka-radius) - 2px);background:var(--eka-background);color:var(--eka-text);font-weight:550;line-height:1.2;cursor:pointer;transition:background-color var(--eka-motion-duration) ease;text-align:center}
.eka-button:hover{background:var(--eka-surface-strong)}
.eka-button[aria-pressed=true]{background:var(--eka-surface-strong);border-color:var(--eka-text);box-shadow:inset 0 -3px 0 var(--eka-primary)}
.eka-button[aria-disabled=true],.eka-button:disabled{opacity:.55;cursor:not-allowed}
.eka-button-primary{background:var(--eka-primary);border-color:var(--eka-primary);color:var(--eka-on-primary)}
.eka-button-primary:hover{background:color-mix(in srgb,var(--eka-primary) 88%,var(--eka-text))}
.eka-button-quiet{border-color:transparent;background:transparent;text-decoration:underline;text-underline-offset:.2em;padding:0 .4em}
.eka-button-quiet:hover{background:var(--eka-surface)}
.eka-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--eka-s1)}
.eka-play{display:inline-grid;place-items:center;min-width:6.25em}
.eka-play-face{grid-area:1/1;display:inline-flex;align-items:center;justify-content:center;gap:.4em}
.eka-play-spare{visibility:hidden}

.eka-workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--eka-s3);align-items:start;min-width:0}
.eka-main,.eka-side{display:grid;gap:var(--eka-s3);min-width:0;align-content:start}
.eka-panel{display:grid;gap:var(--eka-s2);min-width:0;padding:var(--eka-s3);border:1px solid var(--eka-border);border-radius:calc(var(--eka-radius) - 2px);background:var(--eka-surface)}
.eka-panel-title{font-size:.9375em;font-weight:650;line-height:1.3}
.eka-panel-note{color:var(--eka-text-muted);font-size:.875em}

.eka-figure{display:grid;min-width:0;border:1px solid var(--eka-border);border-radius:calc(var(--eka-radius) - 2px);background:var(--eka-background);overflow:hidden}
.eka-figure[data-tentative=true]{border-style:dashed;border-color:var(--eka-primary)}
.eka-figure-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--eka-s1) var(--eka-s2);padding:var(--eka-s2) var(--eka-s3) 0}
.eka-figure-title{font-size:.9375em;font-weight:650;line-height:1.3;overflow-wrap:anywhere}
.eka-figure-body{position:relative;min-width:0;padding:var(--eka-s1) var(--eka-s2) 0}
.eka-figure-foot{display:grid;gap:var(--eka-s1);padding:var(--eka-s1) var(--eka-s3) var(--eka-s2)}
.eka-plot{display:block;width:100%;height:auto;max-width:100%;touch-action:pan-y;user-select:none;-webkit-user-select:none}
.eka-plot-area{cursor:grab}
.eka-plot-area[data-panning=true]{cursor:grabbing}
.eka-plot-focus{fill:none;stroke:var(--eka-focus);stroke-width:3;visibility:hidden}
.eka-canvas:focus-visible .eka-plot-focus{visibility:visible}
.eka-grid-line{stroke:var(--eka-border);stroke-width:1}
.eka-axis-line{stroke:var(--eka-border-strong);stroke-width:1.25}
.eka-zero-line{stroke:var(--eka-muted);stroke-width:1}
.eka-tick{fill:var(--eka-text-muted);font-size:.75em}
.eka-axis-title{fill:var(--eka-text);font-size:.8125em;font-weight:600}
.eka-legend-text{fill:var(--eka-text);font-size:.8125em}
.eka-label{fill:var(--eka-text);font-size:.8125em;font-weight:600;paint-order:stroke;stroke:var(--eka-background);stroke-width:3px;stroke-linejoin:round}
.eka-leader{stroke:var(--eka-text-muted);stroke-width:1;stroke-dasharray:2 2}
.eka-callout-plate{fill:var(--eka-background);stroke:var(--eka-text);stroke-width:1}
.eka-callout{stroke:none}
.eka-role-primary{--eka-mark:var(--eka-primary)}
.eka-role-secondary{--eka-mark:var(--eka-secondary)}
.eka-role-accent{--eka-mark:var(--eka-accent)}
.eka-role-muted{--eka-mark:var(--eka-muted)}
.eka-role-positive{--eka-mark:var(--eka-positive)}
.eka-role-negative{--eka-mark:var(--eka-negative)}
.eka-role-warning{--eka-mark:var(--eka-warning)}
.eka-role-reference{--eka-mark:var(--eka-reference)}
.eka-stroke{stroke:var(--eka-mark);fill:none;stroke-linecap:round;stroke-linejoin:round}
.eka-fill{fill:var(--eka-mark);stroke:var(--eka-mark)}
.eka-region{fill:var(--eka-mark);fill-opacity:.14;stroke:var(--eka-mark)}
.eka-hollow{fill:var(--eka-background);stroke:var(--eka-mark)}
.eka-handle{cursor:pointer}
.eka-handle[data-draggable=true]{cursor:grab;touch-action:none}
.eka-focus-ring{fill:none;stroke:var(--eka-focus);stroke-width:2.5;visibility:hidden}
.eka-handle:focus-visible .eka-focus-ring,.eka-handle[aria-selected=true] .eka-focus-ring{visibility:visible}
.eka-hit{fill:transparent;stroke:none}
.eka-marks,.eka-labels,.eka-axes{pointer-events:none}
.eka-clip,.eka-clip-sizer{display:flex;flex-wrap:wrap;align-items:center;gap:var(--eka-s1) var(--eka-s2);padding:var(--eka-s1) var(--eka-s2);border:1px dashed var(--eka-warning);border-radius:calc(var(--eka-radius) - 2px);background:var(--eka-surface);background:color-mix(in srgb,var(--eka-warning) 6%,var(--eka-background));font-size:.875em}
.eka-clip .eka-glyph,.eka-clip-sizer .eka-glyph{color:var(--eka-warning)}
.eka-clip-text{flex:1 1 12em;min-width:0}
.eka-clip-slot{display:grid;align-items:start}
.eka-clip-slot>*{grid-area:1/1;min-width:0}
.eka-clip-sizer{visibility:hidden}
.eka-clip-sizer [data-eka-sizer-text]::before{content:attr(data-eka-sizer-text)}
.eka-clip-none{display:flex;align-items:center;gap:var(--eka-s1);padding:var(--eka-s1) var(--eka-s2);border:1px solid transparent;font-size:.875em;color:var(--eka-text-muted)}
.eka-clip-none .eka-glyph{color:var(--eka-muted)}
.eka-notes{display:grid;gap:2px;font-size:.875em;color:var(--eka-text-muted)}
.eka-notes li::before{content:"•";color:var(--eka-muted);margin-right:.45em}
.eka-description{font-size:.9375em;max-width:70ch}

.eka-nav{display:grid;gap:var(--eka-s2)}
.eka-nav-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--eka-s1) var(--eka-s2)}
.eka-position{font-weight:650;font-variant-numeric:tabular-nums;min-width:7.5em}
.eka-terminal{font-size:.875em;color:var(--eka-text-muted)}

.eka-control{display:grid;gap:var(--eka-s1);min-width:0}
.eka-control+.eka-control{padding-top:var(--eka-s2);border-top:1px solid var(--eka-border)}
.eka-control-section{display:grid;gap:var(--eka-s2);min-width:0}
.eka-control-section+.eka-control-section,.eka-control+.eka-control-section,.eka-control-section+.eka-control{padding-top:var(--eka-s2);border-top:1px solid var(--eka-border-strong)}
.eka-section-title{font-size:.9375em;font-weight:650;line-height:1.3}
.eka-inline-status{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px var(--eka-s2);padding:var(--eka-s1) var(--eka-s2);border:1px dashed var(--eka-tone,var(--eka-border-strong));border-radius:calc(var(--eka-radius) - 3px);font-size:.875em}
.eka-inline-status>.eka-glyph{color:var(--eka-tone)}
.eka-inline-text{flex:1 1 12em;min-width:0}
.eka-inline-actions{display:inline-flex;flex-wrap:wrap;gap:var(--eka-s1)}
.eka-inline-actions .eka-button{min-height:2rem}
.eka-control-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px var(--eka-s2)}
.eka-control-label{font-weight:600}
.eka-control-value{font-variant-numeric:tabular-nums;color:var(--eka-text)}
.eka-control-value[data-tentative=true]{font-style:italic}
.eka-control-hint{font-size:.8125em;color:var(--eka-text-muted)}
.eka-reset{display:grid;gap:var(--eka-s1);justify-items:start;min-width:0;padding-top:var(--eka-s2);border-top:1px solid var(--eka-border-strong)}
.eka-slider{width:100%;min-width:0;margin:0;height:2rem;accent-color:var(--eka-primary);touch-action:pan-y;cursor:pointer;background:transparent}
.eka-slider[aria-disabled=true]{cursor:not-allowed;opacity:.55}
.eka-exact{display:flex;flex-wrap:wrap;align-items:center;gap:var(--eka-s1)}
.eka-input{min-width:0;width:6em;flex:1 1 6em;max-width:12em;min-height:2.25rem;padding:0 .6em;border:1px solid var(--eka-border-strong);border-radius:calc(var(--eka-radius) - 3px);background:var(--eka-background);font-variant-numeric:tabular-nums}
.eka-input[aria-invalid=true]{border-color:var(--eka-error);box-shadow:inset 0 0 0 1px var(--eka-error)}
.eka-input[readonly]{background:var(--eka-surface);color:var(--eka-text-muted)}
.eka-select{min-height:2.25rem;min-width:0;max-width:100%;padding:0 .5em;border:1px solid var(--eka-border-strong);border-radius:calc(var(--eka-radius) - 3px);background:var(--eka-background)}
.eka-unit{color:var(--eka-text-muted)}
.eka-error{display:flex;gap:.4em;align-items:flex-start;color:var(--eka-error);font-size:.875em;font-weight:550}
.eka-reason{display:flex;gap:.4em;align-items:flex-start;font-size:.8125em;color:var(--eka-text-muted)}

.eka-values{display:grid;gap:var(--eka-s1)}
.eka-value-row{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:0 var(--eka-s3);min-width:0}
.eka-value-row dt{flex:1 1 9em;min-width:0;color:var(--eka-text-muted)}
.eka-value-row dd{flex:0 1 auto;margin-left:auto;min-width:0;text-align:right;font-variant-numeric:tabular-nums;font-weight:550;overflow-wrap:anywhere}
.eka-value-row:is([data-status=undefined],[data-status=numerical-limit]) dd{font-weight:500;font-style:italic}
.eka-badge{display:inline-block;margin-left:.4em;padding:0 .4em;border:1px solid var(--eka-border-strong);border-radius:4px;font-size:.75em;font-style:normal;font-weight:600;color:var(--eka-text-muted);vertical-align:.1em}
.eka-value-row dd.eka-value-reason{flex:1 1 100%;margin:0;text-align:left;font-size:.8125em;font-weight:400;font-style:normal;color:var(--eka-text-muted)}
.eka-value-row dd.eka-value-unit{flex:1 1 100%;margin:0;display:flex;justify-content:flex-end}
.eka-select-compact{min-height:2rem;font-size:.875em}

.eka-equations{display:grid;gap:var(--eka-s2)}
.eka-equation{display:grid;gap:2px;min-width:0}
.eka-equation-label{font-size:.8125em;color:var(--eka-text-muted)}
.eka-math{max-width:100%;overflow-x:auto;overflow-y:hidden;padding:var(--eka-s1) 0;scrollbar-width:thin}
.eka-math[data-overflow]{padding:var(--eka-s1);border:1px dashed var(--eka-border-strong);border-radius:calc(var(--eka-radius) - 3px);overflow-x:scroll}
.eka-math-hint{display:flex;gap:.4em;align-items:baseline;font-size:.8125em;color:var(--eka-text-muted)}
.eka-math[tabindex]{background:linear-gradient(to left,var(--eka-surface) 40%,transparent) right center/1.5rem 100% no-repeat local,radial-gradient(farthest-side at 100% 50%,color-mix(in srgb,var(--eka-text) 22%,transparent),transparent) right center/.75rem 100% no-repeat scroll}
.eka-math .katex-display{margin:0;text-align:left}
.eka-math .katex-display>.katex{text-align:left}
.eka-math .katex{font-size:1.12em}
.eka-plain{font-family:var(--eka-font-family);white-space:pre-wrap;overflow-wrap:anywhere}

.eka-scenarios{display:flex;flex-wrap:wrap;gap:var(--eka-s1)}
.eka-comparison{display:grid;gap:var(--eka-s1);padding-top:var(--eka-s1)}
.eka-comparison+.eka-comparison{border-top:1px solid var(--eka-border);padding-top:var(--eka-s2)}
.eka-comparison-runs{font-weight:600;display:flex;flex-wrap:wrap;align-items:center;gap:0 .4em}
.eka-comparison-name{font-weight:550;overflow-wrap:anywhere}
.eka-swatch{flex:none;overflow:visible}
.eka-comparison-boundary{display:flex;gap:.4em;align-items:baseline;font-size:.875em}
.eka-comparison-boundary .eka-glyph{color:var(--eka-warning)}
.eka-comparison-missing{font-style:italic;color:var(--eka-text-muted)}
.eka-comparison-reason{display:block;max-width:12em;margin:.15em 0 0 auto;text-align:left;font-size:.8125em;font-weight:400;color:var(--eka-text-muted)}
.eka-diff{font-size:.875em}
.eka-diff-table{border-collapse:collapse;width:100%;font-size:.875em;font-variant-numeric:tabular-nums}
.eka-diff-table th,.eka-diff-table td{padding:.25em .5em;border-bottom:1px solid var(--eka-border);text-align:right;overflow-wrap:anywhere}
.eka-diff-table :is(th[scope=row],thead th:first-child){text-align:left;font-weight:550}
.eka-diff-table thead th{font-weight:650;color:var(--eka-text-muted)}

.eka-table-region{max-width:100%;max-height:22rem;overflow:auto;border:1px solid var(--eka-border);border-radius:calc(var(--eka-radius) - 3px);background:var(--eka-background)}
.eka-table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:.875em}
.eka-table caption{text-align:left;font-weight:650;padding:var(--eka-s1) var(--eka-s2)}
.eka-table th,.eka-table td{padding:.35em .7em;border-bottom:1px solid var(--eka-border);text-align:right;white-space:nowrap}
.eka-table th:first-child,.eka-table td:first-child{text-align:left}
.eka-table thead th{position:sticky;top:0;background:var(--eka-surface-strong);font-weight:650}
.eka-table td.eka-table-note{white-space:normal;text-align:left;color:var(--eka-text-muted)}
.eka-table td.eka-table-missing{white-space:normal;text-align:left;min-width:9em;color:var(--eka-text-muted);font-style:italic}

.eka-response{display:grid;gap:var(--eka-s2);padding:var(--eka-s3);border:1px solid var(--eka-border);border-radius:calc(var(--eka-radius) - 2px)}
.eka-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--eka-s2);padding-top:var(--eka-s2);border-top:1px solid var(--eka-border)}
.eka-footer-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--eka-s2)}
.eka-review{flex:1 1 16em;font-size:.8125em;color:var(--eka-text-muted)}
.eka-next-status{font-size:.875em;color:var(--eka-text-muted)}
.eka-pending{display:flex;gap:var(--eka-s2);align-items:flex-start;padding:var(--eka-s2) var(--eka-s3);border:1px dashed var(--eka-border-strong);border-radius:calc(var(--eka-radius) - 2px);font-size:.9375em}
.eka-alternatives{display:grid;gap:var(--eka-s2)}
.eka-alternatives details>summary{cursor:pointer;font-size:.875em;color:var(--eka-text-muted);padding:2px 0}
.eka-alternatives dl{display:grid;gap:var(--eka-s1);font-size:.875em;padding-top:var(--eka-s1)}
.eka-alternatives dt{font-weight:600}
.eka-spatial{position:relative;min-height:16rem;border-radius:calc(var(--eka-radius) - 3px);overflow:hidden;background:var(--eka-surface)}
.eka-segmented{display:inline-flex;flex-wrap:wrap;gap:var(--eka-s1)}

@container eka-card (max-width:360px){
  .eka-card{padding:var(--eka-s2);gap:var(--eka-s2)}
  .eka-panel{padding:var(--eka-s2)}
  .eka-figure-head{padding:var(--eka-s1) var(--eka-s2) 0}
  .eka-figure-body{padding:var(--eka-s1) 2px 0}
  .eka-figure-foot{padding:var(--eka-s1) var(--eka-s2) var(--eka-s2)}
  .eka-title{font-size:1.1em}
  .eka-button{padding:0 .6em}
}
@container eka-card (min-width:800px){
  .eka[data-layout=auto] .eka-workspace,.eka[data-layout=expanded] .eka-workspace{grid-template-columns:minmax(0,1fr) minmax(16rem,22rem)}
}
@container eka-card (min-width:600px){
  .eka[data-layout=expanded] .eka-workspace{grid-template-columns:minmax(0,1fr) minmax(15rem,19rem)}
}
.eka .eka-workspace[data-single=true]{grid-template-columns:minmax(0,1fr)}
.eka[data-layout=side] .eka-card{padding:var(--eka-s2);gap:var(--eka-s2)}
.eka[data-layout=side] .eka-panel{padding:var(--eka-s2)}
@media (prefers-reduced-motion:reduce){.eka *,.eka *::before,.eka *::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
@media (forced-colors:active){
  .eka-banner,.eka-clip,.eka-clip-sizer,.eka-chip,.eka-panel,.eka-figure{border-color:CanvasText}
  .eka :focus-visible{outline-color:Highlight}
  .eka-focus-ring,.eka-plot-focus{stroke:Highlight}
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
