/**
 * Component stylesheet for the learner surface (report §10.1, native.md N4). 0.3 presentation: warm-neutral surfaces,
 * hairline separators instead of nested boxes, small radii, no pills, a neutral primary action, the prose serif for the
 * title and stage instruction and the interface font elsewhere; colour stays on data marks and meaningful states, and
 * every state keeps a non-colour cue (glyph, dash, rule or label). Applied as a constructable stylesheet:
 * `mountStudyActivity` adopts it into its shadow root; React hosts use `adoptActivityStyles(document)` (the component
 * also adopts it into whatever root it renders in). Every selector is scoped under `.ema`, so it is safe in a document.
 * Layout responds to the card's own width through container queries, not the viewport:
 * narrow side panel (≤ 360px), inline conversation card (≈ 390–640px) and expanded workspace (≥ 800px, controls beside
 * the scene). An embedded card keeps one column at every width: the drawing, then its parameters. Colours come only from `--ema-*` tokens; motion tokens collapse under reduced motion.
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

.ema-button{display:inline-flex;align-items:center;justify-content:center;gap:.4em;min-height:2rem;min-width:2rem;padding:0 .85em;border:1px solid var(--ema-border);border-radius:999px;background:var(--ema-surface);color:var(--ema-text);font-size:.8125em;font-weight:550;line-height:1.2;cursor:pointer;transition:background-color var(--ema-motion-duration) ease,border-color var(--ema-motion-duration) ease,box-shadow var(--ema-motion-duration) ease,transform var(--ema-motion-duration) ease;text-align:center}
.ema-button:hover{background:var(--ema-surface-strong);border-color:var(--ema-border-strong)}
.ema-button:active{transform:translateY(.5px)}
.ema-button[aria-pressed=true]{background:color-mix(in srgb,var(--ema-action) 16%,var(--ema-surface));border-color:color-mix(in srgb,var(--ema-action) 55%,transparent);color:var(--ema-text);box-shadow:none}
.ema-button[aria-disabled=true],.ema-button:disabled{opacity:.5;cursor:not-allowed}
.ema-button-primary{background:var(--ema-action);border-color:var(--ema-action);color:var(--ema-on-action);font-weight:650;box-shadow:0 6px 20px -8px color-mix(in srgb,var(--ema-action) 70%,transparent)}
.ema-button-primary:hover{background:var(--ema-action);border-color:var(--ema-action);box-shadow:inset 0 0 0 99em color-mix(in srgb,var(--ema-on-action) 10%,transparent),0 8px 26px -8px color-mix(in srgb,var(--ema-action) 80%,transparent)}
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
.ema-panel-title{font-size:.6875em;font-weight:650;line-height:1.3;letter-spacing:.08em;text-transform:uppercase;color:var(--ema-text-muted)}
.ema-panel-note{color:var(--ema-text-muted);font-size:.8125em}

.ema-figure{display:grid;min-width:0;border:1px solid var(--ema-border);border-radius:calc(var(--ema-radius) + 4px);background:var(--ema-background);overflow:hidden;box-shadow:0 1px 2px color-mix(in srgb,var(--ema-text) 6%,transparent)}
.ema-figure[data-tentative=true]{border-style:dashed;border-color:var(--ema-border-strong)}
.ema-figure-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--ema-s1) var(--ema-s2);padding:var(--ema-s3) var(--ema-s3) 0}
.ema-figure-head .ema-toolbar{gap:2px;padding:2px;border-radius:999px;background:var(--ema-surface)}
.ema-figure-head .ema-toolbar .ema-button{min-height:1.7rem;min-width:1.7rem;padding:0 .65em;border-color:transparent;background:transparent;font-size:.75em}
.ema-figure-head .ema-toolbar .ema-button:hover{background:var(--ema-surface-strong);border-color:transparent}
.ema-figure-title{font-size:.875em;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
.ema-figure-body{position:relative;min-width:0;padding:var(--ema-s1) var(--ema-s2) 0}
.ema-figure-foot{display:grid;gap:var(--ema-s1);padding:var(--ema-s1) var(--ema-s3) var(--ema-s2)}
.ema-plot{display:block;width:100%;height:auto;max-width:100%;touch-action:pan-y;user-select:none;-webkit-user-select:none}
.ema-plot-area{cursor:grab}
.ema-plot-area[data-panning=true]{cursor:grabbing}
.ema-plot-focus{fill:none;stroke:var(--ema-focus);stroke-width:2.5;visibility:hidden}
.ema-canvas:focus-visible .ema-plot-focus{visibility:visible}
.ema-grid-line{stroke:var(--ema-border);stroke-width:1;stroke-opacity:.75}
.ema-axis-line{stroke:var(--ema-border);stroke-width:1;stroke-opacity:.6}
.ema-zero-line{stroke:var(--ema-border-strong);stroke-width:1.25;stroke-opacity:.75}
.ema-tick{fill:var(--ema-text-muted);font-size:.7em;letter-spacing:.01em}
.ema-axis-title{fill:var(--ema-text-muted);font-size:.75em;font-weight:600;letter-spacing:.02em}
.ema-legend-text{fill:var(--ema-text-muted);font-size:.78em}
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
.ema[data-theme=dark] .ema-marks .ema-stroke{filter:drop-shadow(0 0 3px color-mix(in srgb,var(--ema-mark) 45%,transparent))}
.ema-fill{fill:var(--ema-mark);stroke:var(--ema-mark)}
.ema-marks .ema-fill{stroke:var(--ema-background);stroke-width:1.5px;paint-order:stroke}
.ema-region{fill:var(--ema-mark);fill-opacity:.16;stroke:var(--ema-mark)}
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
.ema-clip-none{display:flex;align-items:center;gap:var(--ema-s1);padding:var(--ema-s1) var(--ema-s2);border:1px solid transparent;font-size:.75em;color:var(--ema-text-muted)}
.ema-clip-none .ema-glyph{color:var(--ema-muted)}
.ema-notes{display:grid;gap:4px;font-size:.78em;line-height:1.45;color:var(--ema-text-muted)}
.ema-figure-notes>summary{display:inline-flex;align-items:center;gap:.45em;min-height:1.75rem;cursor:pointer;list-style:none;font-size:.75em;color:var(--ema-text-muted);border-radius:3px}
.ema-figure-notes>summary::-webkit-details-marker{display:none}
.ema-figure-notes>summary::before{content:"";width:.38em;height:.38em;margin-left:.1em;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform var(--ema-motion-duration) ease}
.ema-figure-notes[open]>summary::before{transform:rotate(45deg)}
.ema-figure-notes>summary:hover{color:var(--ema-text)}
.ema-figure-notes[open]>.ema-notes{padding:2px 0 var(--ema-s1)}
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
.ema-section-title{font-size:.6875em;font-weight:650;line-height:1.3;letter-spacing:.08em;text-transform:uppercase;color:var(--ema-text-muted)}
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
.ema-slider{width:100%;min-width:0;margin:0;height:1.75rem;accent-color:var(--ema-action);touch-action:pan-y;cursor:pointer;background:transparent;-webkit-appearance:none;appearance:none}
.ema-slider::-webkit-slider-runnable-track{height:4px;border-radius:99px;background:var(--ema-surface-strong)}
.ema-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;margin-top:-6px;border-radius:50%;background:var(--ema-action);border:2px solid var(--ema-background);box-shadow:0 0 0 1px var(--ema-action),0 2px 8px color-mix(in srgb,var(--ema-text) 22%,transparent);transition:transform var(--ema-motion-duration) ease}
.ema-slider:hover::-webkit-slider-thumb{transform:scale(1.12)}
.ema-slider:focus-visible{outline:none}
.ema-slider:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 3px var(--ema-focus),0 2px 8px color-mix(in srgb,var(--ema-text) 22%,transparent)}
.ema-slider::-moz-range-track{height:4px;border-radius:99px;background:var(--ema-surface-strong)}
.ema-slider::-moz-range-thumb{width:13px;height:13px;border-radius:50%;background:var(--ema-action);border:2px solid var(--ema-background)}
.ema-slider:focus-visible::-moz-range-thumb{box-shadow:0 0 0 3px var(--ema-focus)}
.ema-slider[aria-disabled=true]{cursor:not-allowed;opacity:.5}
.ema-exact{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s1)}
.ema-input{min-width:0;width:6em;flex:1 1 6em;max-width:11em;min-height:2rem;padding:0 .65em;border:1px solid var(--ema-border-strong);border-radius:8px;background:var(--ema-background);font-variant-numeric:tabular-nums}
.ema-input[aria-invalid=true]{border-color:var(--ema-error);box-shadow:inset 0 0 0 1px var(--ema-error)}
.ema-input[readonly]{background:var(--ema-surface);color:var(--ema-text-muted)}
.ema-select{min-height:2rem;min-width:0;max-width:100%;padding:0 .55em;border:1px solid var(--ema-border-strong);border-radius:8px;background:var(--ema-background)}
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
.ema-review{flex:1 1 16em;font-size:.7em;color:var(--ema-text-muted)}
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
.ema-spatial{position:relative;min-height:16rem;border-radius:calc(var(--ema-radius) + 2px);overflow:hidden;background:var(--ema-surface)}
.ema-segmented{display:inline-flex;flex-wrap:wrap;gap:2px;padding:2px;border-radius:999px;background:var(--ema-surface)}
.ema-segmented .ema-button{min-height:1.75rem;border-color:transparent;background:transparent}
.ema-segmented .ema-button:hover{background:var(--ema-surface-strong);border-color:transparent}

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
/* Embedded card: the drawing first and full width, the parameters in a compact grid under it, readouts as one quiet row.
   View tools, the legend and the 3D camera controls appear over the drawing while the learner points at or focuses it;
   hints, axis keys and drawing notes stay with assistive technology. Presentation only. */
