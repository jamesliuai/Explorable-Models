/**
 * SVG renderer for one 2D view (or the 2D projection of a 3D view). It draws only the scene plan derived from the
 * projection, keeps decorative marks out of the accessibility tree, gives selectable marks one roving tab stop and each
 * draggable point a keyboard alternative, and treats camera changes as presentation: pan/zoom gestures stay local until
 * the gesture ends, then one guarded `setCamera` serializes them. Leaving the authored bounds shows a clipped indicator
 * with “Inspect values” and an explicit “Fit to data”; the view never rescales on its own.
 *
 * Draggable points (report §9, §10.2, §11) follow the same gesture rules as the sliders (Controls.tsx):
 * - pointer: pointerdown on the handle begins a `drag` preview; moves update it; pointerup commits it once;
 *   pointercancel or lost pointer capture cancels it (`pointercancel`); Escape cancels it and the still-pressed pointer
 *   can then neither move nor commit anything until it is released;
 * - keyboard: arrow keys move the point by one control step along one axis (a `keyboard` preview); key up commits;
 *   Escape cancels;
 * - blur: the one rule shared with sliders — losing focus cancels an unfinished pointer or keyboard gesture (`blur`);
 * - values are relative to the press: each axis moves by the pointer's displacement from where it was pressed, is
 *   snapped to that control's step grid and clamped to its range, and an axis the pointer has not moved along by half
 *   a step is not sent at all, so a horizontal drag never perturbs y;
 * - a preview ended elsewhere (navigation, a host stage change, a revoked policy) or a card that became inert ends the
 *   drag: releasing it commits nothing.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { Camera2D, GestureKind, ProjectedControl, ProjectedMark, ProjectedView } from '@experiment-kit/activity';
import { dragAxisValue, dragControlStep, snapToStep } from '../drag.js';
import { formatPlain, formatShown, formatTick } from '../format.js';
import { labelMetrics, layoutLabelKey, layoutLegend, placeLabels, wrapText, type LegendEntry } from '../labels.js';
import { clippedData, comparisonGlyph, comparisonMarks, DASH, labelObstacles, markerPath, MARKER_RADIUS, planScene, STROKE_WIDTH, type ClippedMark, type PlannedMark, type Primitive } from '../plan.js';
import { PreviewGesture } from '../runtime.js';
import {
  boundsOf, CAMERA_LIMITS, cameraDomain, fitCamera, fitFrame, fitTicks, niceTicks, panCamera, plotHeight, translateCamera,
  validBounds, zoomCamera, type Bounds2, type Point,
} from '../scale.js';
import { Heading, useElementWidth, useRoving, useRuntime, useStableId } from './context.js';

export interface Scene2DProps {
  view: ProjectedView;
  /** Set on the drawing that a capture of `view.viewId` should select. */
  captureViewId: string | null;
  projectionId: string;
  frameId: string | null;
  titleId: string;
  camera: Camera2D | null;
  /** Serializes a camera (null = reset to the authored view). Absent: the camera is local to this drawing. */
  onCamera?: (camera: Camera2D | null) => void;
  selection: string | null;
  onSelect?: (markId: string | null) => void;
  controls: readonly ProjectedControl[];
  showSummary: boolean;
  headingLevel: number;
  /** The projection shows a tentative preview frame (marked on the figure; never announced per frame). */
  tentative?: boolean;
  /** Heading text (defaults to the view title). */
  heading?: string;
  /** Extra head content, such as the projection-plane selector. */
  headExtra?: ReactNode;
  /** Kept runs of the comparisons, drawn dashed under the current run with their own hollow marker shapes. */
  overlays?: readonly Scene2DOverlay[];
  /**
   * The drawing can change without the learner touching it (playback or stepping): the out-of-view line under the
   * figure is reserved at the height of its longest possible text, so data leaving the view never moves the navigation
   * below it (report §10.1, §10.2). Without it the indicator appears only while data are out of view.
   */
  reserveOutOfView?: boolean;
}
/** One kept run's marks for this view (projected from its own identified frame; see `ProjectedComparison.overlays`). */
export interface Scene2DOverlay { runId: string; ordinal: number; name: string; frameId: string | null; marks: readonly ProjectedMark[] }

const KEY_COMMIT_MS = 350;
/** Left edge (px) of a label-key entry's text, after its callout number. */
const KEY_INDENT = 36;
const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export { snapToStep } from '../drag.js';
/** One drag of a point: its gesture, where it was pressed (data units) and the committed values it started from. */
interface DragState { gesture: PreviewGesture; mark: PlannedMark; pointerId: number | null; origin: Point | null; start: Record<string, number>; moved: Set<string> }

function primitiveClass(primitive: Primitive): string {
  const role = `eka-role-${primitive.style.role}`;
  switch (primitive.shape.type) {
    case 'path': return `${role} ${primitive.shape.fill ? 'eka-region' : 'eka-stroke'}`;
    case 'marker': return `${role} ${primitive.shape.glyph === 'cross' ? 'eka-stroke' : primitive.shape.hollow ? 'eka-hollow' : 'eka-fill'}`;
    case 'arrow': return `${role} eka-stroke`;
    case 'bar': return `${role} eka-region`;
  }
}

