/**
 * Document interaction controller (report §9, §18; D11, W08; A39–A43 at unit level). Evaluators are a trusted
 * in-process interpreter seam with an optional hold so ordering, coalescing, stale replies, suspension and disposal can
 * be driven deterministically; the browser worker path is exercised by the showcase and hinged-rod browser specs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDocumentInteractionController, DocumentError, evaluateDocument,
  type DocumentEvaluator, type DocumentInteractionController, type InteractionLeasePurpose, type VisualizationDocument,
} from '../../packages/core/src/declarative/index';
import { createWorkerBudget, type WorkerBudget } from '../../packages/core/src/model/index';

const parametric = (): VisualizationDocument => ({
  schemaVersion: '2.0', id: 'interaction-proof', title: 'Interaction proof', description: 'A bounded analytical test document.',
  parameters: { slope: { label: 'Slope', value: 1, min: -5, max: 5 }, offset: { label: 'Offset', value: 0, min: -2, max: 2 } },
  quantities: { value: { expression: 'slope*2+offset' }, ratio: { expression: 'offset/slope' } },
  views: [{ id: 'values', type: 'values', title: 'Values', quantities: ['value', 'ratio'] }],
  assumptions: ['Test relationship only.'], limitations: ['Not a scientific acceptance fixture.'],
});
const timed = (): VisualizationDocument => ({
  schemaVersion: '2.0', id: 'interaction-time', title: 'Timed proof', description: 'A bounded time-domain test document.',
  parameters: { speed: { label: 'Speed', value: 2, min: 0.1, max: 5 } },
  quantities: { distance: { expression: 'speed*time' } }, time: { end: 0.3, step: 0.1 },
  views: [{ id: 'values', type: 'values', title: 'Values', quantities: ['distance'] }],
  assumptions: ['Test relationship only.'], limitations: ['Not a scientific acceptance fixture.'],
});

interface Held { resolve: () => void; reject: (error: unknown) => void }
/** Interpreter-backed evaluators per purpose; `hold` parks replies until `flush()`; dispose rejects parked work. */
function evaluators() {
  const created: Record<InteractionLeasePurpose, number> = { primary: 0, scratch: 0 };
  const disposed: Record<InteractionLeasePurpose, number> = { primary: 0, scratch: 0 };
  const live = new Set<Held>();
  const control = {
    hold: false, failNext: null as string | null, created, disposed,
    get held() { return live.size; },
    flush() { const pending = [...live]; live.clear(); for (const item of pending) item.resolve(); },
    factory(purpose: InteractionLeasePurpose): DocumentEvaluator {
      created[purpose]++;
      let gone = false;
      const parked = new Set<Held>();
      const failure = () => new DocumentError([{ code: 'DISPOSED', path: '$', message: 'Evaluator has been disposed.' }]);
      return {
        async evaluate(request) {
          if (gone) throw failure();
          if (control.failNext) { const message = control.failNext; control.failNext = null; throw new DocumentError([{ code: 'WORKER_ERROR', path: '$', message }]); }
          if (control.hold) await new Promise<void>((resolve, reject) => { const item = { resolve, reject }; parked.add(item); live.add(item); });
          if (gone) throw failure();
          return evaluateDocument(request);
        },
        dispose() {
          if (gone) return;
          gone = true;
          disposed[purpose]++;
          for (const item of parked) { live.delete(item); item.reject(failure()); }
          parked.clear();
        },
      };
    },
  };
  return control;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) { if (Date.now() - start > timeoutMs) throw new Error('Condition not reached in time.'); await tick(); }
}
const controllers: DocumentInteractionController[] = [];
const budgets: WorkerBudget[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); for (const budget of budgets.splice(0)) budget.dispose(); });
async function make(document = parametric(), options: Parameters<typeof createDocumentInteractionController>[1] = {}) {
  const fakes = evaluators();
  const controller = await createDocumentInteractionController(document, { evaluatorFactory: purpose => fakes.factory(purpose), ...options });
  controllers.push(controller);
  return { controller, fakes };
}
/** Budget whose lease evaluators are never asked to evaluate: the controller only uses leases as worker slots. */
function budget(maxWorkers: number): WorkerBudget {
  const created = createWorkerBudget({ maxWorkers, workerFactory: () => { throw new Error('The lease evaluator must not be used.'); } });
  budgets.push(created);
  return created;
}

