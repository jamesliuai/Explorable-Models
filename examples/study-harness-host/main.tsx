/**
 * BROWSER INTEGRATION FIXTURE PAGE (`study-harness.html`) — plays a Study Harness host around the learner card: host
 * stage buttons, a host-owned response composer, host tables in sessionStorage and fault injection. Two flows:
 *
 * - scripted (default; `quadratic-gradient-descent`): the quadratic learning-and-return fixture with fixed, labelled
 *   tutor messages and the host composer in the host column (`fixture-session.ts`);
 * - generic (every other installed template, or `?flow=generic`): host controls generated from the template, the host
 *   composer inside the card's response slot and a promise-based driver for browser tests (`generic-session.ts`).
 *
 * It is not a tutor, not the Study Harness application and not evidence of learning benefit.
 *
 * Query string:
 *   ?template=<templateId>      installed template (default quadratic-gradient-descent)
 *   ?flow=scripted|generic      the quadratic template runs the scripted flow unless flow=generic; other templates are generic
 *   ?mode=guided|free           guided flow from the initial stage (default) or authorized free exploration
 *   ?policy=held|full           generic flow: solution-bearing groups held outside the policy ceiling until revealed (default) or inside it
 *   ?spatial=1                  pass a lazy `@experiment-kit/player-3d` loader to the card (absent/0: the card's 2D projection fallback)
 *   ?fail=<point>[:n][,…]       one-shot host failures before commit, armed when the fixture session starts
 *                               (points: exposure-intent, scope-intent, stage, display-ack, append, save, assistance, policy, cursor, register)
 *   ?delay=<point>:<ms>[,…]     host call delays before processing (a bare number delays exposure intents)
 *   ?lag=<point>:<ms>[,…]       late host replies: the call commits at once, its reply arrives after <ms>
 *   ?crash=before-intent|after-intent|after-display   terminate the host once at an exposure protocol point
 *   ?revoke=1                   revoke the host policy right after the activity opens
 *   ?workerDelay=<ms>           delay every kernel-worker reply (late-reply tests); window.studyHarnessFixture.workerFaults.drop drops replies
 *   ?width=320|390|640|960      learner card container width; ?theme=light|dark|system; ?text=200; ?fonts=bundled|system
 */
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
import { validateRecord, type ActivityArtifact, type SchemaName } from '@experiment-kit/activity';
import { INSTALLED_TEMPLATES, quadraticGradientDescentTemplate } from '@experiment-kit/catalog';
import type { SpatialRendererModule } from '@experiment-kit/player/activity';
import { CRASH_POINTS, INJECTION_POINTS, type CrashPoint, type InjectionPoint } from './fixture-host';
import type { FixtureOptions } from './fixture-runtime';
import { FixtureSession, STEP_LABELS, type SessionSnapshot, type StepId } from './fixture-session';
import { workerFaults } from './fixture-worker';
import { GenericSession, type DriverResult, type GenericControl, type GenericSnapshot } from './generic-session';
import './study-harness.css';

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const isPoint = (value: string): value is InjectionPoint => (INJECTION_POINTS as readonly string[]).includes(value);
function pointList(raw: string | null, fallbackPoint: InjectionPoint | null, fallbackValue: number): Partial<Record<InjectionPoint, number>> {
  const out: Partial<Record<InjectionPoint, number>> = {};
  for (const part of (raw ?? '').split(',').map(item => item.trim()).filter(Boolean)) {
    const [name, value] = part.split(':');
    if (fallbackPoint && /^\d+$/.test(name!)) { out[fallbackPoint] = Number(name); continue; }
    if (isPoint(name!)) out[name] = value !== undefined && /^\d+$/.test(value) ? Number(value) : fallbackValue;
  }
  return out;
}
/** The renderer module is imported only when a card shows a `scene3d` view; a failed import leaves the card's 2D fallback. */
const loadSpatial = (): Promise<SpatialRendererModule> => import('./spatial-loader').then(module => module.loadSpatialRenderer());
const width = [320, 390, 640, 960].includes(Number(params.get('width'))) ? Number(params.get('width')) : null;
const options: FixtureOptions = {
  mode: params.get('mode') === 'free' ? 'free' : 'guided',
  fail: pointList(params.get('fail'), null, 1),
  delay: pointList(params.get('delay'), 'exposure-intent', 1000),
  lag: pointList(params.get('lag'), 'exposure-intent', 1000),
  crash: (CRASH_POINTS as readonly string[]).includes(params.get('crash') ?? '') ? params.get('crash') as CrashPoint : null,
  revoke: params.get('revoke') === '1',
  workerDelayMs: Math.min(10_000, Math.max(0, Number(params.get('workerDelay')) || 0)),
  theme: (['light', 'dark', 'system'] as const).find(value => value === params.get('theme')) ?? 'system',
  fonts: params.get('fonts') === 'system' ? 'system' : 'bundled',
  spatialLoader: params.get('spatial') === '1' ? loadSpatial : null,
};
if (options.theme !== 'system') document.documentElement.dataset.theme = options.theme;
if (params.get('text') === '200') document.documentElement.style.fontSize = '200%';

