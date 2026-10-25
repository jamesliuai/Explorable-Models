import type { SessionState } from '@experiment-kit/core/declarative';
import { Arrow, C, fmt, FrameSvg, n, point, type XY } from './shared';
export function Forces({ state }: { state: SessionState }) {
  const f = state.frame!;
  const project = ([x, y]: XY): XY => [38 + x * 51, 305 - y * 51];
  const end = project(point(f, 'rampEnd'));
  const corners = ['blockA', 'blockB', 'blockC', 'blockD'].map(id => project(point(f, id)));
  const origin: XY = [430, 205];
  const forceEnd = (id: string): XY => { const v = point(f, id); return [origin[0] + v[0] * 1.4, origin[1] - v[1] * 1.4]; };
  const normal = forceEnd('normalVector'), friction = forceEnd('frictionVector'), weight = forceEnd('weightVector');
  const slip = n(f, 'net') > 1e-9;
  return <FrameSvg state={state} description={`${slip ? 'The block accelerates downhill' : 'The block is held at rest'}. Weight ${fmt(n(f, 'weight'))} N, normal force ${fmt(n(f, 'normal'))} N, friction ${fmt(n(f, 'resistance'))} N. All force arrows share the same scale.`}>
    <text x="150" y="35" textAnchor="middle" className="panel-label">ON THE RAMP</text><text x="435" y="35" textAnchor="middle" className="panel-label">FREE-BODY DIAGRAM</text>
    <line x1="290" y1="65" x2="290" y2="325" stroke={C.grid} />
    <path d={`M38 305 L${end.join(' ')} L${end[0]} 305 Z`} fill="#f0f3f6" stroke="#b9c4ce" strokeWidth="1.5" />
    <line x1="38" y1="305" x2={end[0]} y2={end[1]} stroke="#8898a7" strokeWidth="3" />
    <polygon data-testid="ramp-block" points={corners.map(p => p.join(',')).join(' ')} fill="#dbe9f5" stroke={C.blue} strokeWidth="2" />
    <text x="38" y="346" fill={C.muted}>θ = {fmt(state.run!.params.angle, 1)}°</text>
    <Arrow from={origin} to={weight} color={C.violet} testId="weight-force" /><text x={weight[0] + 17} y={weight[1] + 5} fill={C.violet}>mg</text>
    <Arrow from={origin} to={normal} color={C.blue} testId="normal-force" /><text x={normal[0] - 12} y={normal[1] - 12} textAnchor="end" fill={C.blue}>N</text>
    <Arrow from={origin} to={friction} color={C.amber} testId="friction-force" />{n(f, 'resistance') > 0 ? <text x={friction[0] + 12} y={friction[1] - 10} fill={C.amber}>f</text> : null}
    <circle cx={origin[0]} cy={origin[1]} r="6" fill={C.ink} stroke="white" strokeWidth="2" />
    <text x="435" y="354" textAnchor="middle" className="scene-note">Vector balance · ΣF = ma</text>
    <rect x="38" y="375" width="524" height="28" rx="6" fill={slip ? '#eaf5f3' : '#f2eef8'} />
    <text x="300" y="394" textAnchor="middle" fill={slip ? C.teal : C.violet} className="scene-status">{slip ? `Sliding · net force ${fmt(n(f, 'net'))} N downhill` : 'Static equilibrium · friction balances the downhill pull'}</text>
  </FrameSvg>;
}
