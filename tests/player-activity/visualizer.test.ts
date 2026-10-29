/**
 * `createStudyHarnessVisualizer` (report §5.3): the six operations as one API, mounting only activities it prepared,
 * error hooks, and idempotent disposal that aborts pending requests, stops workers and invalidates pending surface
 * responses. Real adapter, catalogue and quadratic kernel with in-process test workers and the test-only memory host;
 * the surface mounter here is a TEST DOUBLE (no DOM in this runner). Real browser mounting is exercised by
 * tests/browser/study-function-derivative.spec.ts (fixture-host results only).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createStudyHarnessAdapter, type ActivityBinding, type PreparedActivity } from '../../packages/activity/src/index';
import { createInstalledCatalog, INSTALLED_KERNELS } from '../../packages/catalog/src/index';
import {
  CaptureError, createStudyHarnessVisualizer, VisualizerError,
  type CaptureResult, type MountedStudyActivity, type StudyActivitySurfaceProps, type StudyHarnessVisualizer, type SurfaceErrorEvent,
} from '../../packages/player/src/activity/index';
import { inlineWorkers, until, type WorkerGroup } from '../core/support/inline-worker';
import { activityGuard, op, policyFor, requestFor } from '../activity/support/adapter-harness';
import { MemoryHost } from '../activity/support/memory-host';

/** TEST DOUBLE surface mounter: records props and lets a test hold captures; no DOM. */
interface FakeMount { props: StudyActivitySurfaceProps; disposals: number; pendingCapture: { resolve(value: CaptureResult): void } | null }
function fakeMounter() {
  const mounts: FakeMount[] = [];
  const mountSurface = (_container: HTMLElement, props: StudyActivitySurfaceProps): MountedStudyActivity => {
    const record: FakeMount = { props, disposals: 0, pendingCapture: null };
    mounts.push(record);
    return {
      element: { tagName: 'DIV' } as unknown as HTMLElement, surfaceId: props.surfaceId!, ready: Promise.resolve(),
      capture: () => new Promise<CaptureResult>(resolve => { record.pendingCapture = { resolve }; }),
      dispose: () => { record.disposals++; },
    };
  };
  return { mounts, mountSurface };
}
const container = { appendChild: () => undefined, ownerDocument: {} } as unknown as HTMLElement;

let workers: WorkerGroup, host: MemoryHost, visualizer: StudyHarnessVisualizer | null = null;
afterEach(() => { visualizer?.dispose(); visualizer = null; });
function setup(options: { policy?: Parameters<typeof policyFor>[0] } = {}) {
  workers = inlineWorkers(INSTALLED_KERNELS);
  host = new MemoryHost({ policy: policyFor(options.policy) });
  const catalog = createInstalledCatalog({ workerFactory: workers.factory });
  const fake = fakeMounter();
  const diagnostics: string[] = [];
  visualizer = createStudyHarnessVisualizer({
    catalog, host, maxWorkers: 2, mountSurface: fake.mountSurface,
    surfaceDefaults: { theme: 'dark', fonts: 'system', headingLevel: 3, onDiagnostic: diagnostic => diagnostics.push(`${diagnostic.source}:${diagnostic.code}`) },
  });
  return { visualizer, fake, diagnostics, catalog };
}
async function prepared(v: StudyHarnessVisualizer, activityId = 'act-quadratic-1'): Promise<PreparedActivity> {
  const result = await v.prepare(requestFor({ activityId }), { operationId: op('prepare') });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.prepared;
}
const quiet = async (activityId = 'act-quadratic-1') => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await until(() => { const state = visualizer!.getState(activityId, 'host'); return !('persistence' in state) || state.persistence !== 'saving'; });
};

