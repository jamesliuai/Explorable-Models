/**
 * `StudyActivitySurface`: the Study Harness learner card (report §10–§11). It receives only an `ActivityBinding` and
 * renders the binding's `LearnerProjection` — never a document, model or hidden content. Interaction intents go back
 * through guarded binding commands; the host owns the response composer (`responseSlot`) and the next action.
 *
 * Lifecycle: the surface registers itself with the binding, reports visibility (IntersectionObserver + document
 * visibility) and, after a projection is committed to the DOM in a registered visible surface, acknowledges display
 * of that exact projection once (`acknowledgeDisplay`). Nothing calls back into the host after unmount.
 *
 * Interaction (report §9–§11):
 * - inert states (`suspended`, `stale-policy`, `unsupported`, `awaiting-persistence`, `disposed`): every scientific
 *   control, scenario, navigation button, Reset experiment and Keep this run is `aria-disabled` with a visible reason,
 *   an unfinished gesture ends without committing, and a stale or unsupported card replaces the teaching instruction
 *   with a neutral line;
 * - focus: when a stage, policy or disposal removes the focused element, focus moves to the stage instruction, or to
 *   the card heading (`tabIndex=-1`) when the state has no instruction (preparing, empty, disposed);
 * - announcements (one polite live region, rate limited; `projectionAnnouncements`): committed changes, boundaries and
 *   actionable errors; the position once when playback pauses; a host suspension, awaiting persistence, a restored or a
 *   closed activity once each when entered; nothing while playing or previewing, and nothing when a preview ends
 *   without a commit; a change of the offered recovery (Reload the activity once worker recovery is used up) is
 *   announced, and a refused command never names a recovery the card no longer offers (`failureAnnouncement`);
 * - the live region follows the projection like every other channel (report §6.2): what it says stays only while the
 *   stage, context, policy and shown content it was said under still hold (`liveScope`); entering independent work, a
 *   stage or policy change, closing or a narrower projection empties it at once and drops anything still queued;
 * - layout stability: an equation typeset when it comes on screen keeps the element under an aiming pointer in place
 *   (`layoutAnchor`/`keepAnchor`), so a click aimed below it is not lost to the jump.
 */
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, Ref } from 'react';
import type { CommandOutcome, LearnerProjection, ProjectedControl, ProjectedStatus, ProjectedView, UiState } from '@explorable-models/activity';
import { projectionDigest } from '@explorable-models/activity';
import { assetLocations, INTER_FONT_FILES, adoptSheet, mathStylesheet, registerFonts } from './assets.js';
import { awaitRenderedProjection, captureRejection, loadCaptureView, CaptureError, type CaptureOptions } from './capture.js';
import { formatPlain } from './format.js';
import { defaultMathLoader, type KatexModule } from './math.js';
import { createAnnouncer, createOperationId, createSurfaceId, failureAnnouncement, GestureLane, INERT_STATES, liveScope, projectionAnnouncements, scopeHolds, type AnnouncementKind, type AnnouncementMemory, type Announcer, type LiveScope } from './runtime.js';
import { CONTENTLESS_STATES, PRESENTED_BY, type StatusCause } from './status.js';
import { adoptActivityStyles } from './styles.js';
import { BUNDLED_FONT_STACK, resolveTheme, tokenVariables, type ThemeMode } from './theme.js';
import type { StudyActivityHandle, StudyActivitySurfaceProps, SurfaceDiagnostic } from './types.js';
import { Heading, RuntimeContext, useRuntime, useStableId, type CommandScope, type LayoutAnchor, type SurfaceRuntime } from './components/context.js';
import { ParameterControl, ResetExperiment, Scenarios } from './components/Controls.js';
import { Navigation } from './components/Navigation.js';
import { AlternativesInfo, ComparisonsPanel, EquationsPanel, InlineStatus, PendingReveal, PersistenceChip, StatusBanner, TablePanel, ValuesPanel } from './components/Panels.js';
import { Scene2D, type Scene2DOverlay } from './components/Scene2D.js';
import { SpatialView } from './components/Spatial.js';