describe('primary and scratch sessions', () => {
  it('commits the document on the primary session and creates the scratch session only for a preview', async () => {
    const { controller, fakes } = await make();
    const state = controller.getSnapshot();
    expect(state).toMatchObject({ previewing: false, previewId: null, saving: false, suspended: false, error: null, parameters: { slope: 1, offset: 0 } });
    expect(state.displayed).toEqual({ kind: 'committed', runId: state.rendered.run!.id, version: state.rendered.version });
    expect(controller.inspect().scratch).toBeNull();
    expect(controller.inspect().stats.evaluations).toEqual({ primary: 1, scratch: 0 });
    expect(fakes.created).toEqual({ primary: 1, scratch: 0 });
  });

  it('identifies tentative frames and keeps the primary run until the completion gesture', async () => {
    const { controller } = await make();
    const before = controller.inspect().primary;
    controller.preview({ slope: 2 });
    const previewId = controller.getSnapshot().previewId!;
    expect(previewId).toBeTruthy();
    await until(() => controller.getSnapshot().displayed.kind === 'tentative');
    const first = controller.getSnapshot();
    expect(first.displayed).toMatchObject({ kind: 'tentative', previewId, sequence: 1, baseRunId: before.run!.id });
    expect(first.rendered.frame!.quantities.value).toEqual({ value: 4, status: 'valid' });
    controller.preview({ slope: 3 });
    await until(() => controller.getSnapshot().rendered.run!.params.slope === 3);
    expect(controller.getSnapshot().displayed).toMatchObject({ kind: 'tentative', previewId, sequence: 2 });
    // The primary session is marked tentative: it cannot be exported and its run is unchanged.
    expect(controller.inspect().primary.run).toEqual(before.run);
    expect(() => controller.exportDocument()).toThrow(/Commit or cancel/);
    await controller.commit();
    const after = controller.getSnapshot();
    expect(after).toMatchObject({ previewing: false, previewId: null, saving: false, parameters: { slope: 3, offset: 0 } });
    expect(after.displayed).toEqual({ kind: 'committed', runId: after.rendered.run!.id, version: after.rendered.version });
    expect(after.rendered.run!.id).not.toBe(before.run!.id);
    expect(controller.exportDocument().comparisons).toHaveLength(1);
    controller.preview({ offset: 1 });
    expect(controller.getSnapshot().previewId).not.toBe(previewId);
    controller.cancel();
  });

  it('never exports a scratch run: the artifact is the committed primary experiment', async () => {
    const { controller } = await make();
    controller.preview({ slope: -4 });
    await until(() => controller.getSnapshot().displayed.kind === 'tentative');
    controller.cancel();
    const artifact = controller.exportDocument();
    expect(artifact.run.params).toEqual({ slope: 1, offset: 0 });
    expect(artifact.comparisons).toEqual([]);
  });
});