describe('createStudyHarnessVisualizer: the six operations', () => {
  it('reports capabilities, validates without activating, prepares, mounts with defaults, reads state and summarizes', async () => {
    const { visualizer: v, fake, catalog } = setup();
    const reference = createStudyHarnessAdapter({ catalog, host, maxWorkers: 2 });
    expect(v.getCapabilities()).toEqual(reference.getCapabilities());
    reference.dispose();

    const report = await v.validate(requestFor({ activityId: 'act-validate' }));
    expect(report).toMatchObject({ ok: true, diagnostics: [] });
    expect(Object.keys(report.defaults!.statuses).length).toBeGreaterThan(0);
    expect(host.calls('registerActivity')).toHaveLength(0);
    expect(v.getState('act-validate', 'host')).toMatchObject({ ok: false, diagnostics: [{ code: 'NOT_FOUND' }] });
    const invalid = await v.validate(requestFor({ template: { templateId: 'no-such-template', version: '1.0.0' } }));
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics.map(item => item.code)).toEqual(['INVALID_REFERENCE']);

    const activity = await prepared(v);
    const surface = v.render(container, activity, { surfaceId: 'surface-a', fonts: 'bundled' });
    await surface.ready;
    expect(surface).toMatchObject({ surfaceId: 'surface-a', activityId: 'act-quadratic-1', disposed: false });
    const props = fake.mounts[0]!.props;
    // Defaults apply, per-mount options override them, and the surface receives a learner binding for its own ID.
    expect(props).toMatchObject({ theme: 'dark', fonts: 'bundled', headingLevel: 3, surfaceId: 'surface-a' });
    expect(props.binding.actor).toBe('learner');
    expect(props.binding.activityId).toBe('act-quadratic-1');

    const learner = v.getState('act-quadratic-1', 'learner');
    expect(learner).toMatchObject({ audience: 'learner', activityId: 'act-quadratic-1', committed: true });
    expect('scientific' in learner).toBe(false);
    expect(v.getState('act-quadratic-1', 'host')).toHaveProperty('scientific');
    await quiet();
    const first = v.summarizeInteraction('act-quadratic-1', { audience: 'tutor' });
    expect(first).toMatchObject({ audience: 'tutor', activityId: 'act-quadratic-1' });
    expect(JSON.stringify(v.summarizeInteraction('act-quadratic-1', { audience: 'tutor' }))).toBe(JSON.stringify(first));
    const sampled = await v.sample({ activityId: 'act-quadratic-1', parameters: { a: 1, eta: 0.5, x0: 4 }, positions: [{ kind: 'index', index: 2 }], audience: 'host' });
    expect(sampled, JSON.stringify(sampled).slice(0, 400)).toMatchObject({ ok: true });
  });

  it('mounts only activities it prepared or restored and that are still open', async () => {
    const { visualizer: v, fake } = setup();
    const activity = await prepared(v);
    const other = createStudyHarnessAdapter({ catalog: createInstalledCatalog({ workerFactory: workers.factory }), host });
    const foreign = await other.prepare(requestFor({ activityId: 'act-foreign' }), { operationId: op('prepare') });
    expect(foreign.ok).toBe(true);
    const refused = (run: () => unknown): VisualizerError => { try { run(); } catch (error) { return error as VisualizerError; } throw new Error('expected a refusal'); };
    expect(refused(() => v.mount(container, (foreign as { prepared: PreparedActivity }).prepared))).toMatchObject({ name: 'VisualizerError', code: 'INVALID_REFERENCE' });
    expect(() => v.mount(null as unknown as HTMLElement, activity)).toThrow(TypeError);
    other.dispose();

    const surface = v.mount(container, activity);
    v.dispose('act-quadratic-1');
    expect(surface.disposed).toBe(true);
    expect(fake.mounts[0]!.disposals).toBe(1);
    expect(refused(() => v.mount(container, activity))).toMatchObject({ code: 'NOT_FOUND' });
    expect(v.getState('act-quadratic-1', 'learner')).toMatchObject({ ok: false });
    v.dispose();
    expect(refused(() => v.mount(container, activity))).toMatchObject({ code: 'DISPOSED' });
  });

  it('reports refused learner commands and attention states through the error hook, never after disposal', async () => {
    const { visualizer: v, fake, diagnostics } = setup();
    const activity = await prepared(v);
    const events: SurfaceErrorEvent[] = [];
    const extra: SurfaceErrorEvent[] = [];
    const surface = v.mount(container, activity, { onError: event => events.push(event) });
    const stop = surface.onError(event => extra.push(event));
    const props = fake.mounts[0]!.props;
    props.onDiagnostic!({ source: 'surface', code: 'LABEL_OVERLAP', message: 'Label overlaps.' });
    props.onDiagnostic!({ source: 'binding', code: 'CONSTRAINT_VIOLATION', message: 'That combination of values is outside what this model allows.' });
    props.onDiagnostic!({ source: 'surface', code: 'MATH_ASSETS_UNAVAILABLE', message: 'Math assets unavailable.' });
    // Presentation fallbacks reach onDiagnostic only; failures reach the error hook too.
    expect(diagnostics).toEqual(['surface:LABEL_OVERLAP', 'binding:CONSTRAINT_VIOLATION', 'surface:MATH_ASSETS_UNAVAILABLE']);
    expect(events.map(event => event.kind === 'diagnostic' ? event.diagnostic.code : event.state)).toEqual(['CONSTRAINT_VIOLATION', 'MATH_ASSETS_UNAVAILABLE']);
    expect(extra).toHaveLength(2);
    stop();

    await quiet();
    const revoked = await activity.host.revoke({ operationId: op('revoke'), reason: 'Test revocation.' });
    expect(revoked.ok).toBe(true);
    await until(() => events.some(event => event.kind === 'state'));
    const state = events.find(event => event.kind === 'state')!;
    expect(state).toMatchObject({ kind: 'state' });
    expect(['stale-policy', 'unsupported']).toContain((state as { state: string }).state);
    expect(extra).toHaveLength(2);

    surface.dispose();
    surface.dispose();
    expect(fake.mounts[0]!.disposals).toBe(1);
    const count = events.length;
    props.onDiagnostic!({ source: 'binding', code: 'CONFLICT', message: 'Late.' });
    props.onRecoveryAction?.('reload');
    expect(events).toHaveLength(count);
    expect(diagnostics).toHaveLength(3);
  });
});

