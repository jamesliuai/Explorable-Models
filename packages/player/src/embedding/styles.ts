/**
 * Scoped for React hosts; mountVisualization adds a shadow boundary as well. 0.3 presentation: the warm-neutral palette
 * shared with the learner surface (light by default, `theme="dark"` warm charcoal), hairlines, small radii, neutral
 * controls; `--em-series-*` are the default data colours of marks without an authored stroke.
 */
export const surfaceStyles = `
[data-em-surface] { --em-bg:#fbfaf7; --em-ink:#1f1e1c; --em-muted:#57544d; --em-border:#dedbd3; --em-strong:#8b877e; --em-accent:#1f1e1c; --em-soft:#f3f2ee; --em-series-1:#255f9e; --em-series-2:#a5521f; --em-series-3:#6a4e9f; --em-series-4:#2c6e3f; --em-series-5:#7b5800; color:var(--em-ink); background:var(--em-bg); font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif; min-width:0; container-type:inline-size; color-scheme:light; -webkit-font-smoothing:antialiased; }
[data-em-surface][data-theme="dark"] { --em-bg:#1a1a19; --em-ink:#edebe6; --em-muted:#bdbab3; --em-border:#31312e; --em-strong:#77746d; --em-accent:#edebe6; --em-soft:#212120; --em-series-1:#86b2e6; --em-series-2:#e8975c; --em-series-3:#b9a1e4; --em-series-4:#8cc79a; --em-series-5:#dcae62; color-scheme:dark; }
[data-em-surface] *,[data-em-surface] *::before,[data-em-surface] *::after { box-sizing:border-box; }
[data-em-surface] h2,[data-em-surface] h3,[data-em-surface] h4,[data-em-surface] h5,[data-em-surface] h6,[data-em-surface] p { margin:0; }
[data-em-surface] button,[data-em-surface] input { font:inherit; color:inherit; }
[data-em-surface] button { min-height:32px; padding:5px 11px; border:1px solid var(--em-strong); background:var(--em-soft); border-radius:5px; font-size:13px; font-weight:500; cursor:pointer; }
[data-em-surface] button:hover { background:var(--em-border); }
[data-em-surface] button[aria-pressed="true"] { border-color:var(--em-ink); box-shadow:inset 0 -2px 0 var(--em-ink); }
[data-em-surface] button:disabled { opacity:.55; cursor:default; }
[data-em-surface] :focus-visible { outline:2px solid var(--em-accent); outline-offset:2px; }
[data-em-surface] .em-controls { display:flex; flex-wrap:wrap; align-items:end; gap:12px 18px; margin:0 0 14px; padding:0 0 14px; border-bottom:1px solid var(--em-border); }
[data-em-surface] .em-control { flex:1 1 170px; min-width:0; max-width:320px; }
[data-em-surface] .em-control label { display:block; font-weight:500; margin:0 0 4px; }
[data-em-surface] .em-control input[type=range] { width:100%; accent-color:var(--em-ink); margin:6px 0; }
[data-em-surface] .em-exact { display:flex; gap:6px; }
[data-em-surface] input[type=text],[data-em-surface] input[type=number] { min-width:0; width:100%; padding:5px 8px; border:1px solid var(--em-strong); border-radius:5px; background:var(--em-bg); font-variant-numeric:tabular-nums; }
[data-em-surface] .em-hint { color:var(--em-muted); font-size:12px; }
[data-em-surface] .em-grid { display:grid; grid-template-columns:repeat(var(--em-columns,1),minmax(0,1fr)); align-items:start; gap:14px; }
[data-em-surface] .em-view { min-width:0; border:1px solid var(--em-border); border-radius:7px; overflow:hidden; }
[data-em-surface] .em-view-heading { padding:12px 14px 0; }
[data-em-surface] .em-view-heading :is(h2,h3,h4,h5,h6) { font-size:14px; font-weight:600; }
[data-em-surface] .em-view-heading p { color:var(--em-muted); margin-top:3px; }
[data-em-surface] .em-scene { display:block; width:100%; height:auto; background:var(--em-bg); touch-action:pan-y; }
[data-em-surface] .em-scene [data-draggable=true] { cursor:grab; touch-action:none; }
[data-em-surface] .em-scene [role=button]:focus { outline:none; stroke:var(--em-accent); stroke-width:2.5; }
[data-em-surface] .em-toolbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:8px 12px; border-top:1px solid var(--em-border); }
[data-em-surface] .em-values { display:grid; grid-template-columns:minmax(100px,1fr) minmax(0,1fr); gap:8px 14px; padding:14px; margin:0; }
[data-em-surface] .em-values dt { color:var(--em-muted); }
[data-em-surface] .em-values dd { margin:0; font-weight:600; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
[data-em-surface] .em-equation { padding:18px 14px; font:17px/1.7 ui-monospace,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
[data-em-surface] .em-table-wrap { overflow:auto; max-height:350px; margin:12px; }
[data-em-surface] table { border-collapse:collapse; width:100%; text-align:left; font-variant-numeric:tabular-nums; }
[data-em-surface] th,[data-em-surface] td { padding:6px 10px; border-bottom:1px solid var(--em-border); white-space:nowrap; }
[data-em-surface] th { background:var(--em-soft); font-weight:600; color:var(--em-muted); }
[data-em-surface] .em-status { margin:8px 0; padding:8px 12px; border-left:2px solid var(--em-strong); background:var(--em-soft); }
[data-em-surface] .em-undefined { padding:8px 14px; color:var(--em-muted); }
[data-em-surface] .em-selection { padding:8px 0; color:var(--em-muted); }
[data-em-surface] details { margin-top:14px; }
[data-em-surface] summary { cursor:pointer; font-weight:500; color:var(--em-muted); padding:5px 0; }
[data-em-surface] summary:hover { color:var(--em-ink); }
[data-em-surface] pre { overflow:auto; max-height:360px; background:var(--em-soft); border-radius:5px; padding:12px; font-size:12px; }
[data-em-surface] .em-sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@container (max-width:560px) { [data-em-surface] .em-grid { grid-template-columns:1fr; } [data-em-surface] .em-controls { gap:10px; padding:10px; } [data-em-surface] .em-control { flex-basis:140px; } }
@media (prefers-reduced-motion:reduce) { [data-em-surface] * { scroll-behavior:auto; animation:none; transition:none; } }
`;