describe('coalescing and stale replies (A41)', () => {
  it('keeps at most one active preview evaluation and one newest queued value', async () => {
    const { controller, fakes } = await make();
    fakes.hold = true;
    for (let step = 1; step <= 30; step++) controller.preview({ slope: -5 + step * 0.25 });
    await until(() => fakes.held === 1);
    expect(controller.inspect().stats.preview).toMatchObject({ running: true, queued: true });
    fakes.hold = false;
    fakes.flush();
    await until(() => !controller.inspect().stats.preview.running);
    // Scratch creation (one candidate evaluation) + the first value + the newest value; 28 values never reached a worker.
    expect(controller.inspect().stats.evaluations).toEqual({ primary: 1, scratch: 3 });
    expect(controller.getSnapshot().rendered.run!.params.slope).toBe(2.5);
    expect(controller.inspect().primary.run!.params.slope).toBe(1);
    await controller.commit();
    expect(controller.inspect().stats.evaluations).toEqual({ primary: 2, scratch: 3 });
    expect(controller.inspect().primary.run!.params).toEqual({ slope: 2.5, offset: 0 });
  });

  it('cancel restores the committed frame and a late reply never replaces it', async () => {
    const { controller, fakes } = await make();
    const committed = controller.getSnapshot();
    controller.preview({ slope: 4 });
    await until(() => controller.getSnapshot().displayed.kind === 'tentative');
    fakes.hold = true;
    controller.preview({ slope: -3 });
    await until(() => fakes.held === 1);
    const events: string[] = [];
    controller.subscribe(() => events.push(controller.getSnapshot().displayed.kind));
    controller.cancel();
    expect(controller.getSnapshot()).toMatchObject({ previewing: false, previewId: null, parameters: committed.parameters });
    // Same committed run and frame (the session version advanced when the gesture marked and unmarked it tentative).
    expect(controller.getSnapshot().displayed).toMatchObject({ kind: 'committed', runId: committed.rendered.run!.id });
    expect(controller.getSnapshot().rendered.frame).toBe(committed.rendered.frame);
    fakes.hold = false;
    fakes.flush();
    await until(() => !controller.inspect().stats.preview.running);
    await tick();
    expect(events).toEqual(['committed']);
    expect(controller.getSnapshot().rendered.run!.params.slope).toBe(1);
  });

  it('a reply that arrives after the commit cannot replace the committed run', async () => {
    const { controller, fakes } = await make();
    controller.preview({ slope: 2 });
    await until(() => controller.getSnapshot().displayed.kind === 'tentative');
    fakes.hold = true;
    controller.preview({ slope: 3 });
    await until(() => fakes.held === 1);
    const commit = controller.commit();
    // The commit evaluation is parked behind the scratch reply; release both.
    await until(() => fakes.held === 2);
    fakes.hold = false;
    fakes.flush();
    await commit;
    await until(() => !controller.inspect().stats.preview.running);
    const state = controller.getSnapshot();
    expect(state.displayed.kind).toBe('committed');
    expect(state.rendered.run!.params.slope).toBe(3);
    expect(state.rendered.run!.id).toBe(controller.inspect().primary.run!.id);
  });

  it('two controllers never share mutation state', async () => {
    const a = await make(), b = await make(parametric());
    const bBefore = b.controller.getSnapshot();
    a.controller.preview({ slope: 5 });
    await until(() => a.controller.getSnapshot().displayed.kind === 'tentative');
    expect(b.controller.getSnapshot()).toBe(bBefore);
    await b.controller.commit({ offset: 2 });
    expect(a.controller.getSnapshot().previewing).toBe(true);
    expect(a.controller.inspect().primary.run!.params).toEqual({ slope: 1, offset: 0 });
    await a.controller.commit();
    expect(a.controller.inspect().primary.run!.params).toEqual({ slope: 5, offset: 0 });
    expect(b.controller.inspect().primary.run!.params).toEqual({ slope: 1, offset: 2 });
    expect(a.controller.inspect().primary.sessionId).not.toBe(b.controller.inspect().primary.sessionId);
  });
});

