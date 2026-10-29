/**
 * Static files of the `explorable-models activity preview` page (written into the preview bundle by activity-bundle.ts).
 * The page loads only same-origin files under the CLI's content security policy: no inline script, no remote fonts,
 * stylesheets or images. The page chrome follows the system colour scheme unless `--theme` fixes it.
 */
export const PREVIEW_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>Activity preview</title><link rel="stylesheet" href="./preview.css"></head>'
  + '<body><main id="preview-root" class="pv"><p class="pv-loading">Starting the activity preview…</p></main><script type="module" src="./preview.js"></script></body></html>';

export const PREVIEW_CSS = `:root {
  color-scheme: light;
  --pv-bg: #f4f5f7; --pv-panel: #ffffff; --pv-text: #1c2024; --pv-muted: #5b636d; --pv-border: #d5dae0; --pv-soft: #eef0f3;
  --pv-author: #6941c6; --pv-author-soft: #f1ecfb; --pv-learner: #0e7a55; --pv-learner-soft: #e7f5ee;
  --pv-error: #b42318; --pv-error-soft: #fdecea; --pv-warning: #8a5a00; --pv-warning-soft: #fdf3dc; --pv-info: #175cd3; --pv-info-soft: #e8f0fd;
  --pv-focus: #175cd3;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --pv-bg: #121418; --pv-panel: #1b1e23; --pv-text: #e7e9ec; --pv-muted: #a3abb5; --pv-border: #343a42; --pv-soft: #252a31;
    --pv-author: #b59cf0; --pv-author-soft: #2a2340; --pv-learner: #5fd0a2; --pv-learner-soft: #17322a;
    --pv-error: #ff8a80; --pv-error-soft: #3a1d1b; --pv-warning: #f0c060; --pv-warning-soft: #3a2f16; --pv-info: #8ab4ff; --pv-info-soft: #1c2840;
    --pv-focus: #8ab4ff;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --pv-bg: #121418; --pv-panel: #1b1e23; --pv-text: #e7e9ec; --pv-muted: #a3abb5; --pv-border: #343a42; --pv-soft: #252a31;
  --pv-author: #b59cf0; --pv-author-soft: #2a2340; --pv-learner: #5fd0a2; --pv-learner-soft: #17322a;
  --pv-error: #ff8a80; --pv-error-soft: #3a1d1b; --pv-warning: #f0c060; --pv-warning-soft: #3a2f16; --pv-info: #8ab4ff; --pv-info-soft: #1c2840;
  --pv-focus: #8ab4ff;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--pv-bg); color: var(--pv-text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
:focus-visible { outline: 2px solid var(--pv-focus); outline-offset: 2px; }
.pv { max-width: 1680px; margin: 0 auto; padding: 16px; }
.pv-loading, .pv-fatal { margin: 32px 0; color: var(--pv-muted); }
.pv-fatal { color: var(--pv-error); }
.pv-header { margin-bottom: 12px; }
.pv-eyebrow { margin: 0; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: var(--pv-muted); }
.pv-header h1 { margin: 2px 0 4px; font-size: 22px; line-height: 1.25; overflow-wrap: anywhere; }
.pv-identity { margin: 0; font-size: 13px; color: var(--pv-muted); overflow-wrap: anywhere; }
.pv-note { margin: 6px 0 0; font-size: 13px; color: var(--pv-muted); max-width: 90ch; }
.pv-stagebar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 12px; margin: 12px 0 8px; background: var(--pv-panel); border: 1px solid var(--pv-border); border-radius: 10px; }
.pv-stagebar label { font-weight: 600; }
.pv-stagebar select { font: inherit; color: inherit; background: var(--pv-soft); border: 1px solid var(--pv-border); border-radius: 6px; padding: 6px 8px; min-width: 0; max-width: 100%; }
.pv-busy { font-size: 13px; color: var(--pv-muted); }
.pv-busy:empty { display: none; }
.pv-route { flex: 1 1 320px; margin: 0; font-size: 13px; color: var(--pv-muted); overflow-wrap: anywhere; }
.pv-jumps { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 13px; }
.pv-jumps a { color: var(--pv-info); text-underline-offset: 2px; }
.pv-instruction { margin: 0 0 12px; font-size: 14px; overflow-wrap: anywhere; }
.pv-blocked { margin: 12px 0; padding: 10px 12px; border-radius: 10px; border-left: 4px solid var(--pv-error); background: var(--pv-error-soft); }
.pv-instruction:empty { display: none; }
.pv-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
@media (max-width: 1000px) { .pv-columns { grid-template-columns: minmax(0, 1fr); } }
.pv-lane { min-width: 0; background: var(--pv-panel); border: 1px solid var(--pv-border); border-radius: 10px; padding: 12px; }
.pv-lane--author { border-top: 4px solid var(--pv-author); }
.pv-lane--learner { border-top: 4px solid var(--pv-learner); box-shadow: inset 0 0 0 1px var(--pv-learner-soft); }
.pv-lane-head { display: flex; align-items: center; gap: 8px; }
.pv-lane-head h2 { margin: 0; font-size: 17px; }
.pv-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; }
.pv-badge--author { background: var(--pv-author-soft); color: var(--pv-author); }
.pv-badge--learner { background: var(--pv-learner-soft); color: var(--pv-learner); }
.pv-lane-note { margin: 4px 0 10px; font-size: 13px; color: var(--pv-muted); }
.pv-surface { min-width: 0; }
.pv-groups, .pv-projection { margin: 0 0 12px; border: 1px solid var(--pv-border); border-radius: 8px; background: var(--pv-soft); }
.pv-projection { margin: 12px 0 0; }
.pv-groups summary, .pv-projection summary { cursor: pointer; padding: 8px 10px; font-size: 13px; font-weight: 600; }
.pv-table-wrap { overflow-x: auto; padding: 0 10px 10px; }
.pv-groups table { width: 100%; border-collapse: collapse; font-size: 13px; }
.pv-groups th, .pv-groups td { text-align: left; padding: 4px 8px 4px 0; border-top: 1px solid var(--pv-border); vertical-align: top; }
.pv-groups thead th { border-top: 0; color: var(--pv-muted); font-weight: 600; }
.pv-groups tbody th { font-weight: 400; }
.pv-kind { display: block; font-size: 12px; color: var(--pv-muted); }
.pv-tag { margin-left: 6px; padding: 0 6px; border-radius: 999px; font-size: 11px; background: var(--pv-warning-soft); color: var(--pv-warning); }
.pv-hidden { color: var(--pv-muted); }
.pv-shown { color: var(--pv-learner); font-weight: 600; }
.pv-json { margin: 0; max-height: 420px; overflow: auto; padding: 10px; font-size: 12px; line-height: 1.45; background: var(--pv-panel); border-top: 1px solid var(--pv-border); border-radius: 0 0 8px 8px; white-space: pre; }
.pv-diagnostics { margin-top: 16px; padding: 12px; background: var(--pv-panel); border: 1px solid var(--pv-border); border-radius: 10px; }
.pv-diagnostics h2 { margin: 0 0 8px; font-size: 17px; }
.pv-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
.pv-chip { padding: 2px 8px; border-radius: 999px; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--pv-soft); border: 1px solid var(--pv-border); }
.pv-chip--clear { color: var(--pv-learner); }
.pv-diagnostics-body { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
@media (max-width: 1000px) { .pv-diagnostics-body { grid-template-columns: minmax(0, 1fr); } }
.pv-diag-group { min-width: 0; }
.pv-diag-group h3 { margin: 0 0 6px; font-size: 14px; }
.pv-diag-group ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.pv-empty { margin: 0; font-size: 13px; color: var(--pv-muted); }
.pv-diag { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 2px 8px; align-items: baseline; padding: 6px 8px; border-radius: 6px; border-left: 3px solid var(--pv-info); background: var(--pv-info-soft); font-size: 13px; }
.pv-diag--error { border-left-color: var(--pv-error); background: var(--pv-error-soft); }
.pv-diag--warning { border-left-color: var(--pv-warning); background: var(--pv-warning-soft); }
.pv-diag-severity { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--pv-muted); }
.pv-diag-code { font-weight: 600; overflow-wrap: anywhere; }
.pv-diag-where { color: var(--pv-muted); overflow-wrap: anywhere; }
.pv-diag-message, .pv-diag-recovery { grid-column: 1 / -1; overflow-wrap: anywhere; }
.pv-diag-recovery { color: var(--pv-muted); }
@media (max-width: 480px) {
  .pv { padding: 12px 16px; }
  .pv-header h1 { font-size: 19px; }
  .pv-lane { padding: 10px; }
  .pv-diag { grid-template-columns: auto minmax(0, 1fr); }
  .pv-diag-where { grid-column: 1 / -1; }
}
`;
