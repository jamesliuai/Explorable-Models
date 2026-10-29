import { useId } from 'react';
import type { ReactNode } from 'react';
import type { DocumentFrame, SeriesPoint, SessionState } from '@explorable-models/core/declarative';
export type XY = [number, number];
export const C = { teal: '#09877c', blue: '#477caf', amber: '#b8791d', violet: '#8660cb', ink: '#233344', muted: '#6e7c8c', grid: '#e9edf1' };
export const fmt = (value: number, digits = 2) => value !== 0 && Math.abs(value) < .5 * 10 ** -digits ? value.toExponential(2) : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export function n(f: DocumentFrame, id: string): number {
  const v = f.quantities[id]; if (v?.status !== 'valid' || typeof v.value !== 'number') throw new Error(v?.reason ?? `${id} unavailable`); return v.value;
}
export function maybePoint(f: DocumentFrame, id: string): XY | null {
  const v = f.quantities[id]; return v?.status === 'valid' && Array.isArray(v.value) && v.value.length === 2 ? v.value as XY : null;
}
export function point(f: DocumentFrame, id: string): XY { const value = maybePoint(f, id); if (!value) throw new Error(f.quantities[id]?.reason ?? `${id} unavailable`); return value; }
export function seriesPath(series: SeriesPoint[], project: (p: XY) => XY) {
  let gap = true;
  return series.map(p => {
    if (p.x === null || p.y === null) { gap = true; return ''; }
    const prefix = gap ? 'M' : 'L'; gap = false; return prefix + project([p.x, p.y]).map(x => x.toFixed(3)).join(' ');
  }).join(' ');
}
export function FrameSvg({ state, description, children, className = '' }: { state: SessionState; description: string; children: ReactNode; className?: string }) {
  const uid = useId();
  return <svg className={`ex-scene ${className}`} viewBox="0 0 600 420" role="img" aria-labelledby={`${uid}-title ${uid}-desc`} data-frame-time={state.frame!.time} data-run-id={state.run!.id}>
    <title id={`${uid}-title`}>{state.document!.title}</title><desc id={`${uid}-desc`}>{description}</desc>{children}
  </svg>;
}
export function Arrow({ from, to, color, dashed = false, label, testId }: { from: XY; to: XY; color: string; dashed?: boolean; label?: string; testId?: string }) {
  const uid = useId(); const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (length < 1e-8) return null;
  const size = Math.min(12, length / 2);
  return <g data-testid={testId} aria-label={label}>
    <defs><marker id={uid} markerUnits="userSpaceOnUse" viewBox="0 0 10 10" refX="10" refY="5" markerWidth={size} markerHeight={size} orient="auto"><path d="M0 0 10 5 0 10Z" fill={color} /></marker></defs>
    <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} stroke={color} strokeWidth={Math.min(3, length / 3)} strokeDasharray={dashed ? '5 5' : undefined} markerEnd={`url(#${uid})`} />
  </g>;
}