describe('explicit commands', () => {
  it('rejects invalid exact input without changing the accepted experiment', async () => {
    const { controller } = await make();
    const before = controller.inspect().primary.run;
    await controller.commit({ slope: 99 });
    expect(controller.getSnapshot().error).toMatch(/slope/);
    expect(controller.getSnapshot().diagnostics?.[0]?.code).toBe('INVALID_PARAMETER');
    expect(controller.inspect().primary.run).toEqual(before);
    controller.preview({ offset: 7 });
    expect(controller.getSnapshot()).toMatchObject({ previewing: false, parameters: { slope: 1, offset: 0 } });
    expect(controller.getSnapshot().error).toMatch(/offset/);
  });

  it('keeps undefined values as statuses with reasons', async () => {
    const { controller } = await make();
    await controller.commit({ slope: 0, offset: 1 });
    const ratio = controller.getSnapshot().rendered.frame!.quantities.ratio;
    expect(ratio.status).toBe('undefined');
    expect(ratio.value).toBeNull();
    expect(ratio.reason).toBeTruthy();
  });

  it('a failed evaluation keeps the last accepted state and reports the failure', async () => {
    const { controller, fakes } = await make();
    const before = controller.inspect().primary;
    fakes.failNext = 'Simulated worker failure';
    await controller.commit({ slope: 2 });
    expect(controller.getSnapshot().error).toMatch('Simulated worker failure');
    expect(controller.inspect().primary.run).toEqual(before.run);
    expect(controller.getSnapshot().rendered.frame).toEqual(before.frame);
    controller.preview({ slope: 3 });
    await until(() => controller.getSnapshot().displayed.kind === 'tentative');
    fakes.failNext = 'Scratch failure';
    controller.preview({ slope: 4 });
    await until(() => !controller.getSnapshot().previewing);
    expect(controller.getSnapshot().error).toMatch('Scratch failure');
    expect(controller.getSnapshot().displayed.kind).toBe('committed');
  });

  it('scrubs time tentatively, commits the scrub as a seek, steps, plays to the exact end and resets as a new run', async () => {
    const { controller } = await make(timed());
    const run = controller.inspect().primary.run!;
    controller.previewTime(0.2);
    await until(() => controller.getSnapshot().rendered.frame!.time === 0.2);
    expect(controller.getSnapshot()).toMatchObject({ previewing: true, previewTime: 0.2 });
    expect(controller.inspect().primary.frame!.time).toBe(0);
    await controller.commit();
    expect(controller.inspect().primary.run!.id).toBe(run.id);
    expect(controller.inspect().primary.frame!.time).toBe(0.2);
    await controller.step();
    expect(controller.inspect().primary.frame).toMatchObject({ time: 0.3, terminal: true });
    await controller.play();
    expect(controller.getSnapshot().rendered.frame!.time).toBe(0);
    await until(() => !controller.inspect().primary.playing, 3000);
    expect(controller.getSnapshot().rendered.frame).toMatchObject({ time: 0.3, terminal: true });
    await controller.commit({ speed: 4 });
    expect(controller.inspect().primary.frame!.time).toBe(0);
    await controller.reset();
    expect(controller.inspect().primary.run!.params).toEqual({ speed: 2 });
    expect(controller.inspect().primary.run!.id).not.toBe(run.id);
  });
});

