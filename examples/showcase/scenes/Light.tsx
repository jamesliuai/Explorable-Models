import type { SessionState } from '@experiment-kit/core/declarative';
import { Arrow, C, fmt, FrameSvg, maybePoint, n, point, type XY } from './shared';
export function Light({ state }: { state: SessionState }) {
  const f = state.frame!, origin: XY = [300, 205], tir = n(f, 'sine') > 1;
  const ray = ([x, y]: XY): XY => [300 + x * 165, 205 - y * 165];
  const incoming = ray(point(f, 'incident')), reflected = ray(point(f, 'reflected'));
  const refracted = maybePoint(f, 'refracted');
  const end = refracted ? ray(refracted) : null;
  return <FrameSvg state={state} description={tir ? 'The incident ray is totally internally reflected. No propagating refracted ray exists.' : `The refracted ray makes ${fmt(n(f, 'transmitted'), 1)} degrees with the normal. The incident and reflected angles are equal.`}>
    <rect x="25" y="205" width="550" height="190" rx="0" fill="#eef5f8" />
    <line x1="25" y1="205" x2="575" y2="205" stroke="#b9cbd4" strokeWidth="1.6" />
    <line x1="300" y1="30" x2="300" y2="385" stroke="#a7b4c0" strokeDasharray="5 6" />
    <text x="316" y="30" className="scene-note">normal</text>
    <text x="42" y="177" className="medium-label">n₁ = {fmt(state.run!.params.n1)}</text><text x="42" y="242" className="medium-label">n₂ = {fmt(state.run!.params.n2)}</text>
    <Arrow from={incoming} to={origin} color={C.blue} testId="incident-ray" /><text x={incoming[0] - 16} y={incoming[1] - 14} textAnchor="end" fill={C.blue}>Incident</text>
    <Arrow from={origin} to={reflected} color={C.amber} dashed={!tir} testId="reflected-ray" />
    <text x={reflected[0] > 430 ? reflected[0] - 14 : reflected[0] + 14} y={reflected[1] - 14} textAnchor={reflected[0] > 430 ? 'end' : 'start'} fill={C.amber}>Reflected</text>
    {end ? <><Arrow from={origin} to={end} color={C.teal} testId="refracted-ray" /><text x={end[0] > 430 ? end[0] - 14 : end[0] + 14} y={end[1] + 23} textAnchor={end[0] > 430 ? 'end' : 'start'} fill={C.teal}>Refracted</text></> : <><text x="300" y="294" textAnchor="middle" fill={C.violet} className="tir-heading">Total internal reflection</text><text x="300" y="322" textAnchor="middle" className="scene-note">No propagating ray in the lower medium</text></>}
    <circle cx="300" cy="205" r="5" fill={C.ink} stroke="white" strokeWidth="2" />
    <text x="42" y="403" className="scene-note">Angles are measured from the normal.</text>
  </FrameSvg>;
}
