import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { DocumentFrame, SessionState } from '@explorable-models/core/declarative';

type Point = [number, number];
export function scalar(frame: DocumentFrame, id: string): number {
  const result = frame.quantities[id];
  if (result?.status !== 'valid' || typeof result.value !== 'number') throw new Error(result?.reason ?? `${id} is unavailable`);
  return result.value;
}
function vector(frame: DocumentFrame, id: string): Point {
  const result = frame.quantities[id];
  if (result?.status !== 'valid' || !Array.isArray(result.value) || result.value.length !== 2) throw new Error(result?.reason ?? `${id} is unavailable`);
  return result.value as Point;
}
export const format = (value: number, digits = 2) => value !== 0 && Math.abs(value) < 0.5 * 10 ** -digits
  ? value.toExponential(2)
  : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Presentation transforms only: scientific geometry and vectors come from this one frame. */
export function RodDiagram({ state }: { state: SessionState }) {
  const uid = useId();
  const element = useRef<SVGSVGElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const update = () => setCompact(element.current!.getBoundingClientRect().width < 420);
    update();
    const observer = new ResizeObserver(update); observer.observe(element.current!);
    return () => observer.disconnect();
  }, []);
  const frame = state.frame!;
  const ox = compact ? 100 : 170, oy = compact ? 65 : 85;
  const rodScale = compact ? 85 : 105, arrowScale = compact ? 10 : 14;
  const radius = compact ? 40 : 54;
  const position = ([x, y]: Point): Point => [ox + x * rodScale, oy - y * rodScale];
  const tip = position(vector(frame, 'tip')), center = position(vector(frame, 'center'));
  const direction = vector(frame, 'direction'), half = vector(frame, 'halfDirection');
  const acceleration = vector(frame, 'acceleration');
  const end: Point = [center[0] + acceleration[0] * arrowScale, center[1] - acceleration[1] * arrowScale];
  const arrowLength = Math.hypot(end[0] - center[0], end[1] - center[1]);
  const arrowHead = Math.min(16, arrowLength / 2);
  const angleEnd: Point = [ox + direction[0] * radius, oy - direction[1] * radius];
  const alpha = scalar(frame, 'alpha'), at = scalar(frame, 'tangential');
  const angle = state.run!.params.angle;
  return <svg ref={element} className="rod-diagram" viewBox={compact ? "0 0 400 360" : "0 0 600 470"} role="img" aria-labelledby={`${uid}-title ${uid}-description`} data-run-id={state.run!.id} data-angle={angle} data-length={state.run!.params.length}>
    <title id={`${uid}-title`}>Hinged rod at {format(angle, 1)} degrees from vertical</title>
    <desc id={`${uid}-description`}>A blue uniform rod with an amber center of mass. At release, its center accelerates perpendicular to the rod at {format(at)} metres per second squared. Clockwise angular acceleration is {format(alpha)} radians per second squared. Arrow length is proportional to tangential acceleration; the curved arrow indicates direction only.</desc>
    <defs>
      <marker id={`${uid}-teal`} data-testid="acceleration-head" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth={arrowHead} markerHeight={arrowHead} orient="auto"><path d="M0 0 10 5 0 10Z" fill="#09877c" /></marker>
      <marker id={`${uid}-violet`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto"><path d="M0 0 10 5 0 10Z" fill="#8660cb" /></marker>
    </defs>
    <path d={`M${ox - 85} ${oy - 23}H${ox + 35}`} stroke="#d9dfe5" strokeWidth="13" strokeLinecap="round" />
    <path d={`M${ox} ${oy - 17}V${compact ? 326 : 425}`} stroke="#a4adb7" strokeWidth="1.5" strokeDasharray="5 7" />
    <text x={ox} y={compact ? 348 : 448} textAnchor="middle" className="diagram-muted">Vertical</text>
    {angle > 0 ? <path d={`M${ox} ${oy + radius} A${radius} ${radius} 0 0 0 ${angleEnd.join(' ')}`} stroke="#a4adb7" strokeWidth="1.5" fill="none" /> : null}
    <text x={ox + half[0] * (radius + 24) - 26 * Math.max(0, 1 - angle / 20)} y={oy + 5 - half[1] * (radius + 24)} textAnchor="middle" className="angle-label">θ</text>
    <line data-testid="rod-body" x1={ox} y1={oy} x2={tip[0]} y2={tip[1]} stroke="#477caf" strokeWidth="16" strokeLinecap="round" />
    <line x1={ox} y1={oy} x2={tip[0]} y2={tip[1]} stroke="#6794bd" strokeWidth="3" strokeLinecap="round" opacity=".7" />
    <circle cx={ox} cy={oy} r="12" fill="#f0f3f6" stroke="#8d99a5" strokeWidth="1.5" />
    <circle cx={ox} cy={oy} r="4" fill="#5f6c79" />
    <text x={ox - 31} y={oy + 6} textAnchor="end" className="diagram-label">Hinge</text>
    <circle data-testid="center-of-mass" cx={center[0]} cy={center[1]} r="8" fill="#c98422" stroke="white" strokeWidth="2" />
    <text x={center[0] + (compact ? 19 : 24)} y={center[1] - 20} fill="#9a6519" className="diagram-label">Center of mass</text>
    {at > 0 ? <>
      <line data-testid="acceleration-arrow" x1={center[0]} y1={center[1]} x2={end[0]} y2={end[1]} stroke="#09877c" strokeWidth={Math.min(4, arrowLength / 3)} markerEnd={`url(#${uid}-teal)`} />
      <text x={end[0] - 12} y={end[1] + 25} textAnchor="end" fill="#09877c" className="vector-label">a<tspan baselineShift="sub" fontSize="13">t</tspan></text>
    </> : null}
    {alpha > 0 ? <g data-testid="angular-arrow" transform={compact ? "translate(-155 -67)" : undefined}>
      <path d="M441 280 A43 43 0 0 1 487 347" fill="none" stroke="#8660cb" strokeWidth="3" markerEnd={`url(#${uid}-violet)`} />
      <text x="475" y="384" textAnchor="middle" fill="#7953b8" className="diagram-label">α clockwise</text>
    </g> : null}
  </svg>;
}