describe('createStudyHarnessVisualizer: disposal', () => {
  it('is idempotent, disposes surfaces, stops workers and invalidates pending captures', async () => {
    const { visualizer: v, fake } = setup();
    const activity = await prepared(v);
    const surface = v.mount(container, activity);
    const second = v.mount(container, activity, { surfaceId: 'surface-second' });
    expect(workers.live).toBeGreaterThan(0);
    const capture = surface.capture({ format: 'svg' });
    expect(fake.mounts[0]!.pendingCapture).not.toBeNull();
    v.dispose();
    v.dispose();
    expect(v.disposed).toBe(true);
    expect(surface.disposed && second.disposed).toBe(true);
    expect(fake.mounts.map(mount => mount.disposals)).toEqual([1, 1]);
    await expect(capture).rejects.toMatchObject({ code: 'DISPOSED' });
    // A capture that settles after disposal is discarded, and new captures are refused.
    fake.mounts[0]!.pendingCapture!.resolve({} as CaptureResult);
    await expect(surface.capture({ format: 'png' })).rejects.toBeInstanceOf(CaptureError);
    await until(() => workers.live === 0);
    expect(workers.live).toBe(0);
    expect(v.getState('act-quadratic-1', 'host')).toMatchObject({ ok: false, diagnostics: [{ code: 'DISPOSED' }] });
    expect(v.summarizeInteraction('act-quadratic-1', { audience: 'host' })).toMatchObject({ ok: false, diagnostics: [{ code: 'DISPOSED' }] });
    await expect(v.validate(requestFor())).resolves.toMatchObject({ ok: false, diagnostics: [{ code: 'DISPOSED' }] });
    await expect(v.prepare(requestFor({ activityId: 'act-late' }), { operationId: op('prepare') })).resolves.toMatchObject({ ok: false, diagnostics: [{ code: 'DISPOSED' }] });
    // Capabilities are catalogue facts and remain readable.
    expect(v.getCapabilities().templates.length).toBeGreaterThan(0);
  });

  it('aborts pending validation and preparation and resolves them as DISPOSED without leaving an activity open', async () => {
    const { visualizer: v } = setup();
    workers.hold = true;
    const validation = v.validate(requestFor({ activityId: 'act-pending-validate' }));
    const preparation = v.prepare(requestFor({ activityId: 'act-pending-prepare' }), { operationId: op('prepare') });
    await until(() => workers.received >= 1);
    v.dispose();
    await expect(validation).resolves.toMatchObject({ ok: false, diagnostics: [{ code: 'DISPOSED' }] });
    await expect(preparation).resolves.toMatchObject({ ok: false, diagnostics: [{ code: 'DISPOSED' }] });
    workers.hold = false;
    workers.flush();
    await until(() => workers.live === 0);
    expect(v.getState('act-pending-prepare', 'host')).toMatchObject({ ok: false });
  });

  it('honours the caller abort signal for a pending request without disposing the visualizer', async () => {
    const { visualizer: v } = setup();
    workers.hold = true;
    const controller = new AbortController();
    const validation = v.validate(requestFor({ activityId: 'act-abort' }), controller.signal);
    await until(() => workers.received >= 1);
    controller.abort();
    const result = await validation;
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(item => item.code)).not.toContain('DISPOSED');
    workers.hold = false;
    workers.flush();
    expect(v.disposed).toBe(false);
    const activity = await prepared(v);
    expect(activity.activityId).toBe('act-quadratic-1');
  });

  it('keeps the prepared host control usable for privileged commands of a mounted activity', async () => {
    const { visualizer: v, fake } = setup();
    const activity = await prepared(v);
    v.mount(container, activity);
    const learner: ActivityBinding = fake.mounts[0]!.props.binding;
    learner.registerSurface(fake.mounts[0]!.props.surfaceId!);
    await quiet();
    const moved = await activity.host.requestStageTransition({ operationId: op('stage'), ...activityGuard(learner), toStage: 'explore-step' });
    expect(moved.ok).toBe(true);
    expect(learner.getProjection().stage.id).toBe('explore-step');
  });
});
