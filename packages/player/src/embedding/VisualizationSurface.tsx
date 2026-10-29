import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import type { MutationGuard, ParameterSpec, SessionState, ViewSpec, VisualizationSession } from '@explorable-models/core/declarative';
import { Scene } from './Scene.js';
import { formatNumber, formatValue } from './format.js';
import { registerSurface } from './export.js';
import { adoptSurfaceStyles } from './stylesheet.js';

export interface VisualizationSurfaceProps {
  session: VisualizationSession;
  controls?: boolean;
  theme?: 'light' | 'dark';
  locale?: string;
  /** Match the surrounding host heading hierarchy; defaults to h2. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  className?: string;
  /** Hosts can surface errors in their own notification system. */
  onError?: (error: Error) => void;
  /**
   * Base URL of the packaged `surface.css`, linked only where constructable stylesheets are unavailable (the styles are
   * otherwise adopted as a constructable stylesheet: no inline style element, so no `style-src 'unsafe-inline'`).
   */
  assetBase?: string | URL;
}

function guard(session: VisualizationSession): MutationGuard {
  const state = session.getState();
  return { sessionId: state.sessionId, expectedVersion: state.version, expectedRunId: state.run?.id, operationId: crypto.randomUUID(), origin: 'human' };
}

interface ParameterControlProps {
  id: string; spec: ParameterSpec; value: number; previewValue?: number; precision: number; locale: string;
  onPreview(params: Record<string, number>): void; onCommit(params: Record<string, number>): void; onCancel(): void;
}
function ParameterControl({ id, spec, value, previewValue, precision, locale, onPreview, onCommit, onCancel }: ParameterControlProps) {
  const uid = useId();
  const [exact, setExact] = useState(String(value));
  const [inputError, setInputError] = useState('');
  const tentative = useRef<number | null>(null);
  useEffect(() => { setExact(String(value)); setInputError(''); }, [value]);
  const commitRange = () => { if (tentative.current === null) return; const n = tentative.current; tentative.current = null; onCommit({ [id]: n }); };
  const cancel = () => { tentative.current = null; setExact(String(value)); onCancel(); };
  return <div className="em-control">
    <label htmlFor={`${uid}-range`}>{spec.label}{spec.unit ? ` (${spec.unit})` : ''}</label>
    <input id={`${uid}-range`} aria-describedby={`${uid}-range-hint`} type="range" min={spec.min} max={spec.max} step={spec.integer ? Math.max(1, spec.step ?? 1) : spec.step ?? 'any'} value={previewValue ?? value}
      onChange={event => { const n = Number(event.currentTarget.value); tentative.current = n; onPreview({ [id]: n }); }}
      onPointerUp={commitRange} onPointerCancel={cancel} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitRange(); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } }} onBlur={commitRange} />
    <form className="em-exact" onSubmit={event => { event.preventDefault(); const n = Number(exact); if (!exact.trim() || !Number.isFinite(n) || n < spec.min || n > spec.max || spec.integer && !Number.isInteger(n)) { setInputError(`Enter ${spec.integer ? 'an integer' : 'a finite value'} from ${spec.min} to ${spec.max}.`); return; } setInputError(''); tentative.current = null; onCommit({ [id]: n }); }}>
      <input type="text" inputMode="decimal" aria-label={`${spec.label} exact value`} aria-invalid={Boolean(inputError)} aria-describedby={inputError ? `${uid}-error` : `${uid}-range-hint`} value={exact} onChange={event => setExact(event.currentTarget.value)} />
      <button type="submit" aria-label={`Apply ${spec.label}`}>Apply</button>
    </form>
    <div id={`${uid}-range-hint`} className="em-hint">{formatNumber(spec.min, precision, locale)} to {formatNumber(spec.max, precision, locale)}{previewValue !== undefined ? ` · Preview ${formatNumber(previewValue, precision, locale)}` : ''}</div>
    {inputError ? <p className="em-status" id={`${uid}-error`} role="alert">{inputError}</p> : null}
  </div>;
}