const GRAPHICAL = new Set<ProjectedView['kind']>(['plot2d', 'scene2d', 'scene3d']);
const ACK_MEMORY = 256;
/** The next animation frame, or the abort of `signal` (which cancels the frame), whichever comes first. */
const nextAnimationFrame = (signal: AbortSignal): Promise<void> => new Promise(resolve => {
  if (signal.aborted) { resolve(); return; }
  const cancel = () => { cancelAnimationFrame(handle); resolve(); };
  const handle = requestAnimationFrame(() => { signal.removeEventListener('abort', cancel); resolve(); });
  signal.addEventListener('abort', cancel, { once: true });
});
const mathModules = new WeakMap<() => Promise<KatexModule>, Promise<KatexModule>>();
/** A pointer that moved, scrolled or pressed within this many milliseconds is aiming (see `SurfaceRuntime.layoutAnchor`). */
const AIMING_MS = 1000;
/** Nearest scrolling ancestor of `element` across shadow roots (the document's scrolling element when none). */
function scrollContainer(element: Element): Element | null {
  const doc = element.ownerDocument;
  const parent = (node: Element): Element | null => node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null);
  for (let node = parent(element); node && node !== doc.body && node !== doc.documentElement; node = parent(node)) {
    const style = doc.defaultView?.getComputedStyle(node);
    if (style && /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return doc.scrollingElement;
}

/** Short visible reason shown on every scientific action while the card is inert (report §10.2, §11). */
const INERT_REASON: Partial<Record<UiState, string>> = {
  'stale-policy': 'Waiting for updated permissions from the host.',
  unsupported: 'Not available here.',
  'awaiting-persistence': 'Waiting for the host to save this step.',
  disposed: 'This activity has ended.',
};
/** Reason a card is inert, or null when its scientific actions are available. */
export function inertReason(status: ProjectedStatus): string | null {
  if (!INERT_STATES.has(status.ui)) return null;
  if (status.ui === 'suspended') return /^Paused by the host/.test(status.message ?? '') ? 'Paused by the host.' : 'Paused while hidden.';
  return INERT_REASON[status.ui] ?? 'Not available right now.';
}

function useMediaQuery(query: string, fallback = false): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** Latest projection from the binding (subscription is the single source of truth; command results are not applied). */
function useProjection(binding: StudyActivitySurfaceProps['binding']): LearnerProjection {
  const [projection, setProjection] = useState(() => binding.getProjection());
  useEffect(() => {
    setProjection(binding.getProjection());
    return binding.subscribe(() => setProjection(binding.getProjection()));
  }, [binding]);
  return projection;
}

/** @internal Signals the first committed render to `mountStudyActivity`. */
export interface InternalSurfaceProps { onFirstRender?: () => void }

export function StudyActivitySurface(props: StudyActivitySurfaceProps & InternalSurfaceProps & { ref?: Ref<StudyActivityHandle> }) {
  const { binding } = props;
  const [surfaceId] = useState(() => props.surfaceId ?? createSurfaceId());
  const projection = useProjection(binding);
  const rootRef = useRef<HTMLDivElement>(null);
  const instructionRef = useRef<HTMLParagraphElement>(null);
  /** Focus target of states without an instruction (preparing, empty, disposed). */
  const headingRef = useRef<HTMLHeadingElement>(null);
  const disposed = useRef(false);
  /** Aborted when the surface unmounts, so work waiting on the page (an animation frame) settles at once. */
  const lifetime = useRef<AbortController | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const titleId = useStableId('ema-title');

  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const mode: ThemeMode = props.theme === 'light' || props.theme === 'dark' ? props.theme : prefersDark ? 'dark' : 'light';
  const fonts = props.fonts === 'bundled' ? 'bundled' : 'system';
  const tokenKey = JSON.stringify(props.tokens ?? null);
  // Keyed by the serialized tokens so a host passing a fresh object each render does not re-resolve the theme.
  const theme = useMemo(() => resolveTheme(mode, props.tokens), [mode, tokenKey]);
  const variables = useMemo(() => {
    const tokens = fonts === 'bundled' && !props.tokens?.fontFamily ? { ...theme.tokens, fontFamily: BUNDLED_FONT_STACK } : theme.tokens;
    return tokenVariables(tokens, reducedMotion) as CSSProperties;
  }, [theme, fonts, reducedMotion, props.tokens?.fontFamily]);
  const locations = useMemo(() => assetLocations(props.assetBase), [props.assetBase]);
  const locale = props.locale ?? projection.presentation.locale ?? undefined;

  const report = useCallback((diagnostic: SurfaceDiagnostic) => { if (!disposed.current) propsRef.current.onDiagnostic?.(diagnostic); }, []);

  // Announcements: one polite live region, rate limited; never animation frames. Each text carries the scope it was
  // said under and is shown only while that scope holds (report §6.2). The announcer is created on first use and
  // released on unmount, so a remount (React StrictMode, a host re-render) gets a working one.
  const scope = useMemo(() => liveScope(projection), [projection]);
  const scopeRef = useRef<LiveScope>(scope);
  scopeRef.current = scope;
  const [live, setLive] = useState<{ text: string; scope: LiveScope } | null>(null);
  const announcerRef = useRef<Announcer | null>(null);
  const announce = useCallback((text: string, kind: AnnouncementKind) => {
    if (disposed.current) return;
    // A repeat of the same text differs by a no-break space so assistive technology reads it again.
    announcerRef.current ??= createAnnouncer({
      emit: next => { if (!disposed.current) setLive(previous => ({ text: previous?.text === next ? `${next} ` : next, scope: scopeRef.current })); },
    });
    announcerRef.current.announce(text, kind);
  }, []);
  useEffect(() => () => { announcerRef.current?.dispose(); announcerRef.current = null; }, []);
  // A narrower scope empties the region in the same commit (the render below already shows nothing) and drops anything
  // still queued, before any timer can speak it.
  const priorScope = useRef<LiveScope>(scope);
  useLayoutEffect(() => {
    const prior = priorScope.current;
    priorScope.current = scope;
    if (scopeHolds(prior, scope)) return;
    announcerRef.current?.clear();
    setLive(null);
  }, [scope]);
  const liveText = live && scopeHolds(live.scope, scope) ? live.text : '';

  // Layout stability (see `SurfaceRuntime.layoutAnchor`): where the learner's pointer is over the card and when it last
  // moved, scrolled or pressed.
  const pointer = useRef<{ x: number; y: number; at: number; pressed: boolean } | null>(null);
  const trackPointer = (event: { clientX: number; clientY: number }, pressed?: boolean) => {
    pointer.current = { x: event.clientX, y: event.clientY, at: performance.now(), pressed: pressed ?? pointer.current?.pressed ?? false };
  };
  const layoutAnchor = useCallback((): LayoutAnchor | null => {
    const at = pointer.current, root = rootRef.current;
    if (!at || !root || disposed.current || (!at.pressed && performance.now() - at.at > AIMING_MS)) return null;
    const element = (root.getRootNode() as Document | ShadowRoot).elementFromPoint?.(at.x, at.y) ?? null;
    return element && root.contains(element) ? { element, top: element.getBoundingClientRect().top } : null;
  }, []);
  const keepAnchor = useCallback((anchor: LayoutAnchor | null) => {
    if (!anchor || !anchor.element.isConnected || disposed.current) return;
    const moved = anchor.element.getBoundingClientRect().top - anchor.top;
    if (Math.abs(moved) < 0.5) return;
    scrollContainer(anchor.element)?.scrollBy({ top: moved, behavior: 'instant' });
  }, []);

  const [busyCount, setBusyCount] = useState(0);
  /** Scientific commands in flight, counted synchronously (rapid activations in one task see each other). */
  const scienceCount = useRef(0);
  // Gesture completions of this surface (GestureLane): a gesture pressed during a commit waits for it.
  const [lane] = useState(() => new GestureLane());
  const [settling, setSettling] = useState(false);
  useEffect(() => lane.subscribe(() => { if (!disposed.current) setSettling(lane.busy); }), [lane]);
  const inert = inertReason(projection.status);
  const [commandError, setCommandError] = useState<string | null>(null);
  /** Code of the refused command shown in `commandError` (its banner is not repeated when the status already presents the cause). */
  const [commandErrorCode, setCommandErrorCode] = useState<string | null>(null);
  const [showTables, setShowTables] = useState(false);
  const [showText, setShowText] = useState(false);
  const tableRegion = useRef<HTMLDivElement | null>(null);
  /** Incremented by “Inspect values”; each request reveals the tables (or values) and moves focus there. */
  const [inspectRequest, setInspectRequest] = useState(0);

  /** What the announcement effect remembers between projections (see `projectionAnnouncements`, `failureAnnouncement`). */
  const memory = useRef<AnnouncementMemory>({ committedFrameId: null, statusSaid: null });
  const fail = useCallback((diagnostics: { code: string; message: string; path?: string; recovery?: string }[]) => {
    if (disposed.current || !diagnostics.length) return;
    for (const diagnostic of diagnostics) report({ source: 'binding', code: diagnostic.code as SurfaceDiagnostic['code'], message: diagnostic.message, path: diagnostic.path, recovery: diagnostic.recovery });
    const first = diagnostics[0];
    const text = `${first.message}${first.recovery ? ` ${first.recovery}` : ''}`;
    setCommandError(text);
    setCommandErrorCode(first.code);
    // The binding's projection already carries the status this refusal produced (published before the command settles):
    // a refusal whose cause that status presents names the status's recovery, never one the card no longer offers.
    let current: LearnerProjection | null = null;
    try { current = binding.getProjection(); } catch { current = null; }
    announce(failureAnnouncement(first, current, memory.current), 'error');
  }, [binding, report, announce]);

  const runtime = useMemo<SurfaceRuntime>(() => ({
    binding, surfaceId, locale, headingLevel: props.headingLevel ?? 2, fonts, locations, reducedMotion, busy: busyCount > 0,
    scienceBusy: () => scienceCount.current > 0 || lane.busy, settling, lane, inert,
    disposed: () => disposed.current,
    opId: createOperationId,
    report,
    announce,
    fail,
    async run(command: () => CommandOutcome | Promise<CommandOutcome>, scope: CommandScope = 'other') {
      if (disposed.current) return null;
      if (scope === 'science') { scienceCount.current++; setBusyCount(count => count + 1); }
      try {
        const outcome = await command();
        if (disposed.current) return null;
        if (outcome.ok) setCommandError(null); else fail(outcome.diagnostics);
        return outcome;
      } catch (error) {
        if (!disposed.current) fail([{ code: 'COMMAND_REJECTED', message: error instanceof Error ? error.message : 'The command could not be completed.' }]);
        return null;
      } finally {
        if (scope === 'science') { scienceCount.current = Math.max(0, scienceCount.current - 1); if (!disposed.current) setBusyCount(count => Math.max(0, count - 1)); }
      }
    },
    loadMath() {
      const loader = propsRef.current.mathLoader ?? defaultMathLoader;
      let pending = mathModules.get(loader);
      if (!pending) { pending = loader(); pending.catch(() => mathModules.delete(loader)); mathModules.set(loader, pending); }
      return pending;
    },
    async mathStyles(node: Node) {
      const doc = node.ownerDocument ?? document;
      const sheet = await mathStylesheet(doc, locations);
      const root = node.getRootNode() as Document | ShadowRoot;
      if ('adoptedStyleSheets' in root) adoptSheet(root, sheet);
      if (fonts === 'bundled') {
        const { KATEX_FONT_FILES } = await import('./math-font-urls.js');
        registerFonts(doc, KATEX_FONT_FILES, locations);
      }
    },
    spatialLoader: props.spatialLoader,
    inspectValues: () => { setShowTables(true); setInspectRequest(count => count + 1); },
    layoutAnchor,
    keepAnchor,
  }), [binding, surfaceId, locale, props.headingLevel, fonts, locations, reducedMotion, busyCount, settling, lane, inert, report, announce, fail, props.spatialLoader, layoutAnchor, keepAnchor]);

  // Component styles in whatever root this renders into (shadow root or document); reference-counted.
  useLayoutEffect(() => {
    const root = rootRef.current?.getRootNode();
    if (!root || !('adoptedStyleSheets' in root || 'head' in root)) return;
    const adopted = adoptActivityStyles(root as Document | ShadowRoot, propsRef.current.assetBase);
    if (!adopted.ok) report({ source: 'surface', code: 'STYLES_UNAVAILABLE', message: 'This browser cannot apply the surface stylesheet; pass assetBase so activity.css can be linked.' });
    return adopted.release;
  }, [report]);
  useEffect(() => { if (fonts === 'bundled' && rootRef.current) registerFonts(rootRef.current.ownerDocument, INTER_FONT_FILES, locations); }, [fonts, locations]);
  useEffect(() => { for (const rejected of theme.rejected) report({ source: 'surface', code: 'TOKEN_REJECTED', message: `Theme token ${rejected.token} was ignored: ${rejected.reason}.`, path: `tokens.${rejected.token}` }); }, [theme, report]);

  // Registration and visibility (offscreen, collapsed, hidden tab) → binding.reportVisibility.
  const [visible, setVisible] = useState<boolean | null>(null);
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    disposed.current = false;
    const life = new AbortController();
    lifetime.current = life;
    const unregister = binding.registerSurface(surfaceId);
    const doc = element.ownerDocument;
    let intersecting: boolean | null = typeof IntersectionObserver === 'function' ? null : true;
    let reported: boolean | null = null;
    const update = () => {
      if (intersecting === null || disposed.current) return;
      const next = intersecting && doc.visibilityState !== 'hidden';
      if (next === reported) return;
      reported = next;
      binding.reportVisibility({ surfaceId, visible: next });
      setVisible(next);
    };
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => { intersecting = entries[entries.length - 1].isIntersecting; update(); }) : null;
    observer?.observe(element);
    doc.addEventListener('visibilitychange', update);
    update();
    return () => { observer?.disconnect(); doc.removeEventListener('visibilitychange', update); disposed.current = true; life.abort(); unregister(); };
  }, [binding, surfaceId]);

  // Display acknowledgement: once per projection, after it is in the DOM of a registered, visible surface.
  const acknowledged = useRef<string[]>([]);
  useLayoutEffect(() => {
    if (!visible || disposed.current || projection.status.ui === 'disposed') return;
    if (acknowledged.current.includes(projection.projectionId)) return;
    acknowledged.current.push(projection.projectionId);
    if (acknowledged.current.length > ACK_MEMORY) acknowledged.current.shift();
    try { binding.acknowledgeDisplay({ projectionId: projection.projectionId, projectionDigest: projection.projectionDigest, surfaceId }); }
    catch (error) { report({ source: 'binding', code: 'COMMAND_REJECTED', message: error instanceof Error ? error.message : 'Display acknowledgement failed.' }); }
  }, [projection.projectionId, projection.projectionDigest, projection.status.ui, visible, binding, surfaceId, report]);

  const firstRender = useRef(false);
  useLayoutEffect(() => { if (!firstRender.current) { firstRender.current = true; propsRef.current.onFirstRender?.(); } }, []);

  // Focus restoration: a control hidden by a stage change hands focus to the stage instruction; a state without an
  // instruction (preparing, empty, disposed) hands it to the card heading.
  const lastFocus = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const element = lastFocus.current;
    const target = instructionRef.current ?? headingRef.current;
    if (element && !element.isConnected && target) { target.focus(); lastFocus.current = target; }
  });
  useEffect(() => {
    if (!inspectRequest) return;
    const target = tableRegion.current ?? rootRef.current?.querySelector<HTMLElement>('[data-ema-panel="values"]');
    target?.focus();
    target?.scrollIntoView?.({ block: 'nearest' });
  }, [inspectRequest]);

  // Announcements for committed changes, boundaries and errors (never while playing or previewing; see
  // `projectionAnnouncements`).
  const previous = useRef<LearnerProjection | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = projection;
    for (const item of projectionAnnouncements(before, projection, memory.current, locale)) announce(item.text, item.kind);
  }, [projection, announce, locale]);

  useImperativeHandle(props.ref, () => ({
    surfaceId,
    async capture(options: CaptureOptions) {
      if (disposed.current) throw new CaptureError('DISPOSED', 'This surface has been disposed.', 'Mount the activity again.');
      const frozen = binding.getProjection();
      const rejection = captureRejection(frozen);
      if (rejection) throw rejection;
      const life = lifetime.current;
      if (!life) throw new CaptureError('DISPOSED', 'This surface has been disposed.', 'Mount the activity again.');
      const captureView = await loadCaptureView(life.signal);
      if (disposed.current) throw new CaptureError('DISPOSED', 'This surface has been disposed.', 'Mount the activity again.');
      const current = binding.getProjection();
      const currentRejection = captureRejection(current);
      if (currentRejection) throw currentRejection;
      // A save acknowledgement may settle while the local asset loads. Every content element and revision must
      // still match the frozen request; only operational status may differ. Use the current rendered identity.
      if (current.projectionId !== frozen.projectionId && projectionDigest({ ...current, status: frozen.status }) !== frozen.projectionDigest)
        throw new CaptureError('NOT_READY', 'The view changed while capture loaded.', 'Capture again after the view settles.');
      // Disposal aborts this wait even when an occluded page delivers no animation frames.
      await awaitRenderedProjection({ projectionId: current.projectionId, shown: () => rootRef.current?.dataset.emaProjection, signal: life.signal, nextFrame: nextAnimationFrame });
      const root = rootRef.current;
      if (!root) throw new CaptureError('DISPOSED', 'This surface has been disposed.', 'Mount the activity again.');
      if (fonts === 'bundled') await root.ownerDocument.fonts?.ready;
      if (disposed.current) throw new CaptureError('DISPOSED', 'This surface has been disposed.', 'Mount the activity again.');
      const result = await captureView({ root, themeElement: root, surfaceId, projection: current, fonts, locations, locale }, options);
      // A capture that finishes after disposal hands no data to a caller that has already released the surface.
      if (disposed.current) throw new CaptureError('DISPOSED', 'This surface has been disposed.', 'Mount the activity again.');
      return result;
    },
  }), [binding, surfaceId, fonts, locations, locale]);

  const ui = projection.status.ui;
  const level = props.headingLevel ?? 2;
  const contentless = CONTENTLESS_STATES.has(ui);
  const graphical = projection.views.filter(view => GRAPHICAL.has(view.kind));
  const valueViews = projection.views.filter(view => view.kind === 'values');
  const equationViews = projection.views.filter(view => view.kind === 'equation');
  const tableViews = projection.views.filter(view => view.kind === 'table' && view.table);
  const tableAlternative = projection.alternatives.find(alternative => alternative.kind === 'table');
  const descriptionAlternative = projection.alternatives.find(alternative => alternative.kind === 'description');
  const tablesVisible = showTables || !graphical.length;
  // Without a drawing, navigation or table the side panels take the whole width instead of leaving an empty column.
  const mainContent = graphical.length > 0 || projection.navigation !== null || (tablesVisible && tableViews.length > 0);
  const committedFrame = projection.frame?.kind === 'committed';
  // Under a stale policy or for unsupported content the projection itself carries a neutral instruction and no prompt.
  const instruction = projection.stage.instruction;
  const someInteractive = projection.controls.some(control => control.mode === 'interactive');
  const retainLabel = keptRunLabel(projection.controls, locale);
  // A refused command whose cause the status already presents (a worker failure, saving, permissions) is not repeated.
  const errorPresented = commandErrorCode !== null && (PRESENTED_BY[commandErrorCode] ?? []).includes(ui);
  const sections = controlSections(projection.controls);

  return (
    <RuntimeContext.Provider value={runtime}>
      <div
        ref={rootRef} className="ema" style={variables} lang={locale} data-theme={mode} data-layout={projection.presentation.layout}
        data-ema-surface={surfaceId} data-ema-projection={projection.projectionId} data-ema-ui-state={ui}
        onFocus={event => { lastFocus.current = event.target; }}
        onBlur={event => { if (!rootRef.current?.contains(event.relatedTarget as Node | null)) lastFocus.current = null; }}
        onPointerMove={event => trackPointer(event)} onWheel={event => trackPointer(event)}
        onPointerDown={event => trackPointer(event, true)} onPointerUp={event => trackPointer(event, false)}
        onPointerLeave={() => { pointer.current = null; }} onPointerCancel={() => { pointer.current = null; }}
      >
        <section className="ema-card" aria-labelledby={titleId}>
          <header className="ema-header">
            <div className="ema-heading">
              <Heading level={level} id={titleId} className="ema-title" ref={headingRef} tabIndex={-1}>{projection.title}</Heading>
              {projection.context === 'independent' ? <span className="ema-subtitle">Independent task</span> : null}
            </div>
            <PersistenceChip projection={projection} />
          </header>
          <StatusBanner projection={projection} onRecoveryAction={props.onRecoveryAction} />
          {commandError && !errorPresented ? (
            <div className="ema-banner" data-tone="error">
              <span className="ema-glyph" aria-hidden="true">×</span>
              <div className="ema-banner-body"><p className="ema-banner-title">That change was not applied</p><p>{commandError}</p></div>
              <div className="ema-banner-actions"><button type="button" className="ema-button ema-button-quiet" onClick={() => setCommandError(null)}>Dismiss</button></div>
            </div>
          ) : null}
          <PendingReveal projection={projection} />
          {contentless ? null : <p className="ema-instruction" ref={instructionRef} tabIndex={-1}>{instruction}</p>}
          {contentless ? null : (
            <div className="ema-workspace" data-single={mainContent ? undefined : 'true'}>
              {mainContent ? <div className="ema-main">
                {graphical.map(view => view.kind === 'scene3d'
                  ? <SpatialView key={view.viewId} view={view} projection={projection} controls={projection.controls} showSummary={showText} headingLevel={level + 1} />
                  : <GraphicalView key={view.viewId} view={view} projection={projection} showText={showText} headingLevel={level + 1} />)}
                {projection.navigation ? <Navigation navigation={projection.navigation} frame={projection.frame} headingLevel={level + 1} /> : null}
                {projection.navigation ? <InlineStatus projection={projection} causes={NAVIGATION_NOTICES} /> : null}
                {graphical.length && (tableViews.length || descriptionAlternative || tableAlternative) ? (
                  <div className="ema-alternatives">
                    <div className="ema-toolbar" role="group" aria-label="Also show">
                      {tableViews.length ? <button type="button" className="ema-button" aria-pressed={showTables} onClick={() => setShowTables(value => !value)}>{tableAlternative?.label ?? 'Table'}</button> : null}
                      {/* The toggle always shows the generated view summaries, so it is named for that, not after the first description alternative. */}
                      <button type="button" className="ema-button" aria-pressed={showText} onClick={() => setShowText(value => !value)}>Text description</button>
                    </div>
                    <AlternativesInfo alternatives={projection.alternatives} />
                  </div>
                ) : null}
                {tablesVisible ? tableViews.map((view, index) => (
                  <TablePanel key={view.viewId} table={view.table!} title={view.title} headingLevel={level + 1} frameId={projection.frame?.frameId ?? null} regionRef={index === 0 ? element => { tableRegion.current = element; } : undefined} />
                )) : null}
              </div> : null}
              <div className="ema-side">
                {projection.controls.length ? (
                  <section className="ema-panel" aria-label="Controls" data-ema-frame-id={projection.frame?.frameId}>
                    {sections.map(section => section.section ? (
                      <ControlSection key={section.section.id} section={section.section} headingLevel={level + 1}>
                        {section.controls.map(control => <ParameterControl key={control.parameter} control={control} activePreviewId={projection.preview?.previewId ?? null} />)}
                      </ControlSection>
                    ) : section.controls.map(control => <ParameterControl key={control.parameter} control={control} activePreviewId={projection.preview?.previewId ?? null} />))}
                    <InlineStatus projection={projection} causes={projection.navigation ? CONTROL_NOTICES : undefined} />
                    {someInteractive ? <ResetExperiment previewActive={projection.preview !== null} /> : null}
                  </section>
                ) : null}
                {projection.scenarios.length ? <Scenarios scenarios={projection.scenarios} title="Scenarios" headingLevel={level + 1} /> : null}
                {valueViews.map(view => <ValuesPanel key={view.viewId} title={view.title} values={view.values} headingLevel={level + 1} frameId={projection.frame?.frameId ?? null} />)}
                {graphical.filter(view => view.values.length).map(view => <ValuesPanel key={`${view.viewId}:values`} title={`${view.title}: values`} values={view.values} headingLevel={level + 1} frameId={projection.frame?.frameId ?? null} />)}
                {[...equationViews, ...graphical.filter(view => view.equations.length)].map(view => <EquationsPanel key={`${view.viewId}:equations`} title={view.title} equations={view.equations} headingLevel={level + 1} frameId={projection.frame?.frameId ?? null} />)}
                <ComparisonsPanel comparisons={projection.comparisons} canRetain={projection.stage.kind === 'explore' && committedFrame && projection.context === 'instructional' && !inert} retainLabel={retainLabel} headingLevel={level + 1} currentPosition={projection.frame?.position ?? null} />
              </div>
            </div>
          )}
          {!contentless && (projection.stage.response || props.responseSlot) ? (
            <section className="ema-response" aria-label={projection.stage.response ? (projection.stage.response.kind === 'prediction' ? 'Your prediction' : 'Your explanation') : 'Your response'}>
              {projection.stage.response ? <p className="ema-panel-title">{projection.stage.response.prompt}</p> : null}
              {props.responseSlot}
            </section>
          ) : null}
          <footer className="ema-footer">
            <p className="ema-review">{projection.reviewNotice}</p>
            <div className="ema-footer-actions">
              {contentless ? null : <button type="button" className="ema-button" onClick={() => announce(binding.describeCurrentValues(), 'request')}>Read current values</button>}
              {props.nextAction ? (
                <>
                  {props.nextAction.status ? <span className="ema-next-status" role="status">{props.nextAction.status}</span> : null}
                  <button type="button" className="ema-button ema-button-primary" aria-disabled={props.nextAction.disabled || undefined}
                    onClick={() => { if (!props.nextAction?.disabled && !disposed.current) props.nextAction?.onSelect(); }}>{props.nextAction.label}</button>
                </>
              ) : null}
            </div>
          </footer>
          <div className="ema-sr" role="status" aria-live="polite" aria-atomic="true">{liveText}</div>
        </section>
      </div>
    </RuntimeContext.Provider>
  );
}

