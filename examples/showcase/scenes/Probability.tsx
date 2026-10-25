import type { SessionState } from '@experiment-kit/core/declarative';
import { C, fmt, FrameSvg, n } from './shared';
export function Probability({ state }: { state: SessionState }) {
  const f = state.frame!, trueFlags = n(f, 'trueFlags'), flagged = n(f, 'flagged'), falseFlags = n(f, 'falseFlags');
  const split = flagged > 0 ? trueFlags / flagged * 490 : 0;
  return <FrameSvg state={state} description={`Out of 1000 parts, the expected counts are ${fmt(trueFlags, 1)} correct flags and ${fmt(falseFlags, 1)} false flags. Fractional cells show fractional expected counts, not rounded observations.`}>
    <text x="55" y="28" className="panel-label">1,000 PARTS INSPECTED</text>
    <text x="55" y="51" className="scene-note">Each cell represents one expected part.</text>
    {Array.from({ length: 1000 }, (_, i) => {
      const x = 55 + (i % 50) * 9.85, y = 72 + Math.floor(i / 50) * 9.2;
      // Interval clipping is solely the fractional-cell presentation of model counts.
      const correct = Math.min(1, Math.max(0, trueFlags - i));
      const falsePart = Math.max(0, Math.min(i + 1, flagged) - Math.max(i, trueFlags));
      return <g key={i}><rect x={x} y={y} width="7.3" height="6.3" rx=".8" fill="#e3e9ee" />{correct > 0 ? <rect x={x} y={y} width={7.3 * correct} height="6.3" fill={C.teal} /> : null}{falsePart > 0 ? <rect x={x + 7.3 * correct} y={y} width={7.3 * falsePart} height="6.3" fill={C.amber} /> : null}</g>;
    })}
    <circle cx="60" cy="273" r="4" fill={C.teal} /><text x="73" y="278" className="scene-note">Correct flag</text>
    <circle cx="240" cy="273" r="4" fill={C.amber} /><text x="253" y="278" className="scene-note">False flag</text>
    <circle cx="414" cy="273" r="4" fill="#d6e0e7" /><text x="427" y="278" className="scene-note">Unflagged</text>
    <text x="55" y="317" className="panel-label">NOW LOOK ONLY AT THE FLAGS</text>
    <rect x="55" y="337" width="490" height="28" rx="4" fill="#edf1f4" />
    {flagged > 0 ? <><rect data-testid="true-flags-bar" x="55" y="337" width={split} height="28" fill={C.teal} /><rect x={55 + split} y="337" width={490 - split} height="28" fill={C.amber} /><text x="55" y="392" fill={C.teal}>{fmt(trueFlags, 1)} correct</text><text x="545" y="392" fill={C.amber} textAnchor="end">{fmt(falseFlags, 1)} false</text></> : <text x="300" y="391" textAnchor="middle" className="scene-note">No flags → conditional probability is undefined.</text>}
  </FrameSvg>;
}
