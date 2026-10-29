/**
 * Card panels: status banner, persistence indicator, pending reveal, values, equations, tables, comparisons and
 * alternatives. Everything is rendered from the projection as escaped text; nothing is formatted from raw model data.
 * Panels that show frame values carry `data-eka-frame-id` of the identified frame they were rendered from, like the
 * drawings, so every representation of one projection can be checked for coherence.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LearnerProjection, ProjectedAlternative, ProjectedComparison, ProjectedEquation, ProjectedTable, ProjectedValue } from '@experiment-kit/activity';
import type { FramePosition } from '@experiment-kit/core/model';
import { unitLabel } from '@experiment-kit/core/model';
import { formatPlain, numeralMinus, valueDisplay } from '../format.js';
import { COMPARISON_DASH, comparisonGlyph, GLYPH_NAME, markerPath } from '../plan.js';
import { renderMathInto } from '../math.js';
import { chipPersistence, PENDING_REVEAL_TEXT, PERSISTENCE_TEXT, presentStatus, type RecoveryAction, type StatusCause, type StatusPresentation } from '../status.js';
import { Heading, useRuntime, useStableId, type LayoutAnchor } from './context.js';

/** Runs one recovery action of the presented status. */
function useRecovery(projection: LearnerProjection, onRecoveryAction?: (action: 'return' | 'reload') => void) {
  const runtime = useRuntime();
  const { binding } = runtime;
  const previewId = projection.preview?.previewId ?? null;
  return {
    available: (action: RecoveryAction) => (action === 'commit' || action === 'cancel') ? !!previewId : (action === 'return' || action === 'reload') ? !!onRecoveryAction : true,
    act(action: RecoveryAction) {
      switch (action) {
        case 'retry': void runtime.run(() => binding.retryPersistence({ operationId: runtime.opId() }), 'other'); break;
        case 'commit': if (previewId) void runtime.run(() => binding.commitPreview({ operationId: runtime.opId(), ...binding.getProjection().guards, previewId }), 'science'); break;
        case 'cancel': if (previewId) void runtime.run(() => binding.cancelPreview({ operationId: runtime.opId(), previewId, reason: 'escape' }), 'other'); break;
        case 'return': case 'reload': onRecoveryAction?.(action); break;
      }
    },
  };
}
const actionLabel = (status: StatusPresentation, action: RecoveryAction): string =>
  ({ retry: status.recoveryLabel ?? 'Try again', commit: 'Apply', cancel: 'Cancel', return: status.recoveryLabel ?? 'Return', reload: status.recoveryLabel ?? 'Reload' })[action];

/**
 * The card's status banner for states that need attention or action (see `status.ts`): one title, the message, at most one
 * recovery control, a tone by cause. Transient states are not banners (see {@link InlineStatus}).
 */