function GraphicalView({ view, projection, showText, headingLevel }: { view: ProjectedView; projection: LearnerProjection; showText: boolean; headingLevel: number }) {
  const titleId = useStableId('ema-view');
  const runtime = useRuntime();
  const camera = projection.presentation.views[view.viewId]?.camera;
  const guard = () => ({ operationId: runtime.opId(), expectedPresentationRevision: runtime.binding.getProjection().presentationRevision });
  return (
    <Scene2D
      view={view} captureViewId={view.viewId} projectionId={projection.projectionId} frameId={projection.frame?.frameId ?? null} titleId={titleId}
      camera={camera?.kind === '2d' ? camera : null} selection={projection.presentation.selection} controls={projection.controls} showSummary={showText} headingLevel={headingLevel}
      tentative={projection.frame?.kind === 'tentative'} overlays={comparisonOverlays(projection, view.viewId)}
      // Stepping and playback change the drawing without a gesture on it: its out-of-view line keeps its place (S3).
      reserveOutOfView={projection.navigation !== null}
      onCamera={next => void runtime.run(() => next ? runtime.binding.setCamera({ ...guard(), viewId: view.viewId, camera: next }) : runtime.binding.resetView({ ...guard(), viewId: view.viewId }), 'presentation')}
      onSelect={target => void runtime.run(() => runtime.binding.select({ ...guard(), target }), 'presentation')}
    />
  );
}