function PrimitiveShape({ primitive, selected }: { primitive: Primitive; selected: boolean }) {
  const width = STROKE_WIDTH[primitive.style.weight] * (selected ? 1.6 : 1);
  const dash = DASH[primitive.style.dash];
  const shape = primitive.shape;
  switch (shape.type) {
    case 'path': return <path className={primitiveClass(primitive)} d={shape.d} strokeWidth={width} strokeDasharray={dash} />;
    case 'marker': return <path className={primitiveClass(primitive)} d={markerPath(shape.glyph, shape.x, shape.y, shape.radius)} strokeWidth={shape.glyph === 'cross' ? 2 : 1.25} />;
    case 'arrow': return (
      <g className={primitiveClass(primitive)}>
        <path d={shape.shaft} strokeWidth={width} strokeDasharray={dash} />
        {shape.head ? <path d={shape.head} className={`eka-role-${primitive.style.role} eka-fill`} strokeWidth={1} /> : null}
      </g>
    );
    case 'bar': return <rect className={primitiveClass(primitive)} x={shape.x} y={shape.y} width={shape.width} height={shape.height} strokeWidth={1.25} />;
  }
}

function LegendSwatch({ entry, y }: { entry: LegendEntry; y: number }) {
  const style = entry.style as Primitive['style'];
  const role = `eka-role-${style.role}`;
  const showLine = !['point', 'points', 'bar', 'label'].includes(entry.kind);
  const marker = style.marker !== 'none' ? style.marker : ['point', 'points', 'trace'].includes(entry.kind) ? 'circle' : null;
  return (
    <g aria-hidden="true">
      {entry.kind === 'region' || entry.kind === 'polygon' || entry.kind === 'bar'
        ? <rect className={`${role} eka-region`} x={entry.x + 3} y={y - 6} width={24} height={12} strokeWidth={1.25} />
        : showLine ? <line className={`${role} eka-stroke`} x1={entry.x} x2={entry.x + 30} y1={y} y2={y} strokeWidth={STROKE_WIDTH[style.weight]} strokeDasharray={DASH[style.dash]} /> : null}
      {marker ? <path className={`${role} ${marker === 'cross' ? 'eka-stroke' : entry.markId.startsWith('kept-') ? 'eka-hollow' : 'eka-fill'}`} d={markerPath(marker as 'circle', entry.x + 15, y, MARKER_RADIUS[style.weight] ?? 4.5)} strokeWidth={1.25} /> : null}
    </g>
  );
}

