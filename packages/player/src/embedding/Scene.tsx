import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import type { MarkSpec, SeriesPoint, SessionState, ViewSpec } from '@experiment-kit/core/declarative';
import { formatNumber } from './format.js';

export interface SceneActions {
  select(id: string): void;
  preview(params: Record<string, number>): void;
  commit(params: Record<string, number>): void;
  cancel(): void;
}
interface SceneProps { view: ViewSpec; state: SessionState; actions: SceneActions; precision: number; locale: string }
type XY = [number, number];

function validPoints(points: SeriesPoint[]): SeriesPoint[][] {
  const chunks: SeriesPoint[][] = []; let active: SeriesPoint[] = [];
  for (const point of points) {
    if (point.x !== null && point.y !== null && Number.isFinite(point.x) && Number.isFinite(point.y)) active.push(point);
    else if (active.length) { chunks.push(active); active = []; }
  }
  if (active.length) chunks.push(active);
  return chunks;
}
function countSeries(marks: MarkSpec[] = []): number {
  return marks.reduce((total, mark) => total + (mark.style?.hidden ? 0 : mark.series ? 1 : countSeries(mark.children)), 0);
}

export function Scene({ view, state, actions, precision, locale }: SceneProps) {
  const uid = useId().replace(/:/g, '');
  const svgElement = useRef<SVGSVGElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(720);
  useLayoutEffect(() => {
    const svg = svgElement.current;
    if (!svg) return;
    const resize = () => setCanvasWidth(Math.max(280, Math.min(720, svg.getBoundingClientRect().width)));
    resize();
    const observer = new ResizeObserver(resize); observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const baseHeight = canvasWidth < 500 ? 360 : 420;
  const legendColumns = canvasWidth < 500 ? 2 : 4;
  const canvasHeight = baseHeight + Math.max(0, Math.ceil(countSeries(view.marks) / legendColumns) - 1) * 22;
  const availableWidth = canvasWidth - 105, availableHeight = baseHeight - 110;
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const drag = useRef<{ pointerId: number; params: Record<string, number>; matrix: DOMMatrix } | null>(null);
  const suppressClick = useRef(false);
  const frame = state.frame!;
  const base = view.bounds ?? [-5, 5, -5, 5];
  const log = view.scale === 'log';
  const axis = (x: number) => log ? Math.log10(x) : x;
  const undoAxis = (x: number) => log ? 10 ** x : x;
  const baseX = [axis(base[0]), axis(base[1])], baseY = [axis(base[2]), axis(base[3])];
  const spanX = (baseX[1] - baseX[0]) / camera.zoom, spanY = (baseY[1] - baseY[0]) / camera.zoom;
  const centerX = (baseX[0] + baseX[1]) / 2 + camera.x, centerY = (baseY[0] + baseY[1]) / 2 + camera.y;
  const minX = centerX - spanX / 2, minY = centerY - spanY / 2;
  const equalAspect = view.equalAspect ?? view.type === 'scene';
  const scaleX = equalAspect ? Math.min(availableWidth / spanX, availableHeight / spanY) : availableWidth / spanX;
  const scaleY = equalAspect ? scaleX : availableHeight / spanY;
  const innerWidth = spanX * scaleX, innerHeight = spanY * scaleY;
  const left = 65 + (availableWidth - innerWidth) / 2, top = 25 + (availableHeight - innerHeight) / 2;
  const x = (n: number) => left + (axis(n) - minX) * scaleX;
  const y = (n: number) => top + innerHeight - (axis(n) - minY) * scaleY;
  const visible = (point: XY) => point.every(Number.isFinite) && (!log || point.every(n => n > 0));
  const coords = ([a, b]: XY): XY => [x(a), y(b)];
  const problems = new Set<string>();
  const seriesLabels: { label: string; color: string; dash?: string }[] = [];
  const colors = ['#15718d', '#b04d27', '#7557a6', '#28835f', '#9c6d13'];
  let colorIndex = 0;
  const dash = (mark: MarkSpec) => state.selection === (mark.semanticId ?? mark.id) ? '5 3' : mark.style?.dash === 'dashed' ? '8 5' : mark.style?.dash === 'dotted' ? '2 5' : undefined;
  const quantity = (mark: MarkSpec, key: string) => {
    const id = mark.bindings?.[key];
    const result = id ? frame.quantities[id] : undefined;
    if (!result || result.status === 'undefined' || result.value === null) {
      problems.add(`${mark.label}: ${result?.reason ?? `binding ${key} is unavailable`}`);
      return null;
    }
    return result.value;
  };
  const scalar = (mark: MarkSpec, key: string): number | null => {
    const value = quantity(mark, key);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value !== null) problems.add(`${mark.label}: ${key} requires a scalar quantity`);
    return null;
  };
  const vector = (mark: MarkSpec, key: string): XY | null => {
    const value = quantity(mark, key);
    if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) return value as XY;
    if (value !== null) problems.add(`${mark.label}: ${key} requires a two-dimensional quantity`);
    return null;
  };
  const position = (mark: MarkSpec): XY | null => {
    if (mark.bindings?.position) return vector(mark, 'position');
    const a = scalar(mark, 'x'), b = scalar(mark, 'y');
    return a !== null && b !== null ? [a, b] : null;
  };
  const pathFor = (points: XY[]) => points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(3)},${y(p[1]).toFixed(3)}`).join(' ');
  function pointerParams(event: PointerEvent<SVGGElement>, mark: MarkSpec): Record<string, number> | null {
    const svg = event.currentTarget.ownerSVGElement;
    const matrix = drag.current?.matrix ?? svg?.getScreenCTM()?.inverse();
    if (!svg || !matrix || !mark.drag) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    const result: Record<string, number> = {};
    const values = [undoAxis(minX + (point.x - left) / scaleX), undoAxis(minY + (top + innerHeight - point.y) / scaleY)];
    for (const [index, id] of [mark.drag.x, mark.drag.y].entries()) {
      const spec = state.document?.parameters[id];
      if (!spec) return null;
      const raw = Math.min(spec.max, Math.max(spec.min, values[index]));
      const rounded = spec.step ? spec.min + Math.round((raw - spec.min) / spec.step) * spec.step : raw;
      result[id] = Math.min(spec.max, Math.max(spec.min, Number((spec.integer ? Math.round(rounded) : rounded).toPrecision(14))));
    }
    return result;
  }
  function renderMark(mark: MarkSpec): ReactNode {
    if (mark.style?.hidden) return null;
    const semanticId = mark.semanticId ?? mark.id;
    const interactive = mark.type !== 'group';
    const selected = state.selection === semanticId;
    const stroke = mark.style?.stroke ?? colors[colorIndex++ % colors.length];
    const filledArea = ['polygon', 'region', 'bar'].includes(mark.type);
    const fill = mark.style?.fill ?? (filledArea ? stroke : 'none');
    const style = { stroke, fill, fillOpacity: filledArea && !mark.style?.fill ? .15 : undefined, strokeWidth: (mark.style?.strokeWidth ?? 2) + (selected ? 1.5 : 0), strokeDasharray: dash(mark), opacity: mark.style?.opacity ?? 1 };
    let shape: ReactNode = null;
    if (mark.type === 'group') shape = mark.children?.map(renderMark);
    else if (['point', 'label'].includes(mark.type)) {
      const p = position(mark);
      if (p && visible(p)) {
        const [a, b] = coords(p);
        const labelX = a + (mark.offset?.[0] ?? 8), labelY = b + (mark.offset?.[1] ?? -10);
        const labelText = mark.text ?? mark.label;
        shape = mark.type === 'point'
          ? <circle cx={a} cy={b} r={selected ? 7 : 5} {...style} fill={mark.style?.fill ?? stroke} />
          : <><rect x={labelX - 4} y={labelY - 19} width={Math.max(24, labelText.length * 9 + 8)} height="28" fill="transparent" stroke="none" pointerEvents="all" aria-hidden="true" /><text x={labelX} y={labelY} fill={mark.style?.fill ?? stroke} opacity={mark.style?.opacity} stroke="none" pointerEvents="none" fontFamily="system-ui,sans-serif" fontSize="15" fontWeight={selected ? 700 : 400} textDecoration={selected ? 'underline' : undefined}>{labelText}</text></>;
      } else if (p) problems.add(`${mark.label}: coordinates are outside the logarithmic domain`);
    } else if (['segment', 'arrow'].includes(mark.type)) {
      const start = vector(mark, 'start'), end = vector(mark, 'end');
      if (start && end && visible(start) && visible(end)) shape = <line x1={x(start[0])} y1={y(start[1])} x2={x(end[0])} y2={y(end[1])} {...style} markerEnd={mark.type === 'arrow' ? `url(#${uid}-${mark.id}-arrow)` : undefined} />;
    } else if (['path', 'polygon'].includes(mark.type)) {
      const points = quantity(mark, 'points');
      if (Array.isArray(points) && points.length % 2 === 0) {
        const pairs: XY[] = []; for (let i = 0; i < points.length; i += 2) pairs.push([points[i], points[i + 1]]);
        if (pairs.every(visible)) shape = <path d={pathFor(pairs) + (mark.type === 'polygon' ? ' Z' : '')} {...style} />;
      }
    } else if (['circle', 'ellipse', 'angle'].includes(mark.type)) {
      const center = vector(mark, 'center');
      const rx = scalar(mark, mark.type === 'ellipse' ? 'rx' : 'radius');
      const ry = mark.type === 'ellipse' ? scalar(mark, 'ry') : rx;
      if (center && rx !== null && ry !== null) {
        if (rx < 0 || ry < 0) problems.add(`${mark.label}: radius cannot be negative`);
        else if (mark.type === 'angle') {
          const start = scalar(mark, 'startAngle'), end = scalar(mark, 'endAngle');
          if (start !== null && end !== null) {
            const points = Array.from({ length: 65 }, (_, i): XY => [center[0] + rx * Math.cos(start + (end - start) * i / 64), center[1] + ry * Math.sin(start + (end - start) * i / 64)]);
            if (points.every(visible)) shape = <path d={pathFor(points)} {...style} fill="none" />;
          }
        } else {
          // Sample curved geometry for correct logarithmic projection too.
          const points = Array.from({ length: 97 }, (_, i): XY => [center[0] + rx * Math.cos(i * Math.PI / 48), center[1] + ry * Math.sin(i * Math.PI / 48)]);
          if (points.every(visible)) shape = <path d={pathFor(points) + ' Z'} {...style} />;
          else problems.add(`${mark.label}: geometry extends outside the logarithmic domain`);
        }
      }
    } else if (mark.series) {
      const points = frame.series[mark.series];
      if (!points) problems.add(`${mark.label}: series is unavailable`);
      else {
        const filtered = points.map(p => p.x !== null && p.y !== null && !visible([p.x, p.y]) ? { ...p, x: null, y: null, reason: 'outside the logarithmic domain' } : p);
        for (const p of filtered) if (p.x === null || p.y === null) problems.add(`${mark.label}: ${p.reason ?? 'undefined sample; the series has a gap'}`);
        const chunks = validPoints(filtered);
        seriesLabels.push({ label: mark.label, color: stroke, dash: dash(mark) });
        if (mark.type === 'line') shape = chunks.map((chunk, i) => <path key={i} d={pathFor(chunk.map(p => [p.x!, p.y!]))} {...style} fill="none" />);
        else if (mark.type === 'scatter') shape = chunks.flat().map((p, i) => <circle key={i} cx={x(p.x!)} cy={y(p.y!)} r={4} {...style} fill={mark.style?.fill ?? stroke} />);
        else {
          const baseline = mark.bindings?.baseline ? scalar(mark, 'baseline') : 0;
          if (baseline !== null && (!log || baseline > 0)) {
            if (mark.type === 'region') shape = chunks.map((chunk, i) => <path key={i} d={pathFor([[chunk[0].x!, baseline], ...chunk.map((p): XY => [p.x!, p.y!]), [chunk.at(-1)!.x!, baseline]]) + ' Z'} {...style} />);
            else if (mark.type === 'bar') {
              const flat = chunks.flat();
              const barWidth = flat.length > 1 ? Math.min(45, ...flat.slice(1).map((p, i) => Math.abs(x(p.x!) - x(flat[i].x!)) * .7)) : 24;
              shape = flat.map((p, i) => <rect key={i} x={x(p.x!) - barWidth / 2} y={Math.min(y(p.y!), y(baseline))} width={Math.max(1, barWidth)} height={Math.abs(y(p.y!) - y(baseline))} {...style} fill={mark.style?.fill ?? stroke} />);
            }
          } else problems.add(`${mark.label}: baseline is outside the logarithmic domain`);
        }
      }
    }
    if (!shape) return null;
    const keyboard = (event: KeyboardEvent<SVGGElement>) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); actions.select(semanticId); }
      if (event.key === 'Escape' && drag.current) { drag.current = null; actions.cancel(); }
    };
    return <g key={mark.id} opacity={mark.type === 'group' ? mark.style?.opacity : undefined} data-mark-id={mark.id} data-semantic-id={semanticId} data-selected={selected} data-draggable={Boolean(mark.drag)} data-bindings={JSON.stringify(mark.bindings ?? {})} role={interactive ? 'button' : 'group'} aria-label={`${mark.label}${selected ? ', selected' : ''}${mark.drag ? '. Draggable; exact values available in parameter controls.' : ''}`} aria-pressed={interactive ? selected : undefined} tabIndex={interactive ? 0 : undefined} onKeyDown={interactive ? keyboard : undefined} onClick={interactive ? () => { if (suppressClick.current) { suppressClick.current = false; return; } actions.select(semanticId); } : undefined}
      onPointerDown={event => { if (!mark.drag || event.button !== 0) return; const params = pointerParams(event, mark); const matrix = event.currentTarget.ownerSVGElement?.getScreenCTM()?.inverse(); if (!params || !matrix) return; event.preventDefault(); suppressClick.current = true; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointerId: event.pointerId, params, matrix }; actions.preview(params); }}
      onPointerMove={event => { if (!drag.current || drag.current.pointerId !== event.pointerId || !mark.drag) return; const params = pointerParams(event, mark); if (params) { drag.current.params = params; actions.preview(params); } }}
      onPointerUp={event => { if (!drag.current || drag.current.pointerId !== event.pointerId) return; const params = drag.current.params; drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); actions.commit(params); }}
      onPointerCancel={() => { if (drag.current) { drag.current = null; actions.cancel(); } }}>
      <title>{mark.description ?? mark.label}</title>
      {mark.type === 'arrow' ? <defs><marker id={`${uid}-${mark.id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={stroke} /></marker></defs> : null}
      {shape}
    </g>;
  }
  const marks = view.marks?.map(renderMark);
  const ticks = Array.from({ length: 5 }, (_, i) => i / 4);
  return <>
    <svg ref={svgElement} className="ek-scene" data-view-id={view.id} data-session-version={state.version} data-run-id={state.run?.id} data-frame-time={frame.time} data-document-revision={state.identity?.documentRevision} viewBox={`0 0 ${canvasWidth} ${canvasHeight}`} role="group" aria-labelledby={`${uid}-title ${uid}-description`}>
      <title id={`${uid}-title`}>{view.title}</title><desc id={`${uid}-description`}>{view.description ?? 'Interactive visualization.'} {equalAspect ? 'Equal coordinate aspect ratio.' : 'Axes have independent scales.'} {log ? 'Logarithmic axes.' : 'Linear axes.'} Select an object with Enter or Space. Exact parameter controls are above the visualization.</desc>
      <defs><clipPath id={`${uid}-clip`}><rect x={left} y={top} width={innerWidth} height={innerHeight} /></clipPath></defs>
      <rect x={left} y={top} width={innerWidth} height={innerHeight} fill="var(--ek-bg,#fff)" stroke="var(--ek-border,#ced8e1)" />
      {ticks.map(t => <g key={t} fill="var(--ek-muted,#526375)" fontFamily="system-ui,sans-serif" fontSize="12">
        <line x1={left + t * innerWidth} y1={top} x2={left + t * innerWidth} y2={top + innerHeight} stroke="var(--ek-border,#ced8e1)" strokeOpacity=".45" />
        <line x1={left} y1={top + t * innerHeight} x2={left + innerWidth} y2={top + t * innerHeight} stroke="var(--ek-border,#ced8e1)" strokeOpacity=".45" />
        <text x={left + t * innerWidth} y={top + innerHeight + 21} textAnchor="middle">{formatNumber(undoAxis(minX + t * spanX), Math.min(precision, 4), locale)}</text>
        <text x={left - 9} y={top + innerHeight - t * innerHeight + 4} textAnchor="end">{formatNumber(undoAxis(minY + t * spanY), Math.min(precision, 4), locale)}</text>
      </g>)}
      <g clipPath={`url(#${uid}-clip)`}>{marks}</g>
      <text x={left + innerWidth / 2} y={baseHeight - 37} textAnchor="middle" fill="var(--ek-muted,#526375)" fontFamily="system-ui,sans-serif" fontSize="13">{view.xLabel ?? 'x'}{log ? ' (log scale)' : ''}</text>
      <text x="17" y={top + innerHeight / 2} transform={`rotate(-90 17 ${top + innerHeight / 2})`} textAnchor="middle" fill="var(--ek-muted,#526375)" fontFamily="system-ui,sans-serif" fontSize="13">{view.yLabel ?? 'y'}{log ? ' (log scale)' : ''}</text>
      {seriesLabels.map((entry, i) => <g key={i} transform={`translate(${20 + i % legendColumns * ((canvasWidth - 40) / legendColumns)},${baseHeight - 14 + Math.floor(i / legendColumns) * 22})`}><title>{entry.label}</title><line x1="0" y1="-4" x2="20" y2="-4" stroke={entry.color} strokeWidth="3" strokeDasharray={entry.dash} /><text x="27" fill="var(--ek-ink,#172b3d)" fontFamily="system-ui,sans-serif" fontSize="12">{entry.label.length > 18 ? `${entry.label.slice(0, 17)}…` : entry.label}</text></g>)}
    </svg>
    <div className="ek-toolbar" aria-label={`${view.title} view controls`}>
      <button type="button" onClick={() => setCamera(c => ({ ...c, zoom: Math.min(100, c.zoom * 1.4) }))} aria-label={`Zoom in ${view.title}`}>+</button>
      <button type="button" onClick={() => setCamera(c => ({ ...c, zoom: Math.max(.2, c.zoom / 1.4) }))} aria-label={`Zoom out ${view.title}`}>−</button>
      <button type="button" onClick={() => setCamera(c => ({ ...c, x: c.x - spanX / 5 }))} aria-label={`Pan left ${view.title}`}>←</button>
      <button type="button" onClick={() => setCamera(c => ({ ...c, x: c.x + spanX / 5 }))} aria-label={`Pan right ${view.title}`}>→</button>
      <button type="button" onClick={() => setCamera(c => ({ ...c, y: c.y + spanY / 5 }))} aria-label={`Pan up ${view.title}`}>↑</button>
      <button type="button" onClick={() => setCamera(c => ({ ...c, y: c.y - spanY / 5 }))} aria-label={`Pan down ${view.title}`}>↓</button>
      <button type="button" onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}>Reset view</button>
      {state.selection ? <span className="ek-hint">Selected: {state.selection}</span> : null}
    </div>
    {problems.size ? <ul className="ek-undefined" aria-label={`${view.title} undefined values`}>{Array.from(problems).map(message => <li key={message}>{message}</li>)}</ul> : null}
  </>;
}
