/** Scoped for React hosts; mountVisualization adds a shadow boundary as well. */
export const surfaceStyles = `
[data-em-surface] { --em-bg:#fff; --em-ink:#172b3d; --em-muted:#526375; --em-border:#ced8e1; --em-accent:#176a85; --em-soft:#f4f8fa; color:var(--em-ink); background:var(--em-bg); font:14px/1.5 system-ui,sans-serif; min-width:0; container-type:inline-size; color-scheme:light; }
[data-em-surface][data-theme="dark"] { --em-bg:#13212d; --em-ink:#edf3f9; --em-muted:#b5c7d5; --em-border:#526375; --em-accent:#6dd4e7; --em-soft:#1d3040; color-scheme:dark; }
[data-em-surface] *,[data-em-surface] *::before,[data-em-surface] *::after { box-sizing:border-box; }
[data-em-surface] h2,[data-em-surface] h3,[data-em-surface] h4,[data-em-surface] h5,[data-em-surface] h6,[data-em-surface] p { margin:0; }
[data-em-surface] button,[data-em-surface] input { font:inherit; color:inherit; }
[data-em-surface] button { min-height:36px; padding:6px 11px; border:1px solid var(--em-border); background:var(--em-bg); border-radius:6px; cursor:pointer; }
[data-em-surface] button:hover { background:var(--em-soft); }
[data-em-surface] button:disabled { opacity:.55; cursor:default; }
[data-em-surface] :focus-visible { outline:3px solid var(--em-accent); outline-offset:3px; }
[data-em-surface] .em-controls { display:flex; flex-wrap:wrap; align-items:end; gap:12px; margin:0 0 14px; padding:12px; background:var(--em-soft); border-radius:8px; }
[data-em-surface] .em-control { flex:1 1 170px; min-width:0; max-width:320px; }
[data-em-surface] .em-control label { display:block; font-weight:600; margin:0 0 4px; }
[data-em-surface] .em-control input[type=range] { width:100%; accent-color:var(--em-accent); margin:6px 0; }
[data-em-surface] .em-exact { display:flex; gap:6px; }
[data-em-surface] input[type=text],[data-em-surface] input[type=number] { min-width:0; width:100%; padding:6px 8px; border:1px solid var(--em-border); border-radius:5px; background:var(--em-bg); }
[data-em-surface] .em-hint { color:var(--em-muted); font-size:12px; }
[data-em-surface] .em-grid { display:grid; grid-template-columns:repeat(var(--em-columns,1),minmax(0,1fr)); align-items:start; gap:14px; }
[data-em-surface] .em-view { min-width:0; border:1px solid var(--em-border); border-radius:9px; overflow:hidden; }
[data-em-surface] .em-view-heading { padding:12px 14px 0; }
[data-em-surface] .em-view-heading :is(h2,h3,h4,h5,h6) { font-size:15px; }
[data-em-surface] .em-view-heading p { color:var(--em-muted); margin-top:3px; }
[data-em-surface] .em-scene { display:block; width:100%; height:auto; background:var(--em-bg); touch-action:pan-y; }
[data-em-surface] .em-scene [data-draggable=true] { cursor:grab; touch-action:none; }
[data-em-surface] .em-scene [role=button]:focus { outline:none; stroke:var(--em-accent); stroke-width:3; }
[data-em-surface] .em-toolbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:8px 12px; border-top:1px solid var(--em-border); }
[data-em-surface] .em-values { display:grid; grid-template-columns:minmax(100px,1fr) minmax(0,1fr); gap:8px 14px; padding:14px; margin:0; }
[data-em-surface] .em-values dt { color:var(--em-muted); }
[data-em-surface] .em-values dd { margin:0; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
[data-em-surface] .em-equation { padding:18px 14px; font:17px/1.7 ui-monospace,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
[data-em-surface] .em-table-wrap { overflow:auto; max-height:350px; margin:12px; }
[data-em-surface] table { border-collapse:collapse; width:100%; text-align:left; font-variant-numeric:tabular-nums; }
[data-em-surface] th,[data-em-surface] td { padding:6px 10px; border-bottom:1px solid var(--em-border); white-space:nowrap; }
[data-em-surface] th { background:var(--em-soft); }
[data-em-surface] .em-status { margin:8px 0; padding:8px 12px; border-left:3px solid var(--em-accent); background:var(--em-soft); }
[data-em-surface] .em-undefined { padding:8px 14px; color:var(--em-muted); }
[data-em-surface] .em-selection { padding:8px 0; color:var(--em-muted); }
[data-em-surface] details { margin-top:14px; }
[data-em-surface] summary { cursor:pointer; font-weight:600; padding:5px 0; }
[data-em-surface] pre { overflow:auto; max-height:360px; background:var(--em-soft); padding:12px; font-size:12px; }
[data-em-surface] .em-sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@container (max-width:560px) { [data-em-surface] .em-grid { grid-template-columns:1fr; } [data-em-surface] .em-controls { gap:10px; padding:10px; } [data-em-surface] .em-control { flex-basis:140px; } }
@media (prefers-reduced-motion:reduce) { [data-em-surface] * { scroll-behavior:auto; animation:none; transition:none; } }
`;
