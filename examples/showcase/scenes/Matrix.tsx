import { useId } from 'react';
import type { SessionState } from '@explorable-models/core/declarative';
import { Arrow, C, FrameSvg, n, point, type XY } from './shared';
export function Matrix({ state }: { state: SessionState }) {
  const f = state.frame!, uid = useId(), project = ([x, y]: XY): XY => [300 + x * 55, 235 - y * 55];
  const origin = project([0, 0]), a = project(point(f, 'e1')), b = project(point(f, 'e2')), corner = project(point(f, 'corner'));
  const polygon = [origin, a, corner, b].map(p => p.join(',')).join(' ');
  const collapsed = n(f, 'area') === 0;
  return <FrameSvg state={state} description={`The gray square has area one. Its teal image has area ${n(f, 'area')}. Blue and violet arrows are the transformed basis vectors. ${collapsed ? 'The map is singular and collapses area.' : n(f, 'determinant') < 0 ? 'Orientation is reversed.' : 'Orientation is preserved.'}`}>
    <defs><clipPath id={uid}><rect x="45" y="40" width="510" height="330" /></clipPath></defs>
    <g clipPath={`url(#${uid})`}>
      {Array.from({ length: 9 }, (_, i) => i - 4).map(i => <g key={i}><line x1={project([i, 0])[0]} y1="40" x2={project([i, 0])[0]} y2="370" stroke={C.grid} /><line x1="45" y1={project([0, i])[1]} x2="555" y2={project([0, i])[1]} stroke={C.grid} /></g>)}
      {Array.from({ length: 7 }, (_, i) => ['X', 'Y'].map(axis => { const start = project(point(f, `grid${axis}${i}a`)), end = project(point(f, `grid${axis}${i}b`)); return <line key={`${axis}${i}`} x1={start[0]} y1={start[1]} x2={end[0]} y2={end[1]} stroke="#a9d7d0" strokeWidth="1" />; }))}
      <path d="M45 235H555 M300 40V370" stroke="#aab5c0" strokeWidth="1.2" />
      <rect x="300" y="180" width="55" height="55" fill="#e8edf2" fillOpacity=".6" stroke="#7f8d9b" strokeDasharray="4 4" />
      <polygon data-testid="mapped-square" points={polygon} fill={C.teal} fillOpacity=".17" stroke={C.teal} strokeWidth="2.2" />
      <Arrow from={origin} to={a} color={C.blue} testId="basis-x" /><Arrow from={origin} to={b} color={C.violet} testId="basis-y" />
      <circle cx={corner[0]} cy={corner[1]} r="5.5" fill={C.amber} stroke="white" strokeWidth="1.5" />
    </g>
    <text x={a[0] + (a[0] < origin[0] ? -14 : 14)} y={a[1] + 22} fill={C.blue} textAnchor={a[0] < origin[0] ? 'end' : 'start'}>Me₁</text>
    <text x={b[0] - 14} y={b[1] - 15} fill={C.violet} textAnchor="end">Me₂</text>
    <text x={corner[0] + 14} y={corner[1] - 13} fill={C.amber}>M(1, 1)</text>
    <text x="547" y="256" className="axis-label">x</text><text x="314" y="48" className="axis-label">y</text>
    <rect x="46" y="384" width="12" height="12" fill="#e8edf2" stroke="#7f8d9b" strokeDasharray="3 2" /><text x="69" y="395" className="scene-note">Original unit square</text>
    <rect x="290" y="384" width="12" height="12" fill="#cae8e2" stroke={C.teal} /><text x="314" y="395" className="scene-note">{collapsed ? 'Collapsed image · area = 0' : 'Transformed square'}</text>
  </FrameSvg>;
}