describe('suspension and the shared worker budget (A42, §18)', () => {
  it('suspension cancels the preview, stops playback, releases workers and resumes paused without catch-up', async () => {
    const { controller, fakes } = await make(timed());
    controller.preview({ speed: 3 });
    await until(() => controller.getSnapshot().displayed.kind === 'tentative');
    expect(controller.inspect().stats.holding).toEqual({ primary: true, scratch: true });
    controller.suspend();
    expect(controller.getSnapshot()).toMatchObject({ suspended: true, previewing: false, previewId: null, parameters: { speed: 2 } });
    expect(controller.getSnapshot().displayed.kind).toBe('committed');
    expect(controller.inspect().stats.holding).toEqual({ primary: false, scratch: false });
    expect(fakes.disposed).toEqual({ primary: 1, scratch: 1 });
    const evaluations = { ...controller.inspect().stats.evaluations };
    controller.preview({ speed: 4 });
    controller.previewTime(0.1);
    await controller.commit({ speed: 5 });
    await controller.play();
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(controller.inspect().stats.evaluations).toEqual(evaluations);
    expect(controller.inspect().primary.run!.params).toEqual({ speed: 2 });
    controller.resume();
    expect(controller.inspect().stats.holding).toEqual({ primary: false, scratch: false });
    // Reactivation acquires computation only for the next evaluation.
    await controller.seek(0.1);
    expect(controller.inspect().stats.holding).toEqual({ primary: true, scratch: false });
    await controller.play();
    await until(() => controller.inspect().primary.frame!.time > 0.1, 3000);
    controller.suspend();
    const position = controller.inspect().primary.frame!.time;
    expect(controller.inspect().primary.playing).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 350));
    controller.resume();
    expect(controller.inspect().primary.playing).toBe(false);
    expect(controller.inspect().primary.frame!.time).toBe(position);
  });

  it('a commit in flight when suspended completes, then the controller is quiet and its worker released', async () => {
    const { controller, fakes } = await make();
    fakes.hold = true;
    const commit = controller.commit({ slope: 2 });
    await until(() => fakes.held === 1);
    controller.suspend();
    expect(controller.getSnapshot().saving).toBe(true);
    expect(controller.inspect().stats.holding.primary).toBe(true);
    fakes.hold = false;
    fakes.flush();
    await commit;
    expect(controller.inspect().primary.run!.params.slope).toBe(2);
    expect(controller.getSnapshot()).toMatchObject({ suspended: true, saving: false, previewing: false });
    expect(controller.inspect().stats.holding.primary).toBe(false);
  });

  it('shares a bounded budget across controllers: leases wait, suspension frees slots, and lease evaluators stay unused', async () => {
    const shared = budget(2);
    const a = await make(parametric(), { budget: shared, ownerId: 'card-a' });
    const b = await make(parametric(), { budget: shared, ownerId: 'card-b' });
    expect(shared.stats().leases).toEqual([{ ownerId: 'card-a', purpose: 'primary' }, { ownerId: 'card-b', purpose: 'primary' }]);
    a.controller.preview({ slope: 2 });
    await until(() => shared.stats().waiting === 1);
    expect(a.controller.getSnapshot().displayed.kind).toBe('committed');
    b.controller.suspend();
    await until(() => a.controller.getSnapshot().displayed.kind === 'tentative');
    expect(shared.stats().leases).toEqual([{ ownerId: 'card-a', purpose: 'primary' }, { ownerId: 'card-a', purpose: 'scratch' }]);
    expect(shared.stats().workers).toBeLessThanOrEqual(2);
    await a.controller.commit();
    a.controller.suspend();
    expect(shared.stats()).toMatchObject({ workers: 0, active: 0, waiting: 0 });
    b.controller.resume();
    await b.controller.commit({ offset: 1 });
    expect(shared.stats().leases).toEqual([{ ownerId: 'card-b', purpose: 'primary' }]);
    b.controller.dispose();
    expect(shared.stats().workers).toBe(0);
  });

  it('a waiting lease request is withdrawn when the card is suspended', async () => {
    const shared = budget(1);
    const a = await make(parametric(), { budget: shared, ownerId: 'card-a' });
    a.controller.preview({ slope: 2 });
    await until(() => shared.stats().waiting === 1);
    a.controller.suspend();
    await until(() => shared.stats().waiting === 0);
    expect(shared.stats().workers).toBe(0);
    expect(a.controller.getSnapshot()).toMatchObject({ previewing: false, error: null });
  });
});

describe('disposal (A43)', () => {
  it('prevents every later visible callback and releases owned evaluators and leases', async () => {
    const shared = budget(4);
    const { controller, fakes } = await make(parametric(), { budget: shared, ownerId: 'card-x' });
    controller.preview({ slope: 2 });
    await until(() => controller.getSnapshot().displayed.kind === 'tentative');
    fakes.hold = true;
    controller.preview({ slope: 3 });
    await until(() => fakes.held === 1);
    let notified = 0;
    controller.subscribe(() => notified++);
    const last = controller.getSnapshot();
    controller.dispose();
    const commit = controller.commit({ slope: 4 });
    fakes.hold = false;
    fakes.flush();
    await commit;
    await tick();
    expect(notified).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({ disposed: true, previewing: false });
    expect(controller.getSnapshot().rendered).toBe(last.rendered);
    expect(fakes.disposed).toEqual({ primary: 1, scratch: 1 });
    expect(shared.stats()).toMatchObject({ workers: 0, active: 0, waiting: 0 });
    expect(controller.subscribe(() => notified++)).toBeTypeOf('function');
    controller.preview({ slope: 1 });
    expect(notified).toBe(0);
  });

  it('a failed creation leaves no session, evaluator or lease behind', async () => {
    const shared = budget(2);
    const fakes = evaluators();
    const invalid = { ...parametric(), quantities: { value: { expression: 'missing*2' } } };
    await expect(createDocumentInteractionController(invalid, { budget: shared, evaluatorFactory: purpose => fakes.factory(purpose) })).rejects.toBeInstanceOf(DocumentError);
    expect(shared.stats().workers).toBe(0);
    expect(fakes.created).toEqual({ primary: 0, scratch: 0 });
    await expect(createDocumentInteractionController(parametric(), { ownerId: 'bad owner', evaluatorFactory: purpose => fakes.factory(purpose) })).rejects.toThrow(/owner/);
  });
});