/** Notices shown under the navigation (playback) and under the controls (previews and the rest). */
const NAVIGATION_NOTICES: ReadonlySet<StatusCause> = new Set<StatusCause>(['playing', 'paused']);
const CONTROL_NOTICES: ReadonlySet<StatusCause> = new Set<StatusCause>(['preview', 'ready']);

/** Kept-run overlays of one 2D view, in comparison order (each run drawn with its own marker shape). */
function comparisonOverlays(projection: LearnerProjection, viewId: string): Scene2DOverlay[] {
  return projection.comparisons.flatMap(comparison => {
    const overlay = comparison.overlays.find(item => item.viewId === viewId);
    return overlay?.marks.length ? [{ runId: comparison.runId, ordinal: comparison.ordinal, name: comparison.name, frameId: comparison.frameId, marks: overlay.marks }] : [];
  });
}

/**
 * Label sent when the learner keeps a run: every shown parameter by its symbol with its value (`η = 0.25, a = 2,
 * x₀ = 4`), bounded to the 200-character contract limit.
 */
export function keptRunLabel(controls: readonly ProjectedControl[], locale?: string): string {
  const text = controls.filter(control => control.mode === 'interactive' || control.mode === 'fixed')
    .map(control => `${control.symbol ?? control.label} = ${formatPlain(control.value, locale) || String(control.value)}${control.unitLabel ? control.displayUnit === 'deg' ? '°' : ` ${control.unitLabel}` : ''}`).join(', ');
  const chars = [...text];
  return !text ? 'Kept run' : chars.length > 200 ? `${chars.slice(0, 199).join('')}…` : text;
}

