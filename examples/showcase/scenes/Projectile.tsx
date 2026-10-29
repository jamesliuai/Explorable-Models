import type { SessionState } from '@explorable-models/core/declarative';
import { Arrow, C, fmt, FrameSvg, n, point, seriesPath, type XY } from './shared';
export function Projectile({ state }: { state: SessionState }) {
  const f = state.frame!, range = n(f, 'range'), apex = n(f, 'apex');
  const scale = Math.min(440 / Math.max(range, 5), 230 / Math.max(apex, 5));
  const project = ([x, y]: XY): XY => [64 + x * scale, 322 - y * scale];
  const p = project(point(f, 'position')), a = project(point(f, 'apexPoint')), land = project(point(f, 'landing'));
  const v = point(f, 'velocity'), end: XY = [p[0] + v[0] * 1.7, p[1] - v[1] * 1.7];
  const step = Math.max(range, apex) > 60 ? 20 : Math.max(range, apex) > 25 ? 10 : 5;
  const xTicks = Array.from({ length: Math.floor(440 / scale / step) + 1 }, (_, i) => i * step);
  const yTicks = Array.from({ length: Math.floor(260 / scale / step) + 1 }, (_, i) => i * step);
  return <FrameSvg state={state} description={`Projectile at x ${fmt(n(f, 'x'))} m and height ${fmt(n(f, 'y'))} m. Equal horizontal and vertical scales. Range ${fmt(range)} m. Velocity is tangent to the flight path.`}>
    {xTicks.map(x => <g key={x}><line x1={project([x, 0])[0]} y1="48" x2={project([x, 0])[0]} y2="322" stroke={C.grid} /><text x={project([x, 0])[0]} y="347" textAnchor="middle" className="tick">{x}</text></g>)}
    {yTicks.map(y => <g key={y}><line x1="64" y1={project([0, y])[1]} x2="545" y2={project([0, y])[1]} stroke={C.grid} /><text x="50" y={project([0, y])[1] + 4} textAnchor="end" className="tick">{y}</text></g>)}
    <text x="64" y="29" className="axis-label">Height (m)</text><text x="300" y="390" textAnchor="middle" className="axis-label">Horizontal distance (m)</text>
    <path d="M64 48V322H550" fill="none" stroke="#aeb9c4" strokeWidth="1.3" />
    <line x1={a[0]} y1={a[1]} x2={a[0]} y2="322" stroke="#b4bfc9" strokeDasharray="4 5" />
    <path data-testid="trajectory" d={seriesPath(f.series.trajectory, project)} stroke={C.teal} strokeWidth="3" fill="none" />
    <circle cx={a[0]} cy={a[1]} r="4" fill="white" stroke={C.amber} strokeWidth="2" /><text x={a[0]} y={a[1] - 23} textAnchor="middle" fill={C.amber}>Apex</text>
    <circle cx={land[0]} cy={land[1]} r="5" fill={C.violet} /><text x={land[0] + 12} y="310" fill={C.violet}>Impact</text>
    <Arrow from={p} to={end} color={C.blue} testId="velocity-arrow" label="Velocity vector" />
    <text x={Math.min(560, end[0] + 9)} y={Math.min(370, end[1] - 9)} fill={C.blue} fontStyle="italic">v</text>
    <circle data-testid="projectile-dot" cx={p[0]} cy={p[1]} r="7" fill={C.amber} stroke="white" strokeWidth="2" />
    <text x="545" y="30" textAnchor="end" className="scene-note">{f.terminal ? 'At impact · before collision' : `t = ${fmt(f.time)} s`}</text>
  </FrameSvg>;
}