function Readout({ view, state, precision, locale }: { view: ViewSpec; state: SessionState; precision: number; locale: string }) {
  const frame = state.frame!, doc = state.document!;
  if (view.type === 'equation') return <div className="em-equation" data-frame-time={frame.time}>{view.equation?.replace(/\{\{([^}]+)\}\}/g, (_, id: string) => formatValue(frame.quantities[id.trim()], precision, locale))}</div>;
  if (view.type === 'table' && view.dataset) {
    const dataset = frame.datasets[view.dataset];
    if (!dataset) return <p className="em-undefined">Undefined: dataset is unavailable.</p>;
    return <div className="em-table-wrap"><table><caption className="em-sr">{view.title}. {dataset.description}</caption><thead><tr>{dataset.columns.map(column => <th key={column.id} scope="col">{column.label}{column.unit ? ` (${column.unit})` : ''}</th>)}</tr></thead><tbody>{dataset.rows.map((row, i) => <tr key={i}>{row.map((n, j) => <td key={j}>{n === null ? 'Undefined: missing datum' : formatNumber(n, precision, locale)}</td>)}</tr>)}</tbody></table></div>;
  }
  if (view.type === 'table') return <div className="em-table-wrap"><table><caption className="em-sr">{view.title}</caption><thead><tr><th scope="col">Quantity</th><th scope="col">Committed value</th><th scope="col">Unit</th></tr></thead><tbody>{(view.quantities ?? []).map(id => <tr key={id} data-quantity-id={id} data-frame-time={frame.time}><th scope="row">{doc.quantities[id]?.label ?? id}</th><td>{formatValue(frame.quantities[id], precision, locale)}</td><td>{doc.quantities[id]?.unit ?? '—'}</td></tr>)}</tbody></table></div>;
  return <dl className="em-values">{(view.quantities ?? []).map(id => <div key={id} style={{ display: 'contents' }}><dt>{doc.quantities[id]?.label ?? id}</dt><dd data-quantity-id={id} data-frame-time={frame.time} data-value={JSON.stringify(frame.quantities[id]?.value)}>{formatValue(frame.quantities[id], precision, locale)}{frame.quantities[id]?.status === 'valid' && doc.quantities[id]?.unit ? ` ${doc.quantities[id].unit}` : ''}</dd></div>)}</dl>;
}