/** Controls in authored order, grouped by presentation section (a section is placed where its first control is). */
export function controlSections(controls: readonly ProjectedControl[]): { section: ProjectedControl['section'] | null; controls: ProjectedControl[] }[] {
  const out: { section: ProjectedControl['section'] | null; controls: ProjectedControl[] }[] = [];
  const bySection = new Map<string, ProjectedControl[]>();
  for (const control of controls) {
    if (!control.section) { const last = out[out.length - 1]; if (last && !last.section) last.controls.push(control); else out.push({ section: null, controls: [control] }); continue; }
    const existing = bySection.get(control.section.id);
    if (existing) { existing.push(control); continue; }
    const group = [control];
    bySection.set(control.section.id, group);
    out.push({ section: control.section, controls: group });
  }
  return out;
}

/** One labelled group of related controls (report §10.2): a heading and the controls, exposed as one named group. */
function ControlSection({ section, headingLevel, children }: { section: NonNullable<ProjectedControl['section']>; headingLevel: number; children: ReactNode }) {
  const headingId = useStableId('ema-section');
  return (
    <div className="ema-control-section" role="group" aria-labelledby={headingId} data-ema-section={section.id}>
      <Heading level={headingLevel} id={headingId} className="ema-section-title">{section.label}</Heading>
      {children}
    </div>
  );
}