export function Scene2D(props: Scene2DProps) {
  const { view, onCamera, controls, overlays } = props;
  const runtime = useRuntime();
  const [bodyRef, measuredWidth, fontPx] = useElementWidth<HTMLDivElement>(560);
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useStableId('eka-clip');
  const markerClipId = useStableId('eka-clip-markers');
  const summaryId = useStableId('eka-summary');
  const [ownCamera, setOwnCamera] = useState<Camera2D | null>(null);
  const [tentative, setTentative] = useState<Camera2D | null | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pan = useRef<{ pointerId: number; start: Point; camera: Camera2D | null; moved: boolean } | null>(null);
  const [panning, setPanning] = useState(false);
  const drag = useRef<DragState | null>(null);

  const width = Math.max(240, measuredWidth);
  const committedCamera = onCamera ? props.camera : ownCamera;
  const camera = tentative !== undefined ? tentative : committedCamera;

  // Authored bounds are the teaching default. Only a view without authored bounds derives them from its data.
  const authored = validBounds(view.bounds);
  const baseBounds = useMemo<Bounds2>(() => {
    if (authored) return boundsOf(view.bounds);
    const probe = planScene(view, fitFrame([-1, 1, -1, 1], { x: 0, y: 0, width: 100, height: 100 }, false));
    const e = probe.extent;
    if (!e) return [-1, 1, -1, 1];
    const pad = (lo: number, hi: number): [number, number] => hi > lo ? [lo - (hi - lo) * 0.08, hi + (hi - lo) * 0.08] : [lo - 1, hi + 1];
    const [x0, x1] = pad(e[0], e[1]), [y0, y1] = pad(e[2], e[3]);
    return [x0, x1, y0, y1];
  }, [view, authored]);

  const layout = useMemo(() => {
    const domain = cameraDomain(baseBounds, camera);
    const tickPx = fontPx * 0.75, titlePx = fontPx * 0.8125;
    const metrics = labelMetrics(titlePx);
    const tickMetrics = labelMetrics(tickPx);
    // Axis titles wrap to as many lines as they need (report §10.3: never cut or shrunk); the plot moves down for them.
    const yTitle = view.axes ? wrapText(`${view.axes.y.label}${view.axes.y.unitLabel ? ` (${view.axes.y.unitLabel})` : ''}`, width - 16, metrics.charWidth, Infinity) : [];
    const xTitle = view.axes ? wrapText(`${view.axes.x.label}${view.axes.x.unitLabel ? ` (${view.axes.x.unitLabel})` : ''}`, width - 16, metrics.charWidth, Infinity) : [];
    const yChars = (set: { ticks: number[]; step: number }) => Math.max(1, ...set.ticks.map(t => [...formatTick(t, set.step, runtime.locale)].length));
    const leftFor = (chars: number) => Math.ceil(Math.min(width * 0.3, chars * tickMetrics.charWidth + 12));
    const top = yTitle.length ? yTitle.length * metrics.lineHeight + 10 : 10;
    const right = 14;
    const fit = (left: number) => {
      const plotWidth = Math.max(80, width - left - right);
      const plotHeightPx = plotHeight(plotWidth, domain, view.equalAspect, fontPx);
      const frame = fitFrame(domain, { x: left, y: top, width: plotWidth, height: plotHeightPx }, view.equalAspect);
      return { plotWidth, plotHeightPx, frame, yTicks: fitTicks(frame.domain[2], frame.domain[3], plotHeightPx, () => tickMetrics.lineHeight, fontPx * 1.2) };
    };
    // The left margin is sized from a preliminary tick set; when the fitted y ticks are wider (17.5 where the
    // preliminary set had 20), the plot is fitted once more with room for them, so tick labels are never clipped.
    let fitted = fit(leftFor(yChars(niceTicks(domain[2], domain[3], 6))));
    if (leftFor(yChars(fitted.yTicks)) > fitted.frame.plot.x) fitted = fit(leftFor(yChars(fitted.yTicks)));
    const { plotWidth, plotHeightPx, frame, yTicks } = fitted;
    const labelWidth = (ticks: number[], step: number) => Math.max(1, ...ticks.map(t => [...formatTick(t, step, runtime.locale)].length)) * tickMetrics.charWidth;
    const xTicks = fitTicks(frame.domain[0], frame.domain[1], plotWidth, labelWidth, fontPx * 0.9);
    const plan = planScene(view, frame);
    // Labels with no free place become numbered callouts whose full text is listed in the figure's label key.
    const placed = placeLabels(plan.labels, { metrics, bounds: frame.plot, obstacles: labelObstacles(plan), callouts: true });
    // Kept runs: planned against the same frame, drawn under the current run; markers hollow, never labelled.
    const kept = (overlays ?? []).map(overlay => {
      const overlayPlan = planScene({ marks: comparisonMarks(overlay.marks, overlay.ordinal) }, frame);
      const primitives = overlayPlan.marks.flatMap(mark => mark.primitives).map(primitive => primitive.shape.type === 'marker' ? { ...primitive, shape: { ...primitive.shape, hollow: true } } : primitive);
      return { overlay, primitives, clipped: overlayPlan.clipped };
    });
    const legendItems = [
      // Every projected data mark keeps its legend entry whether or not this frame draws it (no steps at n = 0, an
      // undefined value), so the figure's height does not change between frames, previews and playback (G40).
      ...plan.marks.filter(mark => mark.kind !== 'label' && mark.kind !== 'grid')
        .map(mark => ({ markId: mark.markId, label: mark.label, kind: mark.kind, style: view.marks.find(m => m.markId === mark.markId)!.style })),
      ...kept.filter(item => item.primitives.length).map(({ overlay }) => ({
        markId: `kept-${overlay.ordinal}`, label: `Kept run ${overlay.ordinal} (${overlay.name})`, kind: 'trace' as const,
        style: { role: 'muted' as const, dash: 'dashed' as const, weight: 'regular' as const, marker: comparisonGlyph(overlay.ordinal) },
      })),
    ];
    const legendTop = top + plotHeightPx + tickPx * 1.9 + (xTitle.length ? xTitle.length * metrics.lineHeight + 4 : 0) + 6;
    const legend = layoutLegend(legendItems, width - 8, metrics);
    const keyTop = legendTop + legend.height + (legend.entries.length ? 6 : 0);
    const key = layoutLabelKey(placed.callouts, width - 8, metrics, KEY_INDENT);
    const height = Math.ceil(keyTop + key.height + (key.entries.length ? 6 : 0));
    return { frame, xTicks, yTicks, plan, placed, legend, legendTop, key, keyTop, height, xTitle, yTitle, metrics, tickPx, kept };
  }, [view, baseBounds, camera, width, fontPx, runtime.locale, overlays]);

  const { frame, plan, placed } = layout;
  // Label collisions for authors (report §15.2): an overlap that remains, and a label shown as a numbered callout.
  const overlapSignature = placed.diagnostics.filter(d => d.code === 'LABEL_OVERLAP' || d.code === 'LABEL_CALLOUT').map(d => `${d.code}:${d.labelId}`).join('|');
  // Reported once per distinct set of overlapping labels, not on every render.
  useEffect(() => {
    if (!overlapSignature) return;
    for (const diagnostic of placed.diagnostics) if (diagnostic.code === 'LABEL_OVERLAP' || diagnostic.code === 'LABEL_CALLOUT') runtime.report({ source: 'surface', code: diagnostic.code, message: diagnostic.message, path: `views.${view.viewId}.marks.${diagnostic.markId}` });
  }, [overlapSignature]);
  // Bounded data outside the authored bounds (report §15.2): judged at the authored view only, because a learner's zoom or
  // pan is presentation. Reported once per distinct set of clipped marks, not on every frame.
  const clipped = authored && camera === null ? clippedData(view, plan) : [];
  const clippedSignature = clipped.map(item => item.markId).join('|');
  useEffect(() => {
    if (!clippedSignature) return;
    for (const item of clipped) runtime.report({
      source: 'surface', code: 'CLIPPED', path: `views.${view.viewId}.marks.${item.markId}`,
      message: `${item.count} drawn ${item.count === 1 ? 'coordinate' : 'coordinates'} of “${item.label.slice(0, 60)}” lie outside the authored view bounds; the view shows its clipped indicator and never rescales on its own.`,
    });
  }, [clippedSignature]);

  const commitCamera = (next: Camera2D | null) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setTentative(undefined);
    if (onCamera) onCamera(next); else setOwnCamera(next);
  };
  const scheduleCamera = (next: Camera2D) => {
    setTentative(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commitCamera(next), KEY_COMMIT_MS);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // A committed camera from the projection (this or another surface) replaces any tentative local camera.
  useEffect(() => { if (timer.current === null && !pan.current) setTentative(undefined); }, [props.camera]);

  const svgPoint = (clientX: number, clientY: number): Point => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    return [(clientX - rect.left) * width / rect.width, (clientY - rect.top) * layout.height / rect.height];
  };

  // Wheel zoom only with Ctrl/⌘ (trackpad pinch) or while the plot has focus, so page scrolling is never hijacked.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      const focused = svg.contains((svg.getRootNode() as Document | ShadowRoot).activeElement);
      if (!event.ctrlKey && !event.metaKey && !focused) return;
      event.preventDefault();
      const [px, py] = svgPoint(event.clientX, event.clientY);
      const factor = Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * 0.002);
      scheduleCamera(zoomCamera(baseBounds, camera, factor, frame.fromScreen(px, py)));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  });

  const onCanvasKey = (event: KeyboardEvent<SVGGElement>) => {
    const step = CAMERA_LIMITS.panFraction;
    const actions: Record<string, () => Camera2D | null | 'reset' | 'cancel'> = {
      '+': () => zoomCamera(baseBounds, camera, CAMERA_LIMITS.zoomStep), '=': () => zoomCamera(baseBounds, camera, CAMERA_LIMITS.zoomStep),
      '-': () => zoomCamera(baseBounds, camera, 1 / CAMERA_LIMITS.zoomStep), '_': () => zoomCamera(baseBounds, camera, 1 / CAMERA_LIMITS.zoomStep),
      ArrowLeft: () => panCamera(baseBounds, camera, -step, 0), ArrowRight: () => panCamera(baseBounds, camera, step, 0),
      ArrowUp: () => panCamera(baseBounds, camera, 0, step), ArrowDown: () => panCamera(baseBounds, camera, 0, -step),
      '0': () => 'reset', Home: () => 'reset', Escape: () => 'cancel',
    };
    const action = actions[event.key];
    if (!action) return;
    const next = action();
    if (next === 'cancel') { if (tentative === undefined) return; if (timer.current) clearTimeout(timer.current); timer.current = null; setTentative(undefined); }
    else if (next === 'reset') commitCamera(null);
    else if (next) scheduleCamera(next);
    event.preventDefault();
  };

  const onAreaPointerDown = (event: ReactPointerEvent<SVGRectElement>) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current = { pointerId: event.pointerId, start: svgPoint(event.clientX, event.clientY), camera, moved: false };
    setPanning(true);
  };
  const onAreaPointerMove = (event: ReactPointerEvent<SVGRectElement>) => {
    const state = pan.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const [px, py] = svgPoint(event.clientX, event.clientY);
    if (!state.moved && Math.hypot(px - state.start[0], py - state.start[1]) < 3) return;
    state.moved = true;
    setTentative(translateCamera(baseBounds, state.camera, (px - state.start[0]) / frame.scaleX, -(py - state.start[1]) / frame.scaleY));
  };
  const endPan = (event: ReactPointerEvent<SVGRectElement>, commit: boolean) => {
    const state = pan.current;
    if (!state || state.pointerId !== event.pointerId) return;
    pan.current = null;
    setPanning(false);
    if (commit && state.moved && tentative !== undefined && tentative !== null) commitCamera(tentative);
    else setTentative(undefined);
  };

  const controlFor = (parameter: string | undefined) => controls.find(control => control.parameter === parameter);
  const AXES = [['x', 0], ['y', 1]] as const;
  /**
   * Values of a pointer drag at `data`: each axis moves by the displacement from the press point, snapped to its
   * control's display-unit step grid; canonical displacements are converted before adding to the display value. An
   * axis not yet moved by half a display step during this drag is left out (its committed value stays).
   */
  const dragValues = (state: DragState, data: Point): Record<string, number> => {
    const values: Record<string, number> = {};
    for (const [axis, index] of AXES) {
      const ref = state.mark.draggable?.[axis];
      if (!ref || !state.origin) continue;
      const control = controlFor(ref.parameter);
      if (!control) continue;
      const value = dragAxisValue(state.start[ref.parameter]!, data[index] - state.origin[index], view.axes?.[axis]?.unitLabel,
        control, ref, state.moved.has(axis));
      if (value === null) continue;
      state.moved.add(axis);
      values[ref.parameter] = value;
    }
    return values;
  };
  const committedValues = (mark: PlannedMark) => Object.fromEntries([mark.draggable?.x?.parameter, mark.draggable?.y?.parameter]
    .filter((p): p is string => !!p).map(p => [p, controlFor(p)?.value ?? NaN]));
  const unavailable = runtime.busy || !!runtime.inert;
  const startDrag = (mark: PlannedMark, kind: GestureKind, pointerId: number | null, origin: Point | null): DragState | null => {
    const parameter = mark.draggable?.x?.parameter ?? mark.draggable?.y?.parameter;
    if (!parameter || unavailable) return null;
    const gesture = new PreviewGesture(runtime.binding, parameter, { onFailure: runtime.fail, isDisposed: runtime.disposed, operationId: runtime.opId, lane: runtime.lane });
    gesture.begin(kind);
    drag.current = { gesture, mark, pointerId, origin, start: committedValues(mark), moved: new Set() };
    return drag.current;
  };
  const finishDrag = (commit: boolean, reason: 'escape' | 'pointercancel' | 'blur' = 'pointercancel') => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    if (commit) void state.gesture.commit(committedValues(state.mark)); else state.gesture.cancel(reason);
  };
  useEffect(() => () => finishDrag(false, 'blur'), []);
  // A drag whose preview ended elsewhere, or whose card became inert, stays held and commits nothing on release.
  useEffect(() => { drag.current?.gesture.sync(runtime.binding.getProjection()); });

  const onHandleKey = (event: KeyboardEvent<SVGGElement>, mark: PlannedMark) => {
    if (mark.draggable && ARROW_KEYS.has(event.key)) {
      event.preventDefault();
      const state = drag.current ?? startDrag(mark, 'keyboard', null, null);
      if (!state || state.pointerId !== null) return;
      const axis = event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? 'x' : 'y';
      const ref = mark.draggable[axis];
      if (!ref) return;
      const sign = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1;
      const control = controlFor(ref.parameter);
      if (!control) return;
      const step = dragControlStep(control, view.axes?.[axis]?.unitLabel) || 0.1;
      const base = state.gesture.values?.[ref.parameter] ?? state.start[ref.parameter]!;
      state.moved.add(axis);
      // One step along one axis; an axis moved earlier in this gesture keeps its value, the other is not sent.
      state.gesture.update({ ...(state.gesture.values ?? {}), [ref.parameter]: snapToStep(base + sign * step, ref.min, ref.max, step) });
    } else if (mark.draggable && event.key === 'Escape' && drag.current) { event.preventDefault(); finishDrag(false, 'escape'); }
    else if (!mark.draggable && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); props.onSelect?.(props.selection === mark.markId ? null : mark.markId); }
  };
  const onHandleKeyUp = (event: KeyboardEvent<SVGGElement>) => { if (ARROW_KEYS.has(event.key) && drag.current?.pointerId === null) finishDrag(true); };

  const selectable = plan.marks.filter(mark => mark.interactive && mark.handle && !mark.draggable);
  const draggable = plan.marks.filter(mark => mark.interactive && mark.handle && mark.draggable && (mark.draggable.x || mark.draggable.y));
  const roving = useRoving(selectable.length);
  const cameraLabel = camera ? `zoom ${formatPlain(camera.zoom, runtime.locale)}×` : 'authored view';
  const { plot } = frame;
  const zeroX = frame.domain[0] < 0 && frame.domain[1] > 0 ? frame.toScreen(0, 0)[0] : null;
  const zeroY = frame.domain[2] < 0 && frame.domain[3] > 0 ? frame.toScreen(0, 0)[1] : null;
  const toolbar = useRoving(4, 'horizontal');
  const fitTarget = plan.extent ? fitCamera(baseBounds, plan.extent) : null;
  // Data outside the shown range: the current run's data marks (reference-role marks, grids and unbounded lines are
  // background), then each kept run's overlay.
  const outOfView: ClippedMark[] = [
    ...clippedData(view, plan),
    ...layout.kept.flatMap(({ overlay, clipped: items }) => items.length ? [{ markId: `kept-${overlay.ordinal}`, label: `kept run ${overlay.ordinal}`, count: items.reduce((sum, item) => sum + item.count, 0) }] : []),
  ];
  const clippedCount = outOfView.reduce((sum, item) => sum + item.count, 0);

  return (
    <figure className="eka-figure" aria-labelledby={props.titleId} data-eka-figure={view.viewId} data-tentative={props.tentative || undefined}>
      <div className="eka-figure-head">
        <div className="eka-heading">
          <Heading level={props.headingLevel} id={props.titleId} className="eka-figure-title">{props.heading ?? view.title}</Heading>
          {/* One line either way: during a preview it names the preview instead of the view range, so nothing moves. */}
          <span className="eka-subtitle" data-tentative={props.tentative || undefined}>{props.tentative ? 'Preview, not applied yet' : authored ? (camera ? `Moved view (${cameraLabel})` : 'Authored view') : 'View fitted to the data'}</span>
        </div>
        {props.headExtra}
        <div className="eka-toolbar" role="toolbar" aria-label={`View controls for ${view.title}`} onKeyDown={toolbar.onKeyDown}>
          <button type="button" className="eka-button" {...toolbar.itemProps(0)} aria-label="Zoom in" title="Zoom in" onClick={() => commitCamera(zoomCamera(baseBounds, camera, CAMERA_LIMITS.zoomStep))}><span aria-hidden="true">+</span></button>
          <button type="button" className="eka-button" {...toolbar.itemProps(1)} aria-label="Zoom out" title="Zoom out" onClick={() => commitCamera(zoomCamera(baseBounds, camera, 1 / CAMERA_LIMITS.zoomStep))}><span aria-hidden="true">−</span></button>
          <button type="button" className="eka-button" {...toolbar.itemProps(2)} aria-disabled={!fitTarget || undefined} onClick={() => { if (fitTarget) commitCamera(fitTarget); }}>Fit to data</button>
          <button type="button" className="eka-button" {...toolbar.itemProps(3)} aria-disabled={!committedCamera || undefined} onClick={() => { if (committedCamera) commitCamera(null); }}>Reset view</button>
        </div>
      </div>
      <div className="eka-figure-body" ref={bodyRef}>
        <svg
          ref={svgRef} className="eka-plot" viewBox={`0 0 ${width} ${layout.height}`} width={width} height={layout.height}
          role="group" aria-labelledby={props.titleId} aria-describedby={summaryId}
          data-eka-view-id={props.captureViewId ?? undefined} data-eka-surface-id={props.captureViewId ? runtime.surfaceId : undefined}
          data-eka-projection-id={props.captureViewId ? props.projectionId : undefined} data-eka-frame-id={props.captureViewId ? props.frameId ?? '' : undefined}
        >
          <title>{view.title}</title>
          <desc>{view.summary}</desc>
          <defs>
            <clipPath id={clipId}><rect x={plot.x} y={plot.y} width={plot.width} height={plot.height} /></clipPath>
            {/* Markers on the frame edge stay whole; lines are cut exactly at the frame. */}
            <clipPath id={markerClipId}><rect x={plot.x - 8} y={plot.y - 8} width={plot.width + 16} height={plot.height + 16} /></clipPath>
          </defs>
          <g className="eka-axes" aria-hidden="true">
            {layout.xTicks.ticks.map(tick => { const x = frame.toScreen(tick, 0)[0]; return <line key={`gx${tick}`} className="eka-grid-line" x1={x} x2={x} y1={plot.y} y2={plot.y + plot.height} />; })}
            {layout.yTicks.ticks.map(tick => { const y = frame.toScreen(0, tick)[1]; return <line key={`gy${tick}`} className="eka-grid-line" x1={plot.x} x2={plot.x + plot.width} y1={y} y2={y} />; })}
            {zeroX !== null ? <line className="eka-zero-line" x1={zeroX} x2={zeroX} y1={plot.y} y2={plot.y + plot.height} /> : null}
            {zeroY !== null ? <line className="eka-zero-line" x1={plot.x} x2={plot.x + plot.width} y1={zeroY} y2={zeroY} /> : null}
            <rect className="eka-axis-line" x={plot.x} y={plot.y} width={plot.width} height={plot.height} fill="none" />
            {layout.xTicks.ticks.map(tick => <text key={`tx${tick}`} className="eka-tick" x={frame.toScreen(tick, 0)[0]} y={plot.y + plot.height + layout.tickPx * 1.45} textAnchor="middle">{formatTick(tick, layout.xTicks.step, runtime.locale)}</text>)}
            {layout.yTicks.ticks.map(tick => <text key={`ty${tick}`} className="eka-tick" x={plot.x - 6} y={frame.toScreen(0, tick)[1]} dy="0.32em" textAnchor="end">{formatTick(tick, layout.yTicks.step, runtime.locale)}</text>)}
            {layout.yTitle.map((line, i) => <text key={`yt${i}`} className="eka-axis-title" x={4} y={(i + 1) * layout.metrics.lineHeight}>{line}</text>)}
            {layout.xTitle.map((line, i) => <text key={`xt${i}`} className="eka-axis-title" x={plot.x + plot.width} y={plot.y + plot.height + layout.tickPx * 1.9 + (i + 1) * layout.metrics.lineHeight} textAnchor="end">{line}</text>)}
          </g>
          <g className="eka-canvas" tabIndex={0} role="img" aria-roledescription="plot area"
            aria-label={`${view.title}: ${cameraLabel}. Arrow keys pan, plus and minus zoom, 0 resets the view.`} onKeyDown={onCanvasKey}
            onBlur={() => { if (timer.current && tentative) commitCamera(tentative); }}>
            <rect className="eka-plot-area eka-hit" data-panning={panning || undefined} x={plot.x} y={plot.y} width={plot.width} height={plot.height}
              onPointerDown={onAreaPointerDown} onPointerMove={onAreaPointerMove} onPointerUp={event => endPan(event, true)}
              onPointerCancel={event => endPan(event, false)} onLostPointerCapture={event => endPan(event, true)} />
            <rect className="eka-plot-focus" data-eka-capture="omit" x={plot.x + 1.5} y={plot.y + 1.5} width={Math.max(0, plot.width - 3)} height={Math.max(0, plot.height - 3)} />
          </g>
          {layout.kept.map(({ overlay, primitives }) => primitives.length ? (
            <g key={overlay.runId} className="eka-marks eka-comparison" aria-hidden="true" data-eka-comparison={overlay.runId} data-eka-comparison-frame-id={overlay.frameId ?? undefined}>
              <g clipPath={`url(#${clipId})`}>{primitives.filter(primitive => primitive.shape.type !== 'marker').map(primitive => <PrimitiveShape key={primitive.key} primitive={primitive} selected={false} />)}</g>
              <g clipPath={`url(#${markerClipId})`}>{primitives.filter(primitive => primitive.shape.type === 'marker').map(primitive => <PrimitiveShape key={primitive.key} primitive={primitive} selected={false} />)}</g>
            </g>
          ) : null)}
          <g className="eka-marks" clipPath={`url(#${clipId})`} aria-hidden="true">
            {plan.marks.flatMap(mark => mark.primitives.filter(primitive => primitive.shape.type !== 'marker').map(primitive => <PrimitiveShape key={primitive.key} primitive={primitive} selected={props.selection === mark.markId} />))}
          </g>
          <g className="eka-marks" clipPath={`url(#${markerClipId})`} aria-hidden="true">
            {plan.marks.flatMap(mark => mark.primitives.filter(primitive => primitive.shape.type === 'marker').map(primitive => <PrimitiveShape key={primitive.key} primitive={primitive} selected={props.selection === mark.markId} />))}
          </g>
          <g className="eka-labels" aria-hidden="true">
            {placed.labels.map(label => (
              <g key={label.id} data-eka-callout={label.callout}>
                {label.leader ? <line className="eka-leader" x1={label.leader.x1} y1={label.leader.y1} x2={label.leader.x2} y2={label.leader.y2} /> : null}
                {label.callout !== undefined ? <rect className="eka-callout-plate" x={label.box.x} y={label.box.y} width={label.box.width} height={label.box.height} rx={3} /> : null}
                <text className={label.callout !== undefined ? 'eka-label eka-callout' : 'eka-label'} x={label.x} y={label.y} textAnchor={label.textAnchor}>{label.lines.map((line, i) => <tspan key={i} x={label.x} dy={i ? layout.metrics.lineHeight : 0}>{line}</tspan>)}</text>
              </g>
            ))}
            {/* The label key: each callout's number and full text (an alternate representation; report §10.2, §10.3). */}
            {layout.key.entries.length ? (
              <g className="eka-label-key" data-eka-label-key="">
                {layout.key.entries.map(entry => {
                  const y = layout.keyTop + entry.y;
                  const plateWidth = Math.ceil(String(entry.number).length * layout.metrics.charWidth) + 8;
                  return (
                    <g key={entry.labelId} data-eka-callout={entry.number}>
                      <rect className="eka-callout-plate" x={4} y={y} width={plateWidth} height={layout.metrics.lineHeight} rx={3} />
                      <text className="eka-label eka-callout" x={4 + plateWidth / 2} y={y + layout.metrics.lineHeight * 0.8} textAnchor="middle">{entry.number}</text>
                      <text className="eka-legend-text" x={KEY_INDENT} y={y + layout.metrics.lineHeight * 0.8}>{entry.lines.map((line, i) => <tspan key={i} x={KEY_INDENT} dy={i ? layout.metrics.lineHeight : 0}>{line}</tspan>)}</text>
                    </g>
                  );
                })}
              </g>
            ) : null}
          </g>
          {selectable.length ? (
            <g role="listbox" aria-label={`Selectable items in ${view.title}`} onKeyDown={roving.onKeyDown}>
              {selectable.map((mark, index) => (
                <g key={mark.markId} className="eka-handle" role="option" aria-selected={props.selection === mark.markId} aria-label={mark.label}
                  data-eka-capture="omit" {...roving.itemProps(index)} onKeyDown={event => onHandleKey(event, mark)}
                  onClick={() => props.onSelect?.(props.selection === mark.markId ? null : mark.markId)}>
                  <circle className="eka-hit" cx={mark.handle![0]} cy={mark.handle![1]} r={12} />
                  <circle className="eka-focus-ring" cx={mark.handle![0]} cy={mark.handle![1]} r={9} />
                </g>
              ))}
            </g>
          ) : null}
          {draggable.map(mark => (
            <g key={mark.markId} className="eka-handle" data-draggable="true" tabIndex={0} role="button" aria-roledescription="movable point" data-eka-capture="omit"
              aria-label={`${mark.label}${mark.handleData ? ` at (${formatShown(mark.handleData[0], runtime.locale)}, ${formatShown(mark.handleData[1], runtime.locale)})` : ''}. ${runtime.inert ? `Unavailable: ${runtime.inert}` : 'Arrow keys move it one step; Escape cancels; the exact controls also set it.'}`}
              aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Escape" aria-disabled={unavailable || undefined}
              onKeyDown={event => onHandleKey(event, mark)} onKeyUp={onHandleKeyUp} onBlur={() => { if (drag.current) finishDrag(false, 'blur'); }}
              onPointerDown={event => {
                if (event.button !== 0) return;
                event.stopPropagation();
                if (unavailable || drag.current) return;
                // The pressed point takes focus, so Escape and the blur rule apply to pointer drags as well.
                event.currentTarget.focus({ preventScroll: true });
                event.currentTarget.setPointerCapture(event.pointerId);
                const [px, py] = svgPoint(event.clientX, event.clientY);
                startDrag(mark, 'drag', event.pointerId, frame.fromScreen(px, py));
              }}
              onPointerMove={event => {
                const state = drag.current;
                if (!state || state.pointerId !== event.pointerId) return;
                const [px, py] = svgPoint(event.clientX, event.clientY);
                const values = dragValues(state, frame.fromScreen(px, py));
                if (Object.keys(values).length) state.gesture.update(values);
              }}
              onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) finishDrag(true); }}
              onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finishDrag(false, 'pointercancel'); }}
              onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) finishDrag(false, 'pointercancel'); }}>
              <circle className="eka-hit" cx={mark.handle![0]} cy={mark.handle![1]} r={14} />
              <circle className="eka-focus-ring" cx={mark.handle![0]} cy={mark.handle![1]} r={10} />
            </g>
          ))}
          {layout.legend.entries.length ? (
            <g role="list" aria-label="Legend">
              {layout.legend.entries.map(entry => {
                const y = layout.legendTop + entry.y + layout.metrics.lineHeight * 0.6;
                return (
                  <g key={entry.markId} role="listitem">
                    <LegendSwatch entry={entry} y={y} />
                    <text className="eka-legend-text" x={entry.x + 36} y={y} dy="0.32em">{entry.lines.map((line, i) => <tspan key={i} x={entry.x + 36} dy={i ? layout.metrics.lineHeight : '0.32em'}>{line}</tspan>)}</text>
                  </g>
                );
              })}
            </g>
          ) : null}
        </svg>
      </div>
      <div className="eka-figure-foot">
        {props.reserveOutOfView ? (
          // One grid cell holds the line and an invisible copy with the longest text it can show (every data mark and
          // kept run of this view, the largest count), so its height never changes while the run plays.
          <div className="eka-clip-slot" data-eka-clip-slot="">
            <OutOfView labels={outOfViewCandidates(view, layout.kept.map(item => item.overlay))} count={OUT_OF_VIEW_COUNT_BOUND} fit={false} sizer />
            {outOfView.length
              ? <OutOfView labels={outOfView.map(item => item.label)} count={clippedCount} fit={!!fitTarget} onInspect={runtime.inspectValues} onFit={() => { if (fitTarget) commitCamera(fitTarget); }} />
              : <p className="eka-clip-none"><span className="eka-glyph" aria-hidden="true">✓</span> All drawn values are inside the view.</p>}
          </div>
        ) : outOfView.length ? (
          <OutOfView labels={outOfView.map(item => item.label)} count={clippedCount} fit={!!fitTarget} onInspect={runtime.inspectValues} onFit={() => { if (fitTarget) commitCamera(fitTarget); }} />
        ) : null}
        {plan.notes.length ? <ul className="eka-notes" aria-label={`Notes for ${view.title}`}>{plan.notes.map((note, i) => <li key={`${note.markId}:${i}`}>{note.text}</li>)}</ul> : null}
        <p id={summaryId} className={props.showSummary ? 'eka-description' : 'eka-sr'}>{view.summary}</p>
      </div>
    </figure>
  );
}