.ema[data-variant=embedded][data-layout] .ema-workspace{grid-template-columns:minmax(0,1fr);gap:var(--ema-s3)}
.ema[data-variant=embedded] .ema-instruction{font-size:.9em;color:var(--ema-text-muted)}
.ema[data-variant=embedded] .ema-figure{position:relative;border-color:transparent;border-radius:calc(var(--ema-radius) + 2px);background:var(--ema-background);box-shadow:none}
.ema[data-variant=embedded] .ema-figure[data-tentative=true]{border-color:var(--ema-border-strong)}
.ema[data-variant=embedded] .ema-figure-head{position:absolute;top:var(--ema-s1);right:var(--ema-s1);z-index:3;padding:0;opacity:0;pointer-events:none;transition:opacity var(--ema-motion-duration) ease}
.ema[data-variant=embedded] .ema-figure:is(:hover,:focus-within) .ema-figure-head{opacity:1;pointer-events:auto}
.ema[data-variant=embedded] .ema-figure-head :is(.ema-heading,.ema-figure-title){position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.ema[data-variant=embedded] .ema-figure-head :is(.ema-toolbar,.ema-segmented),.ema[data-variant=embedded] .ema-figure-head>.ema-button{border:1px solid var(--ema-border);background:color-mix(in srgb,var(--ema-surface) 90%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:0 6px 18px -8px color-mix(in srgb,var(--ema-text) 35%,transparent)}
.ema[data-variant=embedded] .ema-figure-body{padding:var(--ema-s1) var(--ema-s1) 0}
.ema[data-variant=embedded] .ema-figure-foot{padding:0 var(--ema-s2)}
.ema[data-variant=embedded] .ema-figure-foot:has(.ema-description){padding-bottom:var(--ema-s2)}
.ema-key{position:absolute;top:var(--ema-s2);left:calc(var(--ema-s2) + 2.5em);z-index:2;display:grid;gap:3px;max-width:min(60%,22rem);padding:var(--ema-s1) var(--ema-s2);border:1px solid var(--ema-border);border-radius:calc(var(--ema-radius) - 2px);background:color-mix(in srgb,var(--ema-background) 90%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);font-size:.75em;line-height:1.3;color:var(--ema-text-muted);opacity:0;pointer-events:none;transition:opacity var(--ema-motion-duration) ease}
.ema-figure:is(:hover,:focus-within) .ema-key{opacity:1}
.ema-key li{display:flex;align-items:center;gap:.5em;min-width:0}
.ema-key-swatch{flex:none;overflow:visible}
.ema-clip[data-compact]{position:absolute;left:50%;bottom:calc(var(--ema-s4) + .5em);z-index:2;transform:translateX(-50%);flex-wrap:nowrap;width:max-content;max-width:calc(100% - var(--ema-s4));padding:3px 3px 3px .8em;border-style:solid;border-color:color-mix(in srgb,var(--ema-warning) 55%,var(--ema-border));border-radius:999px;background:color-mix(in srgb,var(--ema-surface) 92%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:0 6px 18px -8px color-mix(in srgb,var(--ema-text) 35%,transparent);font-size:.75em}
.ema-clip[data-compact] .ema-clip-text{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ema-clip[data-compact] .ema-button{min-height:1.6rem;padding:0 .75em;font-size:1em}

.ema[data-variant=embedded] .ema-nav{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s1) var(--ema-s2)}
.ema[data-variant=embedded] .ema-nav>.ema-nav-row{display:contents}
.ema[data-variant=embedded] .ema-nav .ema-panel-title{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.ema[data-variant=embedded] .ema-nav .ema-position{min-width:0;margin-right:var(--ema-s1);font-size:.875em}
.ema[data-variant=embedded] .ema-nav>.ema-toolbar{gap:2px}
.ema[data-variant=embedded] .ema-nav .ema-button{min-height:1.75rem;padding:0 .7em;font-size:.75em}
.ema[data-variant=embedded] .ema-nav>.ema-exact{flex:none;margin-left:auto;flex-wrap:nowrap;font-size:.8125em;color:var(--ema-text-muted)}
.ema[data-variant=embedded] .ema-nav>.ema-exact .ema-input{flex:none;width:4.5em;min-height:1.75rem}
.ema[data-variant=embedded] .ema-nav>:is(p,.ema-error){flex-basis:100%}
.ema-views{display:grid;gap:var(--ema-s3);min-width:0}
.ema-view-cell{display:grid;min-width:0}
@container ema-card (min-width:36rem){.ema-views[data-paired]{grid-template-columns:repeat(2,minmax(0,1fr))}.ema-views[data-paired]>[data-wide]{grid-column:1/-1}}
.ema[data-variant=embedded] .ema-section-title{font-size:.8125em;font-weight:600;letter-spacing:0;text-transform:none}
.ema[data-variant=embedded] .ema-side{gap:var(--ema-s3)}
.ema[data-variant=embedded] .ema-panel{padding-top:0;border-top:0}
.ema[data-variant=embedded] [data-ema-panel=controls]{grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));gap:var(--ema-s2) var(--ema-s4);align-items:start}
.ema[data-variant=embedded] [data-ema-panel=controls]>:not(.ema-control){grid-column:1/-1}
.ema[data-variant=embedded] .ema-control+.ema-control{padding-top:0}
.ema[data-variant=embedded] .ema-control{gap:0}
.ema[data-variant=embedded] .ema-control-head{flex-wrap:nowrap;align-items:center;min-height:1.75rem}
.ema[data-variant=embedded] .ema-control-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.875em;color:var(--ema-text-muted)}
.ema[data-variant=embedded] .ema-control-value{font-size:.9375em}
.ema-exact[data-inline]{flex:none;flex-wrap:nowrap;gap:4px}
.ema-exact[data-inline] .ema-input{flex:none;width:4.5em;min-height:1.75rem;padding:0 .4em;border-color:transparent;background:transparent;text-align:right;font-weight:600;color:var(--ema-text)}
.ema-exact[data-inline] .ema-input:not([readonly]):hover{border-color:var(--ema-border)}
.ema-exact[data-inline] .ema-input:focus{border-color:var(--ema-border-strong);background:var(--ema-background)}
.ema-exact[data-inline] .ema-input[readonly]{color:var(--ema-text);cursor:default}
.ema-exact[data-inline] .ema-input[data-tentative=true]{font-style:italic}
.ema-exact[data-inline] .ema-unit{font-size:.8125em}
.ema-exact[data-inline] .ema-select{min-height:1.75rem;font-size:.8125em}
.ema-exact[data-inline] .ema-button{min-height:1.6rem;padding:0 .7em}
.ema[data-variant=embedded] .ema-control-section{grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));column-gap:var(--ema-s4)}
.ema[data-variant=embedded] .ema-control-section>.ema-section-title{grid-column:1/-1}
.ema[data-variant=embedded] .ema-panel:has(>.ema-scenarios){display:flex;flex-wrap:wrap;align-items:center;gap:var(--ema-s1) var(--ema-s2)}
.ema[data-variant=embedded] .ema-panel:has(>.ema-scenarios)>.ema-panel-title{font-size:.8125em;font-weight:500;letter-spacing:0;text-transform:none}
.ema[data-variant=embedded] .ema-scenarios+.ema-panel-note{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.ema[data-variant=embedded] .ema-scenarios .ema-button{min-height:1.75rem;font-size:.75em}
.ema[data-variant=embedded] [data-ema-panel=values]>.ema-panel-title{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.ema[data-variant=embedded] .ema-values{display:flex;flex-wrap:wrap;gap:var(--ema-s1)}
.ema[data-variant=embedded] .ema-value-row{flex:0 1 auto;flex-wrap:nowrap;gap:.5em;padding:.3em .75em;border-radius:999px;background:var(--ema-surface);font-size:.8125em}
.ema[data-variant=embedded] .ema-value-row:has(.ema-value-reason,.ema-value-unit){flex-wrap:wrap;border-radius:calc(var(--ema-radius) - 2px)}
.ema[data-variant=embedded] .ema-value-row dt{flex:0 1 auto}
.ema[data-variant=embedded] .ema-value-row dd{margin-left:0;text-align:left}
.ema[data-variant=embedded] [data-ema-panel=equations] .ema-nav-row{display:contents}
.ema[data-variant=embedded] [data-ema-panel=equations] .ema-panel-title{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.ema[data-variant=embedded] [data-ema-panel=equations] .ema-nav-row>.ema-button{display:none}
.ema[data-variant=embedded] .ema-equations{display:flex;flex-wrap:wrap;gap:var(--ema-s1) var(--ema-s4)}
.ema[data-variant=embedded] .ema-equation{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 .6em;min-width:0;max-width:100%}
.ema[data-variant=embedded] .ema-equation>.ema-math{flex:0 1 auto;min-width:min-content;max-width:100%}
.ema[data-variant=embedded] .ema-equation>:is(.ema-math-hint,.ema-plain){flex-basis:100%}
.ema[data-variant=embedded] .ema-equation-label{white-space:nowrap;font-size:.75em}
/* Room for the sub-pixel overhang of typeset glyphs, so a formula that fits is never measured as overflowing. */
.ema[data-variant=embedded] .ema-math{padding:1px 3px}
.ema[data-variant=embedded] .ema-shared-reason{font-size:.75em}
.ema[data-variant=embedded] .ema-more{padding-top:0;border-top:0}
.ema[data-variant=embedded] .ema-more>summary{min-height:1.75rem;font-size:.8125em}

.ema[data-variant=embedded] .em3{position:relative;gap:0}
.ema[data-variant=embedded] [data-ema-spatial] .ema-figure-head{top:auto;bottom:var(--ema-s2)}
.ema[data-variant=embedded] .em3-toolbar{position:absolute;left:var(--ema-s2);top:var(--ema-s2);z-index:3;max-width:calc(100% - var(--ema-s4));gap:2px;padding:2px;border:1px solid var(--ema-border);border-radius:999px;background:color-mix(in srgb,var(--ema-surface) 90%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:0 6px 18px -8px color-mix(in srgb,var(--ema-text) 35%,transparent);opacity:0;pointer-events:none;transition:opacity var(--ema-motion-duration) ease}
.ema[data-variant=embedded] .em3:is(:hover,:focus-within) .em3-toolbar{opacity:1;pointer-events:auto}
.ema[data-variant=embedded] .em3-toolbar .em3-button{border-color:transparent;background:transparent}
.ema[data-variant=embedded] .em3-toolbar :is([data-em3-action=whole-box],[data-em3-action=projection],[data-em3-action=wireframe]){display:none}
.ema[data-variant=embedded] .em3-toolbar .em3-button:hover{background:var(--ema-surface-strong)}
.ema[data-variant=embedded] .em3-toolbar .em3-button[aria-pressed=true]{background:color-mix(in srgb,var(--ema-action) 18%,transparent)}
.ema[data-variant=embedded] .em3-viewport{aspect-ratio:16/10;min-height:14rem;max-height:26rem;border-color:transparent;background:var(--ema-background)}
.ema[data-variant=embedded] :is(.em3-hint,.em3-key){position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.ema[data-variant=embedded] .em3-notes li:not([data-kind=limit],[data-kind=undefined],[data-kind=numerical-limit]){position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
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
