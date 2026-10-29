/**
 * `scene3d` views (report §11, §13, A44). The spatial renderer is loaded only through the host's `spatialLoader`, and
 * only once the view is on screen; without a loader, when loading fails, or when WebGL is unavailable, the view renders
 * its tested 2D alternative — a coordinate-plane projection (equal aspect, x–y / x–z / y–z) plus the full 3D coordinate
 * table — and says why. The projection is also available while the renderer runs (and is what a capture of the view
 * uses); it is shown automatically while the renderer reports a lost or unrecoverable graphics context.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SPATIAL_3D_CAPABILITY, type Camera3D, type LearnerProjection, type ProjectedControl, type ProjectedView } from '@experiment-kit/activity';
import { formatShown } from '../format.js';
import { coordinateTable, projectView, PROJECTION_PLANES, spatialEquivalence, type CoordinateRow, type CoordinateTable as CoordinateTableData, type ProjectionPlane } from '../project3d.js';
import type { SpatialPresentation, SpatialRendererInstance, SpatialRendererModule, SpatialStatus } from '../spatial-contract.js';
import { Heading, useRoving, useRuntime, useStableId } from './context.js';
import { Scene2D } from './Scene2D.js';

const modules = new WeakMap<() => Promise<SpatialRendererModule>, Promise<SpatialRendererModule>>();
const loadSpatial = (loader: () => Promise<SpatialRendererModule>) => {
  let pending = modules.get(loader);
  if (!pending) { pending = loader(); pending.catch(() => modules.delete(loader)); modules.set(loader, pending); }
  return pending;
};

const PLANE_LABEL: Record<ProjectionPlane, string> = { xy: 'x–y', xz: 'x–z', yz: 'y–z' };
const UNAVAILABLE = new Set<SpatialStatus>(['context-lost', 'failed']);

/** True once the element has been on screen (immediately where IntersectionObserver is unavailable). */
function useSeen(ref: { current: Element | null }): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver !== 'function');
  useEffect(() => {
    const element = ref.current;
    if (seen || !element || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setSeen(true); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen, ref]);
  return seen;
}

