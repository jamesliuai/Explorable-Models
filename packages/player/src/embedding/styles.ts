/** Scoped for React hosts; mountVisualization adds a shadow boundary as well. */
export const surfaceStyles = `
[data-ek-surface] { --ek-bg:#fff; --ek-ink:#172b3d; --ek-muted:#526375; --ek-border:#ced8e1; --ek-accent:#176a85; --ek-soft:#f4f8fa; color:var(--ek-ink); background:var(--ek-bg); font:14px/1.5 system-ui,sans-serif; min-width:0; container-type:inline-size; color-scheme:light; }
[data-ek-surface][data-theme="dark"] { --ek-bg:#13212d; --ek-ink:#edf3f9; --ek-muted:#b5c7d5; --ek-border:#526375; --ek-accent:#6dd4e7; --ek-soft:#1d3040; color-scheme:dark; }
[data-ek-surface] *,[data-ek-surface] *::before,[data-ek-surface] *::after { box-sizing:border-box; }
[data-ek-surface] h2,[data-ek-surface] h3,[data-ek-surface] h4,[data-ek-surface] h5,[data-ek-surface] h6,[data-ek-surface] p { margin:0; }
[data-ek-surface] button,[data-ek-surface] input { font:inherit; color:inherit; }
[data-ek-surface] button { min-height:36px; padding:6px 11px; border:1px solid var(--ek-border); background:var(--ek-bg); border-radius:6px; cursor:pointer; }
[data-ek-surface] button:hover { background:var(--ek-soft); }
[data-ek-surface] button:disabled { opacity:.55; cursor:default; }
[data-ek-surface] :focus-visible { outline:3px solid var(--ek-accent); outline-offset:3px; }
[data-ek-surface] .ek-controls { display:flex; flex-wrap:wrap; align-items:end; gap:12px; margin:0 0 14px; padding:12px; background:var(--ek-soft); border-radius:8px; }
[data-ek-surface] .ek-control { flex:1 1 170px; min-width:0; max-width:320px; }
[data-ek-surface] .ek-control label { display:block; font-weight:600; margin:0 0 4px; }
[data-ek-surface] .ek-control input[type=range] { width:100%; accent-color:var(--ek-accent); margin:6px 0; }
[data-ek-surface] .ek-exact { display:flex; gap:6px; }
[data-ek-surface] input[type=text],[data-ek-surface] input[type=number] { min-width:0; width:100%; padding:6px 8px; border:1px solid var(--ek-border); border-radius:5px; background:var(--ek-bg); }
[data-ek-surface] .ek-hint { color:var(--ek-muted); font-size:12px; }
[data-ek-surface] .ek-grid { display:grid; grid-template-columns:repeat(var(--ek-columns,1),minmax(0,1fr)); align-items:start; gap:14px; }
[data-ek-surface] .ek-view { min-width:0; border:1px solid var(--ek-border); border-radius:9px; overflow:hidden; }
[data-ek-surface] .ek-view-heading { padding:12px 14px 0; }
[data-ek-surface] .ek-view-heading :is(h2,h3,h4,h5,h6) { font-size:15px; }
[data-ek-surface] .ek-view-heading p { color:var(--ek-muted); margin-top:3px; }
[data-ek-surface] .ek-scene { display:block; width:100%; height:auto; background:var(--ek-bg); touch-action:pan-y; }
[data-ek-surface] .ek-scene [data-draggable=true] { cursor:grab; touch-action:none; }
[data-ek-surface] .ek-scene [role=button]:focus { outline:none; stroke:var(--ek-accent); stroke-width:3; }
[data-ek-surface] .ek-toolbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:8px 12px; border-top:1px solid var(--ek-border); }
[data-ek-surface] .ek-values { display:grid; grid-template-columns:minmax(100px,1fr) minmax(0,1fr); gap:8px 14px; padding:14px; margin:0; }
[data-ek-surface] .ek-values dt { color:var(--ek-muted); }
[data-ek-surface] .ek-values dd { margin:0; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
[data-ek-surface] .ek-equation { padding:18px 14px; font:17px/1.7 ui-monospace,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
[data-ek-surface] .ek-table-wrap { overflow:auto; max-height:350px; margin:12px; }
[data-ek-surface] table { border-collapse:collapse; width:100%; text-align:left; font-variant-numeric:tabular-nums; }
[data-ek-surface] th,[data-ek-surface] td { padding:6px 10px; border-bottom:1px solid var(--ek-border); white-space:nowrap; }
[data-ek-surface] th { background:var(--ek-soft); }
[data-ek-surface] .ek-status { margin:8px 0; padding:8px 12px; border-left:3px solid var(--ek-accent); background:var(--ek-soft); }
[data-ek-surface] .ek-undefined { padding:8px 14px; color:var(--ek-muted); }
[data-ek-surface] .ek-selection { padding:8px 0; color:var(--ek-muted); }
[data-ek-surface] details { margin-top:14px; }
[data-ek-surface] summary { cursor:pointer; font-weight:600; padding:5px 0; }
[data-ek-surface] pre { overflow:auto; max-height:360px; background:var(--ek-soft); padding:12px; font-size:12px; }
[data-ek-surface] .ek-sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@container (max-width:560px) { [data-ek-surface] .ek-grid { grid-template-columns:1fr; } [data-ek-surface] .ek-controls { gap:10px; padding:10px; } [data-ek-surface] .ek-control { flex-basis:140px; } }
@media (prefers-reduced-motion:reduce) { [data-ek-surface] * { scroll-behavior:auto; animation:none; transition:none; } }
`;
