import type { SessionState } from '@experiment-kit/core/declarative';
import { C, FrameSvg, seriesPath, type XY } from './shared';
export function Waves({ state }: { state: SessionState }) {
  const f = state.frame!;
  const top = ([x, y]: XY): XY => [55 + x * 165, 120 - y * 36];
  const bottom = ([x, y]: XY): XY => [55 + x * 165, 302 - y * 25];
  return <FrameSvg state={state} description="Two sinusoidal waves are overlaid in the upper panel. The lower panel is their sum at every position. Both vertical axes are labeled in centimetres.">
    <text x="55" y="29" className="panel-label">THE TWO INPUTS</text>
    <line x1="345" y1="24" x2="365" y2="24" stroke={C.blue} strokeWidth="3" /><text x="375" y="29" fill={C.blue}>A</text>
    <line x1="435" y1="24" x2="455" y2="24" stroke={C.amber} strokeDasharray="5 4" strokeWidth="3" /><text x="465" y="29" fill={C.amber}>B</text>
    {[0, 1, 2, 3].map(x => <g key={x}><line x1={55 + x * 165} y1="50" x2={55 + x * 165} y2="182" stroke={C.grid} /><line x1={55 + x * 165} y1="223" x2={55 + x * 165} y2="379" stroke={C.grid} /><text x={55 + x * 165} y="404" className="tick" textAnchor="middle">{x}λ</text></g>)}
    {[-1.5, 0, 1.5].map(y => <g key={y}><line x1="55" x2="550" y1={top([0, y])[1]} y2={top([0, y])[1]} stroke={y === 0 ? '#b4bfc9' : C.grid} /><text x="43" y={top([0, y])[1] + 4} className="tick" textAnchor="end">{y}</text></g>)}
    {[-3, 0, 3].map(y => <g key={y}><line x1="55" x2="550" y1={bottom([0, y])[1]} y2={bottom([0, y])[1]} stroke={y === 0 ? '#b4bfc9' : C.grid} /><text x="43" y={bottom([0, y])[1] + 4} className="tick" textAnchor="end">{y}</text></g>)}
    <path d={seriesPath(f.series.a, top)} fill="none" stroke={C.blue} strokeWidth="2.8" /><path d={seriesPath(f.series.b, top)} fill="none" stroke={C.amber} strokeDasharray="6 4" strokeWidth="2.5" />
    <text x="55" y="211" className="panel-label" fill={C.teal}>THE SUM · A + B</text><text x="550" y="211" textAnchor="end" className="scene-note">displacement (cm)</text>
    <path data-testid="sum-wave" d={seriesPath(f.series.sum, bottom)} fill="none" stroke={C.teal} strokeWidth="3.5" />
  </FrameSvg>;
}