export function StatusBanner({ projection, onRecoveryAction }: { projection: LearnerProjection; onRecoveryAction?: (action: 'return' | 'reload') => void }) {
  const status = presentStatus(projection);
  const recovery = useRecovery(projection, onRecoveryAction);
  if (!status || status.placement !== 'banner') return null;
  const actions = status.actions.filter(recovery.available);
  return (
    <div className="eka-banner" data-tone={status.tone} data-ui-state={status.state} data-cause={status.cause}>
      <span className="eka-glyph" aria-hidden="true">{status.glyph}</span>
      <div className="eka-banner-body">
        <p className="eka-banner-title">{status.title}</p>
        {status.message ? <p>{status.message}</p> : null}
        {/* A return/reload the host does not handle is described, not offered as a control that does nothing. */}
        {!actions.length && status.actions.length && status.recoveryLabel ? <p className="eka-panel-note">{status.recoveryLabel}.</p> : null}
      </div>
      {actions.length ? (
        <div className="eka-banner-actions">
          {actions.map(action => <button key={action} type="button" className={`eka-button${action === 'commit' || action === 'retry' ? ' eka-button-primary' : ''}`} onClick={() => recovery.act(action)}>{actionLabel(status, action)}</button>)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Transient states shown in place, below the controls in use (a tentative preview with Apply and Cancel, a routine
 * notice): appearing or disappearing never moves a focused or dragged control.
 */
export function InlineStatus({ projection, causes }: { projection: LearnerProjection; causes?: ReadonlySet<StatusCause> }) {
  const status = presentStatus(projection);
  const recovery = useRecovery(projection);
  if (!status || status.placement !== 'inline' || status.cause === 'clipped' || (!status.message && status.cause !== 'preview')) return null;
  if (causes && !causes.has(status.cause)) return null;
  const actions = status.actions.filter(recovery.available);
  return (
    <div className="eka-inline-status" data-tone={status.tone} data-ui-state={status.state} data-cause={status.cause}>
      <span className="eka-glyph" aria-hidden="true">{status.glyph}</span>
      <p className="eka-inline-text">{status.cause === 'preview' ? <strong>{status.title}. </strong> : null}{status.message}</p>
      {actions.length ? (
        <span className="eka-inline-actions">
          {actions.map(action => <button key={action} type="button" className="eka-button eka-button-quiet" onClick={() => recovery.act(action)}>{actionLabel(status, action)}</button>)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Persistence chip: agrees with the banner (a reveal being recorded reads “Saving…”, one the host did not record “Not
 * saved yet”), keeps one width for every label so the header never reflows when it changes, and offers “Retry saving”
 * only when no banner offers a retry already.
 */
export function PersistenceChip({ projection }: { projection: LearnerProjection }) {
  const runtime = useRuntime();
  const persistence = chipPersistence(projection);
  const text = PERSISTENCE_TEXT[persistence];
  const status = presentStatus(projection);
  const retryOffered = status?.placement === 'banner' && status.actions.includes('retry');
  return (
    <span className="eka-meta">
      <span className="eka-chip" data-tone={text.tone} data-persistence={persistence} title={text.detail}>
        <span className="eka-glyph" aria-hidden="true">{text.glyph}</span>
        {/* The label sits in a grid cell that also reserves the widest label (a CSS pseudo-element, not text), so the chip keeps one width. */}
        <span className="eka-chip-labels"><span className="eka-chip-label">{text.label}</span></span>
        <span className="eka-sr">. {text.detail}</span>
      </span>
      {(persistence === 'pending-recovery' || persistence === 'failed') && !retryOffered && projection.status.ui !== 'disposed'
        ? <button type="button" className="eka-button eka-button-quiet" onClick={() => void runtime.run(() => runtime.binding.retryPersistence({ operationId: runtime.opId() }), 'other')}>Retry saving</button> : null}
    </span>
  );
}

/**
 * A pending reveal while another state dominates the banner (for example a host pause): what is waiting, without a
 * control of its own. While the card awaits persistence, the banner names the pending content and offers the retry.
 */
export function PendingReveal({ projection }: { projection: LearnerProjection }) {
  const pending = projection.pendingReveal;
  if (!pending || pending.state === 'awaiting-display' || projection.status.ui === 'awaiting-persistence') return null;
  return (
    <div className="eka-pending" data-state={pending.state}>
      <span className="eka-glyph" aria-hidden="true">{pending.state === 'failed' ? '!' : '…'}</span>
      <p>{PENDING_REVEAL_TEXT[pending.state]}{pending.labels.length ? `: ${pending.labels.join(', ')}` : ''}.</p>
    </div>
  );
}

/** Presentation-only unit choice for a quantity with declared display units (report §8.3); no new run. */
function UnitSelect({ value }: { value: ProjectedValue }) {
  const runtime = useRuntime();
  const { binding } = runtime;
  if (!value.displayUnits || value.displayUnits.length < 2) return null;
  return (
    <select className="eka-select eka-select-compact" aria-label={`Unit for ${value.label}`} value={value.unit} aria-disabled={runtime.busy || undefined}
      onChange={event => {
        const unit = event.currentTarget.value as ProjectedValue['unit'];
        void runtime.run(() => binding.setDisplayUnit({ operationId: runtime.opId(), expectedPresentationRevision: binding.getProjection().presentationRevision, parameter: value.quantityId, unit }), 'presentation');
      }}>
      {value.displayUnits.map(unit => <option key={unit} value={unit}>{unitLabel(unit, true)}</option>)}
    </select>
  );
}

function ValueRow({ value }: { value: ProjectedValue }) {
  const display = valueDisplay(value);
  return (
    <div className="eka-value-row" data-status={display.status} data-quantity={value.quantityId}>
      <dt>{value.label}</dt>
      <dd>
        {display.approximate ? <span className="eka-sr">approximately </span> : null}
        {display.text}{display.unit ? <span className="eka-unit"> {display.unit}</span> : null}
        {display.approximate ? <span className="eka-badge" aria-hidden="true">≈ approx.</span> : null}
        {/* “Undefined” already says what it is; a numerical limit keeps its badge to set it apart from a computed value. */}
        {display.status === 'numerical-limit' ? <span className="eka-badge">limit</span> : null}
      </dd>
      {value.displayUnits && value.displayUnits.length > 1 ? <dd className="eka-value-unit"><UnitSelect value={value} /></dd> : null}
      {display.reason ? <dd className="eka-value-reason">{display.reason}</dd> : null}
    </div>
  );
}

export function ValuesPanel({ title, values, headingLevel, description, frameId }: { title: string; values: ProjectedValue[]; headingLevel: number; description?: string; frameId?: string | null }) {
  const headingId = useStableId('eka-values');
  if (!values.length) return null;
  return (
    <section className="eka-panel" aria-labelledby={headingId} data-eka-panel="values" data-eka-frame-id={frameId ?? undefined} tabIndex={-1}>
      <Heading level={headingLevel} id={headingId} className="eka-panel-title">{title}</Heading>
      {description ? <p className="eka-sr">{description}</p> : null}
      <dl className="eka-values">{values.map(value => <ValueRow key={value.quantityId} value={value} />)}</dl>
    </section>
  );
}

/** One equation: plain text first; KaTeX replaces it once the equation is visible and math loaded without error. */
function MathEquation({ equation, showPlain }: { equation: ProjectedEquation; showPlain: boolean }) {
  const runtime = useRuntime();
  const labelId = useStableId('eka-eq');
  const hintId = useStableId('eka-eq-hint');
  const hostRef = useRef<HTMLDivElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const mathRef = useRef<HTMLSpanElement>(null);
  const [rendered, setRendered] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const overflowRef = useRef(false);
  const renderedRef = useRef(rendered);
  renderedRef.current = rendered;
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  // Typesetting replaces the plain text when the equation comes on screen, and a formula wider than the panel adds its
  // hint and plain form: both change the height by themselves. The element under an aiming pointer stays in place.
  const anchor = useRef<LayoutAnchor | null>(null);
  useLayoutEffect(() => {
    const kept = anchor.current;
    anchor.current = null;
    if (kept) runtimeRef.current.keepAnchor(kept);
  }, [rendered, overflow]);

  useEffect(() => {
    const host = hostRef.current, target = mathRef.current;
    if (!host || !target) return;
    let cancelled = false;
    setRendered(false);
    const start = () => {
      const current = runtimeRef.current;
      Promise.all([current.loadMath(), current.mathStyles(host)]).then(([katex]) => {
        if (cancelled || current.disposed()) return;
        const result = renderMathInto(katex, target, equation.tex);
        if (result.ok) { if (!renderedRef.current) anchor.current ??= current.layoutAnchor(); setRendered(true); }
        else current.report({ source: 'surface', code: 'MATH_FALLBACK', message: `Equation “${equation.label}” is shown as plain text: ${result.detail}`, path: `equations.${equation.equationId}` });
      }).catch(error => {
        if (cancelled || current.disposed()) return;
        current.report({ source: 'surface', code: 'MATH_ASSETS_UNAVAILABLE', message: `Math rendering is unavailable, so equations are shown as plain text (${error instanceof Error ? error.message : 'load failed'}).` });
      });
    };
    // KaTeX, its stylesheet and fonts load only once an equation is actually visible.
    if (typeof IntersectionObserver !== 'function') { start(); return () => { cancelled = true; }; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); start(); } });
    observer.observe(host);
    return () => { cancelled = true; observer.disconnect(); };
  }, [equation.tex, equation.label, equation.equationId]);

  // A horizontally scrolling equation must be reachable by keyboard (WCAG 2.1.1); width, fonts and text size can change.
  useEffect(() => {
    const region = regionRef.current;
    if (!region || !rendered) { overflowRef.current = false; setOverflow(false); return; }
    const measure = () => {
      const next = region.scrollWidth > region.clientWidth + 1;
      if (next === overflowRef.current) return;
      overflowRef.current = next;
      anchor.current ??= runtimeRef.current.layoutAnchor();
      setOverflow(next);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    // The rendered formula grows when its fonts arrive; its block box (not the inline host span) reports that.
    const formula = region.querySelector('.katex-display, .katex');
    if (formula) observer.observe(formula);
    const fonts = region.ownerDocument.fonts;
    fonts?.addEventListener?.('loadingdone', measure);
    return () => { observer.disconnect(); fonts?.removeEventListener?.('loadingdone', measure); };
  }, [rendered, equation.tex]);

  // A typeset equation wider than its panel (report §10.3) scrolls in a bordered region that is focusable and says so,
  // and its plain-text form (which wraps) is shown beneath it; text is never shrunk to fit.
  const wide = rendered && overflow;
  return (
    <div className="eka-equation" ref={hostRef} data-eka-equation={equation.equationId}>
      <span className="eka-equation-label" id={labelId}>{equation.label}</span>
      <div className="eka-math" role="group" aria-labelledby={labelId} aria-describedby={wide ? hintId : undefined} ref={regionRef}
        tabIndex={wide ? 0 : undefined} data-overflow={wide || undefined}>
        <span ref={mathRef} hidden={!rendered} />
        {rendered ? null : <span className="eka-plain">{equation.plain}</span>}
      </div>
      {wide ? <p className="eka-math-hint" id={hintId}><span aria-hidden="true">⇆</span>Wider than this panel: scroll it sideways, or read it as text below.</p> : null}
      {rendered && (showPlain || wide) ? <p className="eka-plain eka-panel-note" data-eka-plain={equation.equationId}>{equation.plain}</p> : null}
    </div>
  );
}

export function EquationsPanel({ title, equations, headingLevel, frameId }: { title: string; equations: ProjectedEquation[]; headingLevel: number; frameId?: string | null }) {
  const headingId = useStableId('eka-equations');
  const [plain, setPlain] = useState(false);
  if (!equations.length) return null;
  return (
    <section className="eka-panel" aria-labelledby={headingId} data-eka-panel="equations" data-eka-frame-id={frameId ?? undefined}>
      <div className="eka-nav-row">
        <Heading level={headingLevel} id={headingId} className="eka-panel-title">{title}</Heading>
        <button type="button" className="eka-button eka-button-quiet" aria-pressed={plain} onClick={() => setPlain(value => !value)}>Plain text</button>
      </div>
      <div className="eka-equations">{equations.map(equation => <MathEquation key={equation.equationId} equation={equation} showPlain={plain} />)}</div>
    </section>
  );
}

const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
/** How a shortened table was shortened, in words (the projection decides; the surface only explains). */
function shortenedNote(table: ProjectedTable): string {
  const shortened = table.shortened;
  if (shortened?.kind === 'every') return `Showing ${table.rows.length} of ${table.totalRows} rows: every ${ordinal(shortened.step)} sample and the last one, so the whole range is covered.`;
  if (shortened?.kind === 'ends') return `Showing the first ${Math.ceil(table.rows.length / 2)} and last ${Math.floor(table.rows.length / 2)} of ${table.totalRows} rows.`;
  return `Showing ${table.rows.length} of ${table.totalRows} rows.`;
}

/** Projection rows for unavailable geometry carry only `Not available…` cells (activity projection vocabulary). */
const unavailable = (cells: readonly string[]): boolean => cells.length > 1 && cells.every(cell => cell.startsWith('Not available'));

export function TablePanel({ table, title, headingLevel, regionRef, frameId }: { table: ProjectedTable; title: string; headingLevel: number; regionRef?: (element: HTMLDivElement | null) => void; frameId?: string | null }) {
  const headingId = useStableId('eka-table');
  return (
    <section className="eka-panel" aria-labelledby={headingId} data-eka-panel="table" data-eka-frame-id={frameId ?? undefined}>
      <Heading level={headingLevel} id={headingId} className="eka-panel-title">{title}</Heading>
      <div className="eka-table-region" role="region" aria-labelledby={headingId} tabIndex={0} ref={regionRef}>
        <table className="eka-table">
          <caption className="eka-sr">{table.caption}</caption>
          <thead><tr>{table.columns.map(column => <th key={column.id} scope="col">{column.label}{column.unitLabel ? <span className="eka-unit"> ({column.unitLabel})</span> : null}</th>)}</tr></thead>
          <tbody>{table.rows.map(row => unavailable(row.cells)
            // A row without any value (for example where a trace stops) is one full-width note, so its reason wraps
            // instead of widening the first column and pushing the value columns out of view.
            ? <tr key={row.key} data-eka-row="unavailable"><td className="eka-table-note" colSpan={table.columns.length}>{row.cells[0]}</td></tr>
            // A missing observed cell (projection vocabulary `Missing: <reason>`) wraps its reason instead of widening the table.
            : <tr key={row.key}>{row.cells.map((cell, i) => i === 0 ? <th key={i} scope="row">{numeralMinus(cell)}</th> : <td key={i} className={cell.startsWith('Missing: ') ? 'eka-table-missing' : undefined}>{cell.startsWith('Missing: ') ? cell : numeralMinus(cell)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {table.truncated || table.rows.length < table.totalRows ? <p className="eka-panel-note">{shortenedNote(table)}</p> : null}
      {/* Observed rows name their source (report §8.5); the projection writes the line from the manifest provenance. */}
      {table.source ? <p className="eka-panel-note" data-eka-source="observed">{table.source}</p> : null}
    </section>
  );
}

const positionWords = (position: FramePosition | undefined | null): string | null =>
  !position ? null : position.kind === 'index' ? `n = ${position.index}` : position.kind === 'time' ? `t = ${formatPlain(position.time) || position.time}` : null;
/**
 * One value of a comparison table: the value as the values panel shows it (approximation, unit, `limit` badge) and its
 * reason underneath, so an undefined or limit value of either run keeps its reason (A11, A34; never a bare “Undefined”).
 */
function ComparedValue({ value }: { value: ProjectedValue | null }) {
  if (!value) return <>Not shown</>;
  const display = valueDisplay(value);
  return (
    <>
      {display.approximate ? <><span aria-hidden="true">≈ </span><span className="eka-sr">approximately </span></> : null}
      {numeralMinus(display.text)}{display.unit ? ` ${display.unit}` : ''}
      {display.status === 'numerical-limit' ? <span className="eka-badge">limit</span> : null}
      {display.reason ? <span className="eka-comparison-reason">{display.reason}</span> : null}
    </>
  );
}
/** Fallback first line when a comparison has neither a kept position nor an overlay (the domain note says the rest). */
const ALIGNMENT_TEXT: Record<ProjectedComparison['alignment'], string | null> = {
  index: 'Aligned by iteration index n.', time: 'Aligned by time.', progress: 'Aligned by progress through each run.', static: 'A single state, compared as it is.',
};

/**
 * Kept runs compared with the current run (report §8.4, §10.2): each names its differing parameters by symbol, says how
 * the runs line up and where the kept run's own range ends, lists the plotted values of both runs at the same n and the
 * values that differ, and matches the dashed overlay of the kept run in the figures (same marker shape).
 */
export function ComparisonsPanel({ comparisons, canRetain, retainLabel, headingLevel, currentPosition }: {
  comparisons: ProjectedComparison[]; canRetain: boolean; retainLabel: string; headingLevel: number; currentPosition?: FramePosition | null;
}) {
  const runtime = useRuntime();
  const headingId = useStableId('eka-comparisons');
  const { binding } = runtime;
  if (!comparisons.length && !canRetain) return null;
  return (
    <section className="eka-panel" aria-labelledby={headingId} data-eka-panel="comparisons">
      <Heading level={headingLevel} id={headingId} className="eka-panel-title">Comparisons</Heading>
      {comparisons.map(comparison => <KeptRun key={comparison.runId} comparison={comparison} currentPosition={currentPosition ?? null} />)}
      {canRetain ? (
        <div><button type="button" className="eka-button" aria-disabled={runtime.busy || undefined}
          onClick={() => { if (!runtime.busy) void runtime.run(() => binding.retainComparison({ operationId: runtime.opId(), ...binding.getProjection().guards, label: retainLabel }), 'science'); }}>
          Keep this run to compare</button></div>
      ) : null}
    </section>
  );
}

/**
 * One kept run. Every reason is stated once (G41): the kept run's own boundary in its `!` line, any other reason a kept
 * point is missing in one note; a “Not available” cell points at the sentence that explains it (`aria-describedby`)
 * instead of repeating it. “Stop comparing” is a scientific action like the others: while the card is inert it is
 * `aria-disabled` with the card's visible reason and sends nothing.
 */
function KeptRun({ comparison, currentPosition }: { comparison: ProjectedComparison; currentPosition: FramePosition | null }) {
  const runtime = useRuntime();
  const { binding } = runtime;
  const boundaryId = useStableId('eka-comparison-boundary');
  const noteId = useStableId('eka-comparison-note');
  const reasonId = useStableId('eka-comparison-inert');
  const keptName = `kept run ${comparison.ordinal}`;
  const glyph = comparisonGlyph(comparison.ordinal);
  const keptAt = comparison.positionText;
  const currentAt = positionWords(currentPosition);
  const boundary = comparison.boundary;
  // Distinct reasons of missing kept points that the boundary line does not already state, each shown once.
  const notes = [...new Set(comparison.aligned.flatMap(row => row.kept === null && row.reason && row.reason !== boundary ? [row.reason] : []))];
  const explainedBy = (reason: string | undefined): string | undefined => !reason ? undefined : reason === boundary ? boundaryId : `${noteId}-${notes.indexOf(reason)}`;
  const inert = runtime.inert;
  const unavailable = runtime.busy || runtime.settling || !!inert;
  return (
    <div className="eka-comparison" data-eka-comparison={comparison.runId} data-eka-comparison-frame-id={comparison.frameId ?? undefined}>
      <p className="eka-comparison-runs">
        <svg className="eka-swatch" viewBox="0 0 30 12" width="30" height="12" aria-hidden="true" focusable="false">
          <line className="eka-role-muted eka-stroke eka-comparison-line" x1="1" x2="29" y1="6" y2="6" strokeWidth={2} strokeDasharray={COMPARISON_DASH} />
          <path className="eka-role-muted eka-hollow" d={markerPath(glyph, 15, 6, 4)} strokeWidth={1.5} />
        </svg>
        Kept run {comparison.ordinal}: <span className="eka-comparison-name">{numeralMinus(comparison.name)}</span>
      </p>
      <p className="eka-panel-note">
        {[keptAt ? `Kept at ${keptAt}.` : null, comparison.overlays.length ? `Drawn dashed with ${GLYPH_NAME[glyph]} markers in the plots.` : null].filter(Boolean).join(' ') || ALIGNMENT_TEXT[comparison.alignment]}
      </p>
      {comparison.parameterDifferences.length ? (
        <table className="eka-diff-table">
          <caption className="eka-sr">Parameters that differ between the current run and {keptName}</caption>
          <thead><tr><th scope="col">Parameter</th><th scope="col">Current run</th><th scope="col">Kept run {comparison.ordinal}</th></tr></thead>
          <tbody>{comparison.parameterDifferences.map(diff => (
            <tr key={diff.parameter}><th scope="row">{diff.label}</th><td>{diff.currentText !== undefined ? numeralMinus(diff.currentText) : '—'}</td><td>{numeralMinus(diff.text)}</td></tr>
          ))}</tbody>
        </table>
      ) : <p className="eka-diff">{comparison.hiddenDifferences ? 'Settings that are not shown here differ from the current run.' : 'Same parameters as the current run.'}</p>}
      {comparison.parameterDifferences.length && comparison.hiddenDifferences ? <p className="eka-diff">Settings that are not shown here also differ.</p> : null}
      {comparison.aligned.length ? (
        <table className="eka-diff-table" data-eka-comparison-aligned="">
          <caption className="eka-sr">Both runs at the same iteration n</caption>
          <thead><tr><th scope="col">At the same n</th><th scope="col">Current run</th><th scope="col">Kept run {comparison.ordinal}</th></tr></thead>
          <tbody>{comparison.aligned.map(row => (
            <tr key={`${row.viewId}:${row.label}`}>
              <th scope="row">{row.label} at n = {row.at}</th>
              <td>{row.current !== null ? numeralMinus(row.current) : 'Not available'}</td>
              <td>{row.kept !== null ? numeralMinus(row.kept) : <span className="eka-comparison-missing" aria-describedby={explainedBy(row.reason)}>Not available</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : null}
      {notes.map((reason, index) => <p key={reason} id={`${noteId}-${index}`} className="eka-panel-note">{reason}</p>)}
      {comparison.values.length ? (
        <table className="eka-diff-table" data-eka-comparison-values="">
          <caption className="eka-sr">Values that differ between the current run{currentAt ? ` at ${currentAt}` : ''} and {keptName}{keptAt ? ` at ${keptAt}` : ''}</caption>
          <thead><tr><th scope="col">Value</th><th scope="col">Current run{currentAt && currentAt !== keptAt ? ` (${currentAt})` : ''}</th><th scope="col">Kept run {comparison.ordinal}{keptAt && currentAt !== keptAt ? ` (${keptAt})` : ''}</th></tr></thead>
          <tbody>{comparison.values.map(row => (
            <tr key={row.quantityId}><th scope="row">{row.label}</th><td><ComparedValue value={row.current} /></td><td><ComparedValue value={row.kept} /></td></tr>
          ))}</tbody>
        </table>
      ) : null}
      {comparison.sameValues ? <p className="eka-panel-note">{comparison.values.length ? `${comparison.sameValues} other shown ${comparison.sameValues === 1 ? 'value is' : 'values are'} the same in both runs.` : 'Every shown value is the same in both runs.'}</p> : null}
      {boundary ? <p className="eka-comparison-boundary" id={boundaryId}><span className="eka-glyph" aria-hidden="true">!</span>{boundary}</p> : null}
      <p className="eka-panel-note">{comparison.domainNote}</p>
      <div>
        <button type="button" className="eka-button eka-button-quiet" aria-disabled={unavailable || undefined} aria-describedby={inert ? reasonId : undefined}
          onClick={() => { if (!unavailable && !runtime.scienceBusy()) void runtime.run(() => binding.removeComparison({ operationId: runtime.opId(), ...binding.getProjection().guards, runId: comparison.runId }), 'science'); }}>
          Stop comparing with kept run {comparison.ordinal}</button>
        {inert ? <p className="eka-reason" id={reasonId}><span className="eka-glyph" aria-hidden="true">–</span>{inert}</p> : null}
      </div>
    </div>
  );
}

export function AlternativesInfo({ alternatives }: { alternatives: ProjectedAlternative[] }) {
  if (!alternatives.length) return null;
  const equivalence: Record<ProjectedAlternative['equivalence'], string> = { equivalent: 'Same task', partial: 'Partial: summarises rather than lists everything', 'alternative-activity': 'A different activity for the same goal' };
  return (
    <details>
      <summary>Other ways to work with this activity</summary>
      <dl>
        {alternatives.map(alternative => (
          <div key={alternative.alternativeId}>
            <dt>{alternative.label} <span className="eka-badge">{equivalence[alternative.equivalence]}</span></dt>
            <dd>{alternative.description}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