const INSTALLED = INSTALLED_TEMPLATES.map(item => item.templateId);
const requested = params.get('template');
const template = requested === null ? quadraticGradientDescentTemplate : INSTALLED_TEMPLATES.find(item => item.templateId === requested) ?? null;
const flow: 'scripted' | 'generic' = template?.templateId === quadraticGradientDescentTemplate.templateId && params.get('flow') !== 'generic' ? 'scripted' : 'generic';
const session: FixtureSession | GenericSession | null = !template ? null : flow === 'scripted' ? new FixtureSession(options)
  : new GenericSession({ ...options, templateId: template.templateId, policy: params.get('policy') === 'full' ? 'full' : 'held' });
if (template && flow === 'generic') document.title = `${template.title} · Study Harness integration fixture`;
type Snapshot = SessionSnapshot | GenericSnapshot;
const groupLabel = (id: string): string => template?.groups.find(group => group.id === id)?.label ?? id;

// ---------------------------------------------------------------------------------------------
// Host chrome
// ---------------------------------------------------------------------------------------------
function Messages({ messages, scripted }: { messages: Snapshot['messages']; scripted: boolean }) {
  return (
    <section className="fx-section" aria-labelledby="fx-messages-title">
      <h2 id="fx-messages-title" className="fx-h2">Session <span className="fx-tag">{scripted ? 'scripted' : 'host messages'}</span></h2>
      <ol className="fx-messages" aria-live="polite">
        {messages.map(message => (
          <li key={message.id} className="fx-message" data-kind={message.kind}>
            <span className="fx-message-from">{message.kind === 'scripted' ? 'Scripted tutor message (fixture)' : scripted ? 'Host' : 'Host message (fixture)'}</span>
            <p>{message.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Composer({ scripted, composer, status }: { scripted: FixtureSession; composer: NonNullable<SessionSnapshot['composer']>; status: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const ok = await scripted.submitResponse(text);
    setBusy(false);
    if (ok) setText('');
  };
  return (
    <form className="fx-section fx-composer" aria-labelledby="fx-composer-title" onSubmit={submit} data-fx-composer={composer.kind}>
      <h2 id="fx-composer-title" className="fx-h2">{composer.label} <span className="fx-tag">host composer</span></h2>
      <label htmlFor="fx-response" className="fx-label">{composer.prompt}</label>
      <textarea id="fx-response" className="fx-textarea" rows={3} value={text} onChange={event => setText(event.currentTarget.value)} />
      <div className="fx-row">
        <button type="submit" className="fx-button fx-primary" aria-disabled={busy || undefined}>Submit {composer.label.toLowerCase().replace(/^your /, '')}</button>
        <span className="fx-status" role="status">{status}</span>
      </div>
      <p className="fx-note">The text stays with the host; the activity receives only a response reference.</p>
    </form>
  );
}

function StepButtons({ scripted, snapshot }: { scripted: FixtureSession; snapshot: SessionSnapshot }) {
  const [result, setResult] = useState('');
  const run = async (step: StepId) => {
    setResult(`${STEP_LABELS[step]}…`);
    const failure = await scripted.runStep(step);
    setResult(failure ? `${STEP_LABELS[step]}: ${failure}` : `${STEP_LABELS[step]}: done.`);
  };
  const stateText: Record<SessionSnapshot['steps'][number]['state'], string> = { done: 'Done', next: 'Ready', blocked: 'Waiting', later: 'Later', running: 'Running' };
  return (
    <section className="fx-section" aria-labelledby="fx-steps-title">
      <h2 id="fx-steps-title" className="fx-h2">Host stage controls</h2>
      <ol className="fx-steps">
        {snapshot.steps.map(step => {
          const enabled = step.state === 'next' && snapshot.phase === 'running';
          const resume = snapshot.interruptedStep === step.id && step.state === 'next';
          return (
            <li key={step.id} data-state={step.state}>
              <button type="button" className={`fx-button${enabled ? ' fx-primary' : ''}`} aria-disabled={!enabled || undefined}
                data-fx-step={step.id} onClick={() => { if (enabled) void run(step.id); }}>
                {resume ? `Resume: ${step.label}` : step.label}
              </button>
              <span className="fx-step-state">{stateText[step.state]}{step.reason ? ` — ${step.reason}` : ''}</span>
            </li>
          );
        })}
      </ol>
      <p className="fx-status" role="status">{result}</p>
    </section>
  );
}

/** Generic host controls: transitions out of the current stage, one reveal per solution-bearing group, host actions. */
function GenericControls({ generic, snapshot }: { generic: GenericSession; snapshot: GenericSnapshot }) {
  const stateText = (control: GenericControl, done: string): string =>
    control.state === 'running' ? 'Running' : control.state === 'done' ? done : control.state === 'blocked' ? `Unavailable — ${control.reason}` : 'Available';
  const item = (control: GenericControl, done: string, attributes: Record<string, string>, run: () => Promise<DriverResult>, enabledWhenDone = false) => {
    const enabled = control.state === 'next' || (control.state === 'done' && enabledWhenDone);
    return (
      <li key={control.id} data-state={control.state}>
        <button type="button" className="fx-button" aria-disabled={!enabled || undefined} {...attributes} onClick={() => { if (enabled) void run().catch(() => undefined); }}>{control.label}</button>
        <span className="fx-step-state">{stateText(control, done)}</span>
      </li>
    );
  };
  const actions: Record<GenericSnapshot['actions'][number]['id'], () => Promise<DriverResult>> = {
    'authorize-exploration': () => generic.authorizeExploration(), 'enter-independent': () => generic.enterIndependent(), reopen: () => generic.reopen(),
    'save-backup': () => generic.save('backup'), 'save-snapshot': () => generic.save('learner-snapshot'), close: () => generic.close(),
  };
  return (
    <section className="fx-section" aria-labelledby="fx-generic-title">
      <h2 id="fx-generic-title" className="fx-h2">Host stage controls <span className="fx-tag">generated from the template</span></h2>
      <p className="fx-note" data-fx-stage={snapshot.stage ?? ''}>
        {snapshot.closed ? 'The activity is closed.' : snapshot.stage ? <>Stage <strong>{snapshot.stage}</strong>, {snapshot.context} context.</> : 'No activity is open.'}
      </p>
      <h3 className="fx-h3" id="fx-transitions-title">Stage transitions</h3>
      {snapshot.steps.length ? (
        <ol className="fx-steps" aria-labelledby="fx-transitions-title">
          {snapshot.steps.map(step => item(step, 'Done', { 'data-fx-transition': step.toStage }, () => generic.transition(step.toStage)))}
        </ol>
      ) : <p className="fx-note">No transition leaves the current stage.</p>}
      <h3 className="fx-h3" id="fx-reveals-title">Reveal requests (solution-bearing groups)</h3>
      <ol className="fx-steps" aria-labelledby="fx-reveals-title">
        {snapshot.reveals.map(reveal => item(reveal, 'Shown', { 'data-fx-reveal': reveal.groupId }, () => generic.reveal(reveal.groupId)))}
      </ol>
      <h3 className="fx-h3" id="fx-actions-title">Host actions</h3>
      <ol className="fx-steps" aria-labelledby="fx-actions-title">
        {snapshot.actions.map(action => item(action, 'Authorized for this stage', { 'data-fx-action': action.id }, actions[action.id], true))}
      </ol>
      <p className="fx-status" role="status">{snapshot.lastResult}</p>
    </section>
  );
}

function FixtureControls({ runtime }: { runtime: FixtureSession | GenericSession }) {
  const [crash, setCrash] = useState<CrashPoint>('before-intent');
  const [capture, setCapture] = useState<{ text: string; url: string | null } | null>(null);
  useEffect(() => () => { if (capture?.url) URL.revokeObjectURL(capture.url); }, [capture]);
  const doCapture = async (format: 'svg' | 'png') => {
    try {
      const result = await runtime.capture(format);
      const blob = result.mimeType === 'image/png' ? new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }) : new Blob([result.svg], { type: 'image/svg+xml' });
      setCapture({ text: `${format.toUpperCase()} ${result.width}×${result.height} of view “${result.metadata.viewId}” from surface ${result.metadata.surfaceId} (frame ${result.metadata.frameId.slice(0, 18)}…).`, url: URL.createObjectURL(blob) });
    } catch (error) { setCapture({ text: `Capture not taken: ${error instanceof Error ? error.message : String(error)}`, url: null }); }
  };
  const fail = (point: InjectionPoint) => runtime.host.failNext(point);
  const scripted = runtime instanceof FixtureSession ? runtime : null;
  return (
    <details className="fx-section" open>
      <summary className="fx-h2">Fixture controls (fault injection)</summary>
      <div className="fx-grid">
        <button type="button" className="fx-button" onClick={() => fail('exposure-intent')}>Fail next reveal intent</button>
        <button type="button" className="fx-button" onClick={() => fail('display-ack')}>Fail next display acknowledgement</button>
        <button type="button" className="fx-button" onClick={() => fail('append')}>Fail next journal append</button>
        <button type="button" className="fx-button" onClick={() => fail('save')}>Fail next save</button>
        <button type="button" className="fx-button" onClick={() => void runtime.retry()}>Retry pending host request</button>
        <button type="button" className="fx-button" onClick={() => void runtime.revokePolicy()}>Revoke policy now</button>
        <button type="button" className="fx-button" onClick={() => runtime.revokeCatalogue()}>Revoke template in catalogue</button>
        {scripted ? (
          <>
            <button type="button" className="fx-button" onClick={() => void scripted.interruptWithIndependentTask()}>Interrupt: independent task here</button>
            <button type="button" className="fx-button" onClick={() => void scripted.reopenInstructional()}>Reopen teaching visual (assistance)</button>
            <button type="button" className="fx-button" onClick={() => void scripted.saveNow('backup')}>Save backup now</button>
            <button type="button" className="fx-button" onClick={() => void scripted.saveNow('learner-snapshot')}>Save learner snapshot</button>
          </>
        ) : null}
        <button type="button" className="fx-button" onClick={() => void doCapture('svg')}>Capture SVG</button>
        <button type="button" className="fx-button" onClick={() => void doCapture('png')}>Capture PNG</button>
      </div>
      <div className="fx-row">
        <label className="fx-label" htmlFor="fx-crash">Crash point</label>
        <select id="fx-crash" className="fx-select" value={crash} onChange={event => setCrash(event.currentTarget.value as CrashPoint)}>
          {CRASH_POINTS.map(point => <option key={point} value={point}>{point}</option>)}
        </select>
        <button type="button" className="fx-button" onClick={() => runtime.host.armCrash(crash)}>Arm crash</button>
      </div>
      <div className="fx-row">
        <button type="button" className="fx-button" onClick={() => location.reload()}>Restart host (reload tab)</button>
        {runtime instanceof GenericSession ? <button type="button" className="fx-button" onClick={() => void runtime.restartHost().catch(() => undefined)}>Restart host (in page)</button> : null}
        {runtime instanceof GenericSession ? <button type="button" className="fx-button" onClick={() => void runtime.revokeCatalogueAndRestart().catch(() => undefined)}>Revoke template in catalogue and restart</button> : null}
        <button type="button" className="fx-button" onClick={() => { runtime.host.clear(); location.replace(location.pathname + location.search); }}>Clear fixture session</button>
      </div>
      {capture ? (
        <div className="fx-capture" role="status">
          <p>{capture.text}</p>
          {capture.url ? <img src={capture.url} alt="Captured view of the learner card" className="fx-capture-image" /> : null}
        </div>
      ) : null}
    </details>
  );
}

function HostTables({ runtime, snapshot }: { runtime: FixtureSession | GenericSession; snapshot: Snapshot }) {
  const activityId = snapshot.activityId;
  const host = runtime.host;
  const record = activityId ? host.activity(activityId) : null;
  const policy = activityId ? host.policy(activityId) : null;
  const exposures = activityId ? host.exposures(activityId) : [];
  const injections = host.injections();
  const approved = runtime.approvedEntry();
  return (
    <details className="fx-section" open>
      <summary className="fx-h2">Host tables <span className="fx-tag">sessionStorage, not authoritative</span></summary>
      <dl className="fx-facts">
        <div><dt>Activity</dt><dd>{activityId ?? 'none open'}</dd></div>
        <div><dt>Template</dt><dd>{approved.template.templateId}@{approved.template.version}</dd></div>
        {snapshot.kind === 'generic' ? (
          <div><dt>Policy (fixture decision)</dt><dd data-fx-policy={snapshot.policyMode}>approves exactly this template and model (computed catalogue references); {snapshot.mode === 'free' ? 'free exploration: every group within the ceiling' : snapshot.policyMode === 'held' ? 'solution-bearing groups held back until revealed' : 'every group within the ceiling'}</dd></div>
        ) : null}
        <div><dt>Host stage / revision</dt><dd>{record ? `${record.stage} / ${record.activityRevision}` : '—'}</dd></div>
        <div><dt>Policy revision</dt><dd>{policy ? `${policy.revision}${policy.revoked ? ' (revoked)' : ''}${policy.independentTask.active ? ' (independent task)' : ''}` : '—'}</dd></div>
        <div><dt>Journal cursor</dt><dd>{record ? record.lastSequence : '—'}</dd></div>
        <div><dt>Host session revision</dt><dd>{host.hostSessionRevision}</dd></div>
        <div><dt>Host starts</dt><dd>{host.starts}</dd></div>
        <div><dt>Workers created / terminated</dt><dd>{runtime.workers.created} / {runtime.workers.terminated}</dd></div>
        <div><dt>Spatial renderer loader</dt><dd>{options.spatialLoader ? 'passed (lazy)' : 'none (2D projection)'}</dd></div>
        <div><dt>Armed injections</dt><dd>{[...Object.entries(injections.fail).map(([point, n]) => `fail ${point}×${n}`), ...Object.entries(injections.delay).map(([point, ms]) => `delay ${point} ${ms} ms`), ...Object.entries(injections.lag).map(([point, ms]) => `late reply ${point} ${ms} ms`), ...(injections.crash ? [`crash ${injections.crash}`] : [])].join(', ') || 'none'}</dd></div>
      </dl>
      <h3 className="fx-h3">Exposure records</h3>
      {exposures.length ? (
        <ul className="fx-list" data-fx-exposures="">
          {exposures.map(exposure => (
            <li key={exposure.exposureId} data-status={exposure.displayStatus}>
              {exposure.scope}: {exposure.groups.map(group => groupLabel(group.groupId)).join(', ')} — <strong>{exposure.displayStatus}</strong>
              {exposure.uncertainty ? ` (${exposure.uncertainty.code})` : ''}{host.displayAcked(activityId!, exposure.exposureId) ? ', acknowledgement persisted' : ''}
            </li>
          ))}
        </ul>
      ) : <p className="fx-note">None.</p>}
      <h3 className="fx-h3">Responses (host-owned)</h3>
      {host.responses().length ? (
        <ul className="fx-list">{host.responses().map(entry => <li key={entry.ref.responseId}>{entry.ref.kind} {entry.ref.responseId}{entry.snapshotCursor !== null ? ` · assistance snapshot at event ${entry.snapshotCursor}` : ''}</li>)}</ul>
      ) : <p className="fx-note">None.</p>}
      {snapshot.restoredNotes.length ? <><h3 className="fx-h3">Restore notes</h3><ul className="fx-list">{snapshot.restoredNotes.map(note => <li key={note}>{note}</li>)}</ul></> : null}
      <h3 className="fx-h3" id="fx-log-title">Host log</h3>
      <div className="fx-log" role="region" aria-labelledby="fx-log-title" tabIndex={0}>
        <ul className="fx-list">{snapshot.hostLog.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ul>
      </div>
    </details>
  );
}

function Banner({ scripted }: { scripted: boolean }) {
  return (
    <header className="fx-banner" role="note">
      {scripted ? (
        <>
          <strong>Integration fixture — not a tutor.</strong> This page plays a Study Harness host for the quadratic learning-and-return
          conformance sequence. Tutor messages are scripted; responses are not evaluated; host tables live in this tab’s sessionStorage
          to simulate a restart and are not an authoritative learning database. Nothing here is evidence of learning benefit.
        </>
      ) : (
        <>
          <strong>Integration fixture — not a tutor.</strong> This page plays a Study Harness host around the learner card with generic host
          controls generated from the template. There are no tutor messages and no task content; responses are not evaluated; host tables live
          in this tab’s sessionStorage to simulate a restart and are not an authoritative learning database. Nothing here is evidence of learning benefit.
        </>
      )}
    </header>
  );
}

function App({ runtime }: { runtime: FixtureSession | GenericSession }) {
  const snapshot: Snapshot = useSyncExternalStore<Snapshot>(runtime.subscribe, runtime.getSnapshot);
  const cardRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !cardRef.current) return;
    started.current = true;
    void runtime.start(cardRef.current).then(() => { document.body.dataset.fixtureReady = 'true'; });
  }, [runtime]);
  const scripted = runtime instanceof FixtureSession ? runtime : null;
  const generic = runtime instanceof GenericSession ? runtime : null;
  const title = snapshot.kind === 'scripted' ? `Quadratic learning-and-return ${snapshot.mode === 'free' ? '(free exploration)' : ''}`
    : `${snapshot.title} ${snapshot.mode === 'free' ? '(free exploration)' : '(generic host flow)'}`;
  return (
    <>
      <Banner scripted={!!scripted} />
      <div className="fx-layout">
        <main className="fx-main" aria-labelledby="fx-title">
          <h1 id="fx-title" className="fx-h1">{title}</h1>
          <Messages messages={snapshot.messages} scripted={!!scripted} />
          {snapshot.phase === 'crashed' ? (
            <div className="fx-alert" role="alert">
              <p><strong>Host process terminated.</strong> {snapshot.error}</p>
              <button type="button" className="fx-button fx-primary" onClick={() => location.reload()}>Relaunch the host</button>
            </div>
          ) : snapshot.phase === 'failed' ? <div className="fx-alert" role="alert"><p><strong>The fixture could not start.</strong> {snapshot.error}</p></div> : null}
          {!snapshot.cardMounted && snapshot.phase === 'running' ? <p className="fx-note" data-fx-no-card="">No learner card is open.</p> : null}
          <div className="fx-card" ref={cardRef} data-fx-card="" style={width ? { width: `${width}px` } : undefined} />
          {scripted && snapshot.kind === 'scripted' && snapshot.composer ? <Composer key={snapshot.composer.kind} scripted={scripted} composer={snapshot.composer} status={snapshot.composerStatus} /> : null}
          {snapshot.kind === 'scripted' && snapshot.complete ? <p className="fx-status" data-fx-complete="">Fixture sequence complete.</p> : null}
        </main>
        <aside className="fx-host" aria-label="Host and fixture controls (not part of the learner experience)">
          {scripted && snapshot.kind === 'scripted' ? <StepButtons scripted={scripted} snapshot={snapshot} /> : null}
          {generic && snapshot.kind === 'generic' ? <GenericControls generic={generic} snapshot={snapshot} /> : null}
          <FixtureControls runtime={runtime} />
          <HostTables runtime={runtime} snapshot={snapshot} />
        </aside>
      </div>
    </>
  );
}

function UnknownTemplate() {
  useEffect(() => { document.body.dataset.fixtureReady = 'failed'; }, []);
  return (
    <>
      <Banner scripted={false} />
      <main className="fx-main" aria-labelledby="fx-title">
        <h1 id="fx-title" className="fx-h1">Unknown template</h1>
        <div className="fx-alert" role="alert">
          <p><strong>No installed template has the ID “{requested}”.</strong> Installed templates:</p>
          <ul className="fx-list">{INSTALLED.map(id => <li key={id}><a href={`?template=${encodeURIComponent(id)}`}>{id}</a></li>)}</ul>
        </div>
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Programmatic hooks for browser tests (fixture page only)
// ---------------------------------------------------------------------------------------------
const generic = session instanceof GenericSession ? session : null;
const genericOnly = (name: string): Promise<never> => Promise.reject(new Error(
  `${name}() belongs to the generic driver; the scripted quadratic flow is driven by its host steps (open ?flow=generic to drive the quadratic template generically).`));
const requireSession = (): FixtureSession | GenericSession => { if (!session) throw new Error(`No installed template has the ID ${JSON.stringify(requested)}.`); return session; };

const hooks = {
  session, options,
  /** Selected template ID, flow and every installed template ID. */
  templateId: template?.templateId ?? null,
  flow,
  installed: INSTALLED,
  /** Selected template (installed content) and the catalogue's computed template and model references the fixture policy approves. */
  get template() { return session?.template ?? null; },
  get refs() { return session?.approvedEntry() ?? null; },
  get host() { return requireSession().host; },
  get adapter() { return requireSession().adapter; },
  get catalog() { return requireSession().catalog; },
  get prepared() { return session?.prepared ?? null; },
  get binding() { return session?.binding ?? null; },
  get surface() { return session?.surface ?? null; },
  /** Worker fault injection: set `drop` to drop that many kernel-worker replies (the evaluator watchdog then times out). */
  workerFaults,
  get projectionLog() { return session?.projectionLog ?? []; },
  get diagnostics() { return session?.diagnostics ?? []; },
  /** Host-audience state of the open activity (JSON). */
  state() { const id = session?.prepared?.activityId; if (!session || !id) return null; const state = session.adapter.getState(id, 'host'); return JSON.parse(JSON.stringify(state)); },
  /** Frozen assistance snapshot the adapter holds for a submitted response (never rewritten later). */
  frozen(responseId: string) { return session?.prepared ? JSON.parse(JSON.stringify(session.prepared.host.freezeAssistanceSnapshot({ responseId }))) : null; },
  /** Schema validation of a record with the shared activity schemas (diagnostics are empty when valid). */
  validate(contract: string, record: unknown) { return validateRecord(contract as SchemaName, record).diagnostics; },
  /** Capture of the mounted card as JSON (PNG bytes as base64). */
  async capture(format: 'svg' | 'png', viewId?: string) {
    const result = await requireSession().capture(format, viewId);
    const { companionText, metadata, width: w, height: h, mimeType, fonts } = result;
    if (result.mimeType === 'image/svg+xml') return { companionText, metadata, width: w, height: h, mimeType, fonts, svg: result.svg };
    let binary = '';
    for (const byte of result.bytes) binary += String.fromCharCode(byte);
    return { companionText, metadata, width: w, height: h, mimeType, fonts, pngBase64: btoa(binary) };
  },

  // ---- generic driver: each call resolves after the host round trip and the display acknowledgement settled ----
  transition: (toStage: string): Promise<DriverResult> => generic ? generic.transition(toStage) : genericOnly('transition'),
  reveal: (groupId: string): Promise<DriverResult> => generic ? generic.reveal(groupId) : genericOnly('reveal'),
  authorizeExploration: (): Promise<DriverResult> => generic ? generic.authorizeExploration() : genericOnly('authorizeExploration'),
  enterIndependent: (): Promise<DriverResult> => generic ? generic.enterIndependent() : genericOnly('enterIndependent'),
  reopen: (): Promise<DriverResult> => generic ? generic.reopen() : genericOnly('reopen'),
  close: (): Promise<DriverResult> => generic ? generic.close() : genericOnly('close'),
  /** Host-owned response for the current request (same path as the composer in the card's response slot). */
  respond: (text: string): Promise<DriverResult> => generic ? generic.respond(text) : genericOnly('respond'),
  /** In-page host restart from the latest checkpoint (the scripted flow restarts by reloading the tab). */
  restartHost: (): Promise<DriverResult> => generic ? generic.restartHost() : genericOnly('restartHost'),
  /** Fixture host action: revoke the open template in the installed catalogue; the card turns `unsupported` at the next command. */
  revokeCatalogue: () => requireSession().revokeCatalogue(),
  /** Fixture host action: revoke the selected template in the installed catalogue, then restart; the refused restore shows the archival record. */
  revokeCatalogueAndRestart: (): Promise<DriverResult> => generic ? generic.revokeCatalogueAndRestart() : genericOnly('revokeCatalogueAndRestart'),
  /** Archival read-only record (learner audience) shown after a refused restore, as JSON; null when none is shown. */
  archival: () => session?.archival ? JSON.parse(JSON.stringify(session.archival)) : null,
  /** Saves a backup or learner snapshot through the host (both flows). */
  async save(kind: ActivityArtifact['kind'] = 'backup') {
    if (generic) return generic.save(kind);
    const runtime = requireSession();
    const saved = await runtime.saveNow(kind);
    await runtime.settle();
    return { ok: saved.ok, codes: saved.ok ? [] : (saved.codes ?? 'NOT_READY').split(', '), message: saved.ok ? `Saved ${kind} ${saved.artifactId}.` : `Not saved (${saved.codes}).`, artifactId: saved.artifactId };
  },
  /** Resolves when the open activity has settled (no reveal pending, journal saved, card current, acknowledgements persisted). */
  settle: (timeoutMs?: number) => requireSession().settle(timeoutMs),
  /** Host journal and host exposure records (with `acked`) of the open or last opened activity; the learner projection as JSON. */
  events: () => requireSession().events(),
  exposures: () => requireSession().exposures(),
  projection: () => requireSession().projection(),
};
Object.assign(window, { studyHarnessFixture: hooks });

createRoot(document.getElementById('fx-app')!).render(session ? <App runtime={session} /> : <UnknownTemplate />);