/** Embeddable presentation only: the host owns session lifetime, persistence and navigation. */
export function VisualizationSurface({ session, controls, theme = 'light', locale, headingLevel = 2, className, onError, assetBase }: VisualizationSurfaceProps) {
  const subscribe = useCallback((notify: () => void) => session.subscribe(() => notify()), [session]);
  const getState = useCallback(() => session.getState(), [session]);
  const state = useSyncExternalStore(subscribe, getState, getState);
  const root = useRef<HTMLDivElement>(null);
  const uid = useId();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useLayoutEffect(() => root.current ? registerSurface(session, root.current) : undefined, [session]);
  // The stylesheet is adopted into the surface's document or shadow root before the first paint (CSP: style-src 'self').
  const assetHref = assetBase === undefined ? undefined : String(assetBase);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return undefined;
    const adopted = adoptSurfaceStyles(node.getRootNode(), assetHref);
    if (!adopted.ok) onErrorRef.current?.(new Error('This browser cannot apply the visualization stylesheet; pass assetBase so surface.css can be linked.'));
    return adopted.release;
  }, [assetHref]);
  const runAction = useCallback((operation: () => unknown) => {
    setError(null);
    try {
      Promise.resolve(operation()).catch(reason => { const e = reason instanceof Error ? reason : new Error(String(reason)); setError(e.message); onError?.(e); });
    } catch (reason) { const e = reason instanceof Error ? reason : new Error(String(reason)); setError(e.message); onError?.(e); }
  }, [onError]);
  const preview = (params: Record<string, number>) => runAction(() => session.previewParameters(params, guard(session)));
  const commit = (params: Record<string, number>) => runAction(() => session.setParameters(params, guard(session)));
  const cancel = () => runAction(() => session.cancelPreview(guard(session)));
  const select = (id: string) => runAction(() => session.select(id, guard(session)));
  const doc = state.document, frame = state.frame;
  const showControls = controls ?? doc?.presentation?.controls ?? true;
  const digits = doc?.presentation?.precision ?? 6;
  const chosenLocale = locale ?? doc?.presentation?.locale ?? 'en-US';
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  const Subheading = `h${Math.min(6, headingLevel + 1)}` as 'h3' | 'h4' | 'h5' | 'h6';
  return <div ref={root} data-em-surface="" data-theme={theme} data-session-id={state.sessionId} className={className} style={{ '--em-columns': doc?.presentation?.columns ?? 1 } as CSSProperties}>
    <div className="em-sr" id={`${uid}-description`}>{doc?.description ?? 'Visualization surface'}</div>
    {error ? <p className="em-status" role="alert">{error}</p> : null}
    {state.error?.length ? <div className="em-status" role="status">{state.error.map(item => <p key={`${item.path}-${item.code}`}>{item.message}{item.recovery ? ` ${item.recovery}` : ''}</p>)}</div> : null}
    {state.status === 'disposed' ? <p className="em-status">This visualization session has been disposed. Create a new session to continue.</p> : !doc || !frame || !state.run ? <p className="em-status">No visualization has been committed. Create and commit a document to show it here.</p> : <>
      {showControls && Object.keys(doc.parameters).length ? <div className="em-controls" role="group" aria-label="Visualization parameters">{Object.entries(doc.parameters).map(([id, spec]) => <ParameterControl key={id} id={id} spec={spec} value={state.run!.params[id]} previewValue={state.preview?.[id]} precision={digits} locale={chosenLocale} onPreview={preview} onCommit={commit} onCancel={cancel} />)}</div> : null}
      {showControls && doc.time ? <div className="em-controls" role="group" aria-label="Playback controls">
        <button type="button" disabled={Boolean(state.preview) || frame.terminal && !state.playing} onClick={() => runAction(() => state.playing ? session.pause(guard(session)) : session.play(guard(session)))}>{state.playing ? 'Pause' : 'Play'}</button>
        <button type="button" disabled={Boolean(state.preview)} onClick={() => runAction(() => session.seek(0, guard(session)))}>Restart</button>
        <button type="button" disabled={Boolean(state.preview) || state.playing || frame.terminal} onClick={() => runAction(() => session.seek(Math.min(frame.endTime ?? Infinity, frame.time + (doc.time?.step ?? .1)), guard(session)))}>Step</button>
        <label className="em-control">Time: {formatNumber(frame.time, digits, chosenLocale)}{frame.terminal ? ' · exact endpoint' : ''}<input type="range" min="0" max={frame.endTime ?? Math.max(10, frame.time * 2)} step="any" aria-label="Seek time" value={frame.time} disabled={Boolean(state.preview) || state.playing} onChange={event => runAction(() => session.seek(Number(event.currentTarget.value), guard(session)))} /></label>
        <form className="em-exact" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); runAction(() => session.seek(Number(data.get('time')), guard(session))); }}><input aria-label="Exact time" name="time" type="number" step="any" min="0" max={frame.endTime ?? undefined} defaultValue={frame.time} required disabled={Boolean(state.preview) || state.playing} /><button disabled={Boolean(state.preview) || state.playing}>Seek</button></form>
      </div> : null}
      <div className="em-grid" aria-describedby={`${uid}-description`}>{doc.views.map(view => <section key={view.id} className="em-view" aria-label={view.title}>
        <div className="em-view-heading"><Heading>{view.title}</Heading>{view.description ? <p>{view.description}</p> : null}</div>
        {view.type === 'scene' || view.type === 'plot' ? <Scene key={`${doc.id}-${view.id}`} view={view} state={state} actions={{ select, preview, commit, cancel }} precision={digits} locale={chosenLocale} /> : <Readout view={view} state={state} precision={digits} locale={chosenLocale} />}
      </section>)}</div>
      {state.preview ? <div className="em-status" role="status">Parameter preview is tentative. The views still show the committed frame. <button type="button" onClick={() => commit(state.preview!)}>Commit preview</button> <button type="button" onClick={cancel}>Cancel preview</button></div> : null}
      {state.selection ? <div className="em-selection" role="status">Selected object: {state.selection}. <button type="button" onClick={() => runAction(() => session.select(null, guard(session)))}>Clear selection</button></div> : null}
      <details><summary>Model, values and source document</summary>
        <p>{doc.description}</p><p className="em-hint">Review: {doc.provenance?.review ?? 'unreviewed'}. Checks: {doc.provenance?.checks ?? 'none'}. Automated checks do not constitute independent scientific review.</p>
        {doc.assumptions.length ? <><Subheading>Assumptions</Subheading><ul>{doc.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul></> : null}
        {doc.limitations.length ? <><Subheading>Limitations</Subheading><ul>{doc.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul></> : null}
        <Readout view={{ id: 'all-values', type: 'table', title: 'All committed quantities', quantities: Object.keys(doc.quantities) }} state={state} precision={digits} locale={chosenLocale} />
        <p className="em-hint">Run {state.run.id} · time {formatNumber(frame.time, digits, chosenLocale)} · revision {state.identity?.documentRevision}</p>
        <details><summary>Source document (JSON)</summary><button type="button" onClick={() => runAction(async () => { if (!navigator.clipboard) throw new Error('Clipboard access is unavailable. Select and copy the JSON below.'); await navigator.clipboard.writeText(JSON.stringify(doc, null, 2)); setCopied(true); })}>Copy source document</button>{copied ? <span className="em-hint" role="status"> Document JSON copied.</span> : null}<pre tabIndex={0}>{JSON.stringify(doc, null, 2)}</pre></details>
      </details>
    </>}
  </div>;
}