export function SpatialView({ view, projection, controls, showSummary, headingLevel }: { view: ProjectedView; projection: LearnerProjection; controls: readonly ProjectedControl[]; showSummary: boolean; headingLevel: number }) {
  const runtime = useRuntime();
  const titleId = useStableId('eka-view');
  const projectionTitleId = useStableId('eka-projection');
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const instance = useRef<SpatialRendererInstance | null>(null);
  const [module, setModule] = useState<SpatialRendererModule | null>(null);
  const [fallback, setFallback] = useState<string | null>(runtime.spatialLoader ? null : 'No 3D renderer is configured here.');
  const [status, setStatus] = useState<{ status: SpatialStatus; message: string | null }>({ status: 'ready', message: null });
  const [plane, setPlane] = useState<ProjectionPlane>('xy');
  const [showProjection, setShowProjection] = useState(false);
  const roving = useRoving(PROJECTION_PLANES.length, 'horizontal');
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  /** Current wording of the 2D alternative, read by the renderer whenever it shows a lost or failed context. */
  const equivalenceRef = useRef('');
  const seen = useSeen(rootRef);

  const table = useMemo(() => coordinateTable(view, runtime.locale), [view, runtime.locale]);
  // What the fallback carries, said exactly (report §11): everything the 3D view draws, or the positioned items with the
  // rest summarised; the activity's own tables are named when there are any. The renderer's lost/failed states use it too.
  const equivalence = spatialEquivalence(table, projection.views.filter(item => item.kind === 'table' && item.table).map(item => item.title));
  equivalenceRef.current = equivalence;

  const viewPresentation = projection.presentation.views[view.viewId];
  const presentation: SpatialPresentation = useMemo(() => ({
    camera: viewPresentation?.camera?.kind === '3d' ? viewPresentation.camera : null, selection: projection.presentation.selection, layers: viewPresentation?.layers ?? [],
  }), [viewPresentation, projection.presentation.selection]);

  useEffect(() => {
    const loader = runtime.spatialLoader;
    if (!loader || !seen) return;
    let cancelled = false;
    loadSpatial(loader).then(loaded => {
      if (cancelled) return;
      if (!loaded.webglAvailable()) { setFallback('3D graphics (WebGL) are not available here.'); runtimeRef.current.report({ source: 'surface', code: 'SPATIAL_FALLBACK', message: 'WebGL is unavailable; showing the 2D projection and coordinate table.', path: `views.${view.viewId}` }); return; }
      setModule(() => loaded);
    }).catch(error => {
      if (cancelled) return;
      setFallback('The 3D view could not be loaded.');
      runtimeRef.current.report({ source: 'surface', code: 'SPATIAL_FALLBACK', message: `The spatial renderer failed to load (${error instanceof Error ? error.message : 'unknown error'}); showing the 2D projection and coordinate table.`, path: `views.${view.viewId}` });
    });
    return () => { cancelled = true; };
  }, [runtime.spatialLoader, view.viewId, seen]);

  // Mount once the container is in the DOM; later projections and presentation reach the renderer through `update`.
  // Dispose on unmount or when the view identity, renderer module or motion preference changes.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!module || fallback || !element) return;
    try {
      instance.current = module.mount(element, {
        view, presentation,
        onCamera: (camera: Camera3D) => { const current = runtimeRef.current; if (!current.disposed()) void current.run(() => current.binding.setCamera({ operationId: current.opId(), expectedPresentationRevision: current.binding.getProjection().presentationRevision, viewId: view.viewId, camera }), 'presentation'); },
        onSelect: target => { const current = runtimeRef.current; if (!current.disposed()) void current.run(() => current.binding.select({ operationId: current.opId(), expectedPresentationRevision: current.binding.getProjection().presentationRevision, target }), 'presentation'); },
        onStatus: (next, message) => {
          if (runtimeRef.current.disposed()) return;
          setStatus({ status: next, message });
          if (UNAVAILABLE.has(next)) runtimeRef.current.report({ source: 'surface', code: 'SPATIAL_FALLBACK', message: `The 3D view reported ${next}${message ? ` (${message})` : ''}; showing the 2D projection and coordinate table.`, path: `views.${view.viewId}` });
        },
        reducedMotion: runtime.reducedMotion,
        describeAlternative: () => equivalenceRef.current,
        // The renderer enforces the spatial-3d@1.0 capability record's limits (G52), never its own assumptions.
        limits: SPATIAL_3D_CAPABILITY.limits,
      });
    } catch (error) {
      instance.current = null;
      setFallback('The 3D view could not start.');
      runtime.report({ source: 'surface', code: 'SPATIAL_FALLBACK', message: `The spatial renderer failed to mount (${error instanceof Error ? error.message : 'unknown error'}).`, path: `views.${view.viewId}` });
    }
    return () => { instance.current?.dispose(); instance.current = null; setStatus({ status: 'ready', message: null }); };
  }, [module, fallback, view.viewId, runtime.reducedMotion]);
  useEffect(() => { instance.current?.update(view, presentation); }, [view, presentation, equivalence]);

  const active = !!module && !fallback;
  const unavailable = active && UNAVAILABLE.has(status.status);
  const projected = useMemo(() => projectView(view, plane), [view, plane]);
  const planeSelector = (
    <div className="eka-segmented" role="toolbar" aria-label="Projection plane" onKeyDown={roving.onKeyDown}>
      {PROJECTION_PLANES.map((candidate, index) => (
        <button key={candidate} type="button" className="eka-button" aria-pressed={plane === candidate} {...roving.itemProps(index)} onClick={() => setPlane(candidate)}>{PLANE_LABEL[candidate]}</button>
      ))}
    </div>
  );
  const showFallback = !active || showProjection || unavailable;
  return (
    <div className="eka-main" data-eka-spatial={view.viewId} data-eka-spatial-state={active ? status.status : 'fallback'} ref={rootRef}>
      {active ? (
        <figure className="eka-figure" aria-labelledby={titleId} data-eka-frame-id={projection.frame?.frameId ?? undefined} data-tentative={projection.frame?.kind === 'tentative' || undefined}>
          <div className="eka-figure-head">
            <Heading level={headingLevel} id={titleId} className="eka-figure-title">{view.title}</Heading>
            <button type="button" className="eka-button" aria-pressed={showFallback} aria-disabled={unavailable || undefined}
              onClick={() => { if (!unavailable) setShowProjection(value => !value); }}>2D projection and table</button>
          </div>
          <div className="eka-figure-body"><div className="eka-spatial" ref={containerRef} /></div>
          <div className="eka-figure-foot">
            {unavailable ? <p className="eka-description">The 3D view is unavailable right now. {equivalence}</p> : null}
            <p className={showSummary ? 'eka-description' : 'eka-sr'}>{view.summary}</p>
          </div>
        </figure>
      ) : (
        <div className="eka-pending" data-state="spatial-fallback">
          <span className="eka-glyph" aria-hidden="true">i</span>
          <p>{fallback ?? (seen ? 'Loading the 3D view…' : 'The 3D view loads when it is on screen.')} {equivalence}</p>
        </div>
      )}
      {showFallback ? (
        <>
          <Scene2D
            view={projected} captureViewId={view.viewId} projectionId={projection.projectionId} frameId={projection.frame?.frameId ?? null}
            titleId={projectionTitleId} heading={`${view.title}: ${PLANE_LABEL[plane]} projection`} headExtra={planeSelector} headingLevel={headingLevel}
            camera={null} selection={projection.presentation.selection} controls={controls} showSummary={showSummary} tentative={projection.frame?.kind === 'tentative'}
          />
          <CoordinateTable table={table} title={`${view.title}: coordinates`} headingLevel={headingLevel + 1} />
        </>
      ) : null}
    </div>
  );
}

function CoordinateTable({ table, title, headingLevel }: { table: CoordinateTableData; title: string; headingLevel: number }) {
  const headingId = useStableId('eka-coordinates');
  const rows: CoordinateRow[] = table.rows;
  if (!rows.length) return null;
  return (
    <section className="eka-panel" aria-labelledby={headingId}>
      <Heading level={headingLevel} id={headingId} className="eka-panel-title">{title}</Heading>
      <div className="eka-table-region" role="region" aria-labelledby={headingId} tabIndex={0}>
        <table className="eka-table">
          <thead><tr><th scope="col">Item</th><th scope="col">Coordinates (x, y, z)</th><th scope="col">Value</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.key}><th scope="row">{row.label}</th>{row.cells.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {table.notes.length ? <ul className="eka-notes" aria-label={`What ${title} does not list in full`} data-eka-coordinate-notes="">{table.notes.map(note => <li key={note}>{note}</li>)}</ul> : null}
    </section>
  );
}