/** Count shown by the out-of-view line's invisible sizer: wider than any count a bounded frame can produce. */
const OUT_OF_VIEW_COUNT_BOUND = 99_999;
/** Labels the out-of-view line can name for a view: every mark that is not reference or background, then each kept run. */
function outOfViewCandidates(view: ProjectedView, overlays: readonly Scene2DOverlay[]): string[] {
  const marks = view.marks.filter(mark => mark.style.role !== 'reference' && mark.kind !== 'grid' && mark.kind !== 'label').map(mark => mark.label);
  return [...marks, ...overlays.map(overlay => `kept run ${overlay.ordinal}`)];
}

const OUT_OF_VIEW_HEAD = 'Some values are outside the view';
/**
 * The out-of-view indicator (report §10.2): what leaves the view and how many coordinates, that the view is not
 * rescaled, Inspect values and Fit to data. As a `sizer` it is an invisible, inert copy that only reserves its height:
 * its words are CSS-generated content (`data-eka-sizer-text`), never text nodes, so no learner channel — DOM text, the
 * accessibility tree, selection and copy, a read-out — carries an out-of-view state the card does not show.
 */
function OutOfView({ labels, count, fit, onInspect, onFit, sizer }: { labels: readonly string[]; count: number; fit: boolean; onInspect?: () => void; onFit?: () => void; sizer?: boolean }) {
  const runtime = useRuntime();
  const detail = `(${labels.join('; ')}; ${formatPlain(count, runtime.locale) || String(count)} ${count === 1 ? 'point' : 'points'}). The view is not rescaled automatically.`;
  if (sizer) return (
    <div className="eka-clip-sizer" aria-hidden="true" inert data-eka-clip-sizer="">
      <span className="eka-glyph" data-eka-sizer-text="⇱" />
      <span className="eka-clip-text"><strong data-eka-sizer-text={OUT_OF_VIEW_HEAD} /><span data-eka-sizer-text={` ${detail}`} /></span>
      <button type="button" className="eka-button" tabIndex={-1} data-eka-sizer-text="Inspect values" />
      <button type="button" className="eka-button" tabIndex={-1} data-eka-sizer-text="Fit to data" />
    </div>
  );
  return (
    <div className="eka-clip" role="group" aria-label="Values outside the view">
      <span className="eka-glyph" aria-hidden="true">⇱</span>
      <span className="eka-clip-text">
        <strong>{OUT_OF_VIEW_HEAD}</strong> {detail}
      </span>
      <button type="button" className="eka-button" onClick={onInspect}>Inspect values</button>
      <button type="button" className="eka-button" aria-disabled={!fit || undefined} onClick={() => { if (fit) onFit?.(); }}>Fit to data</button>
    </div>
  );
}
