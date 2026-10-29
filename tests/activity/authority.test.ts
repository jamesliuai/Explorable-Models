/**
 * Authority, persistence and evidence integrity of the activity controller (report §4.2, §5.1, §5.3, §6.3, §6.4,
 * §7.1–§7.3, §14): host-owned revisions and host time, standing checks on every entry point, a re-issued host command
 * that resumes a failed authorization, causal references between events, revocation recorded once per source, the
 * observed display interval, learner-only display attestation, the host's choice for a pending preview on close, a
 * flush-first step that never waits silently for stalled appends, and unacknowledged events that a restore resends.
 * Results use the memory host double and inline workers; they are fixture-host results.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactIntegrity, createStudyHarnessAdapter, type ActivityArtifact, type ActivityCatalog, type ExposureRecord, type InteractionEvent } from '@explorable-models/activity';
import { createInstalledCatalog } from '@explorable-models/catalog';
import {
  ackCurrent, activityGuard, authorizeExploration, codesOf, enterExplore, expectValidEvents, guards, harness, okOf, op, open, policyFor, rectangleCatalog, rectanglePolicy,
  rectangleRequest, requestFor, settled, until, type Harness, type Opened,
} from './support/adapter-harness.js';
import { MemoryHost } from './support/memory-host.js';

let disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
const make = (...args: Parameters<typeof harness>): Harness => { const h = harness(...args); disposers.push(() => h.adapter.dispose()); return h; };
const ACTIVITY = 'act-quadratic-1';
const typesOf = (events: InteractionEvent[]) => events.map(event => event.type);
const count = (events: InteractionEvent[], type: InteractionEvent['type']) => events.filter(event => event.type === type).length;
const exposuresOf = (h: Harness, activityId = ACTIVITY) => (h.adapter.getState(activityId, 'host') as { exposures: ExposureRecord[] }).exposures;
const hostGuards = (h: Harness) => (h.adapter.getState(ACTIVITY, 'host') as { guards: { hostSessionRevision: number } }).guards;
const response = (responseId: string) => ({ responseId, taskId: 'task-1', taskRevision: 1, kind: 'prediction' as const, modality: 'text' as const, stageId: 'predict' });

describe('a re-issued host command resumes a failed authorization (report §6.3, A20; G04)', () => {
  it('requestReveal with the same operation ID resumes without a second reveal.requested; other arguments conflict', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    h.host.failNext('recordExposureIntent', 'throw');
    const operationId = op('reveal');
    const input = { operationId, ...activityGuard(opened.learner), groups: ['trace'] };
    const failed = await opened.control.requestReveal(input);
    expect(codesOf(failed)).toEqual(['PERSISTENCE_FAILED']);
    // The recovery names a method the host control actually has.
    expect(failed.ok ? '' : failed.diagnostics[0]!.recovery).toMatch(/Repeat requestReveal with the same operation ID/);
    expect(codesOf(await opened.control.requestReveal({ ...input, groups: ['regime'] }))).toEqual(['OPERATION_CONFLICT']);
    okOf(await opened.control.requestReveal(input));
    await settled(h);
    const events = h.host.events(ACTIVITY);
    expectValidEvents(events);
    expect([count(events, 'reveal.requested'), count(events, 'operation.failed'), count(events, 'reveal.authorized')]).toEqual([1, 1, 1]);
    expect(h.host.calls('recordExposureIntent').map(call => call.outcome)).toEqual(['failed', 'ok']);
    expect(h.host.receipts(ACTIVITY).filter(receipt => receipt.idempotencyKey === operationId)).toHaveLength(1);
  });

  it('requestStageTransition with the same operation ID resumes; the stage changes once', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    h.host.failNext('requestStageTransition', 'throw');
    const input = { operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-step' };
    expect(codesOf(await opened.control.requestStageTransition(input))).toEqual(['PERSISTENCE_FAILED']);
    expect(opened.learner.getProjection().pendingReveal?.state).toBe('failed');
    okOf(await opened.control.requestStageTransition(input));
    expect(opened.learner.getProjection().stage.id).toBe('explore-step');
    await settled(h);
    const events = h.host.events(ACTIVITY);
    expectValidEvents(events);
    expect([count(events, 'reveal.requested'), count(events, 'operation.failed'), count(events, 'stage.changed')]).toEqual([1, 1, 1]);
    expect(h.host.calls('requestStageTransition').map(call => call.outcome)).toEqual(['failed', 'ok']);
    expect(h.host.receipts(ACTIVITY).filter(receipt => receipt.idempotencyKey === input.operationId)).toHaveLength(1);
  });

  it('a learner requestHelp repeated with the same operation ID resumes without a second help.requested', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    h.host.failNext('recordAssistance', 'throw');
    const input = { operationId: op('help'), ...activityGuard(opened.learner) };
    expect(codesOf(await opened.learner.requestHelp(input))).toEqual(['PERSISTENCE_FAILED']);
    okOf(await opened.learner.requestHelp(input));
    await settled(h);
    const events = h.host.events(ACTIVITY);
    expect([count(events, 'help.requested'), count(events, 'assistance.recorded')]).toEqual([1, 1]);
  });
});

describe('host time and standing (report §5.1, §5.3, §8.6; G05, G06)', () => {
  it('an acknowledgement time past expiresAt stops the next command with POLICY_EXPIRED and shows the stale policy', async () => {
    const h = make({ customCatalog: rectangleCatalog(), policy: rectanglePolicy({ expiresAt: '2026-10-26T10:00:00.000Z' }) });
    const opened = await open(h, rectangleRequest());
    await settled(h, 'act-rectangle-1');
    h.host.advanceClock(3 * 3_600_000);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { w: 250 } }));
    await settled(h, 'act-rectangle-1');
    await until(() => opened.learner.getProjection().status.ui === 'stale-policy');
    expect(codesOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { w: 200 } }))).toEqual(['POLICY_EXPIRED']);
    expect(count(h.host.events('act-rectangle-1'), 'parameters.committed')).toBe(2);
  });

  it('sampling under an expired policy fails with POLICY_EXPIRED before any worker lease', async () => {
    const h = make({ policy: policyFor({ expiresAt: '2026-10-26T10:00:00.000Z' }) });
    const opened = await open(h);
    await settled(h);
    const request = { activityId: ACTIVITY, parameters: { a: 2, eta: 0.25, x0: 4 }, positions: [{ kind: 'index' as const, index: 1 }], audience: 'host' as const };
    expect((await h.adapter.sample(request)).ok).toBe(true);
    h.host.advanceClock(3 * 3_600_000);
    // The later host time reaches the adapter with the next host reply.
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    expect(saved.ok).toBe(true);
    const workers = h.workers.workers.length, received = h.workers.received;
    expect(codesOf(await h.adapter.sample(request))).toEqual(['POLICY_EXPIRED']);
    expect([h.workers.workers.length, h.workers.received]).toEqual([workers, received]);
  });

  it('sampling a catalogue-revoked model fails with CONTENT_REVOKED before any worker lease and journals the revocation once', async () => {
    let revoked = false;
    const h = make({
      customCatalog: workerFactory => {
        const base = createInstalledCatalog({ workerFactory });
        const catalog: ActivityCatalog = {
          listTemplates: () => base.listTemplates(), getTemplate: ref => base.getTemplate(ref), getModel: ref => base.getModel(ref), createWorker: () => base.createWorker(),
          status: ref => revoked && 'modelId' in ref ? { lifecycle: 'revoked', reviews: [], revoked: true, revocationReason: 'Withdrawn after review.' } : base.status(ref),
        };
        return catalog;
      },
    });
    const opened = await open(h);
    await settled(h);
    revoked = true;
    const workers = h.workers.workers.length, received = h.workers.received;
    const request = { activityId: ACTIVITY, parameters: { a: 2, eta: 0.25, x0: 4 }, positions: [{ kind: 'index' as const, index: 1 }], audience: 'host' as const };
    expect(codesOf(await h.adapter.sample(request))).toEqual(['CONTENT_REVOKED']);
    expect(codesOf(await h.adapter.sample(request))).toEqual(['CONTENT_REVOKED']);
    expect([h.workers.workers.length, h.workers.received]).toEqual([workers, received]);
    expect(codesOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 1 } }))).toEqual(['CONTENT_REVOKED']);
    await settled(h);
    expect(opened.learner.getProjection().status.ui).toBe('unsupported');
    expect(h.host.events(ACTIVITY).filter(event => event.type === 'content.revoked').map(event => event.payload)).toEqual([{ source: 'catalogue', code: 'CONTENT_REVOKED' }]);
  });
});

describe('content.revoked once per revocation source (report §7.1; G09)', () => {
  it('a revoking policy update journals one content.revoked; repeated commands add none', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: h.host.revokePolicy() }));
    expect(opened.learner.getProjection().status.ui).toBe('stale-policy');
    for (let index = 0; index < 3; index++) expect(codesOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } }))).toEqual(['POLICY_DENIED']);
    await settled(h);
    expect(h.host.events(ACTIVITY).filter(event => event.type === 'content.revoked').map(event => event.payload)).toEqual([{ source: 'policy', code: 'POLICY_DENIED' }]);
  });

  it('a host revocation journals content.revoked once with its reason', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.revoke({ operationId: op(), reason: 'The tutor withdrew the activity.' }));
    okOf(await opened.control.revoke({ operationId: op(), reason: 'The tutor withdrew the activity.' }));
    await settled(h);
    expect(h.host.events(ACTIVITY).filter(event => event.type === 'content.revoked').map(event => event.payload)).toEqual([{ source: 'host', code: 'POLICY_DENIED', reason: 'The tutor withdrew the activity.' }]);
  });
});

describe("the host session revision is the host's (report §4.2; G07)", () => {
  it('adopts the revision each host transaction produced, follows a host-advanced revision and never computes one', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    // The host's response transaction advanced its session by 2.
    okOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 0, hostSessionRevision: 2, response: response('resp-1') }));
    expect(hostGuards(h).hostSessionRevision).toBe(2);
    // The host advanced its session elsewhere (a correction outside this activity): the adapter follows it.
    okOf(opened.control.observeHostSessionRevision({ operationId: op(), expectedHostSessionRevision: 2, hostSessionRevision: 4 }));
    okOf(await opened.control.updateResponseRef({ operationId: op(), expectedHostSessionRevision: 4, hostSessionRevision: 5, responseId: 'resp-1', status: 'disputed' }));
    expect(hostGuards(h).hostSessionRevision).toBe(5);
    expect(codesOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 5, hostSessionRevision: 5, response: response('resp-2') }))).toEqual(['INVALID_INPUT']);
    expect(codesOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 5, response: response('resp-2') } as never))).toEqual(['INVALID_INPUT']);
    expect(codesOf(opened.control.observeHostSessionRevision({ operationId: op(), expectedHostSessionRevision: 4, hostSessionRevision: 9 }))).toEqual(['STALE_HOST_REVISION']);
    await settled(h);
    const events = h.host.events(ACTIVITY);
    expect(events.find(event => event.type === 'response.submitted')!.revisions.hostSession).toBe(2);
    expect(events.find(event => event.type === 'response.invalidated')!.revisions.hostSession).toBe(5);
    const source = readFileSync(new URL('../../packages/activity/src/controller.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/expectedHostSessionRevision[^\n;]*\+\s*1/);
  });
});

describe('causal references (report §5.1; G08)', () => {
  it('links each reveal, display, preview, response and assistance event to the eventId of its antecedent', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 0, hostSessionRevision: 1, response: response('resp-1') }));
    okOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 1, hostSessionRevision: 2, response: response('resp-2') }));
    okOf(await opened.control.updateResponseRef({ operationId: op(), expectedHostSessionRevision: 2, hostSessionRevision: 3, responseId: 'resp-1', status: 'superseded', supersededBy: 'resp-2' }));
    await enterExplore(h, opened);
    await authorizeExploration(h, opened);
    const committedPreview = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' })).preview!.previewId;
    okOf(opened.learner.updatePreview({ operationId: op(), previewId: committedPreview, displayValues: { eta: 0.4 } }));
    // The tentative frame is shown (not a fixed wait that a loaded run can outlast).
    await until(() => opened.learner.getProjection().frame?.kind === 'tentative');
    ackCurrent(opened.learner);
    okOf(await opened.learner.commitPreview({ operationId: op(), ...guards(opened.learner), previewId: committedPreview }));
    const cancelledPreview = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' })).preview!.previewId;
    okOf(opened.learner.cancelPreview({ operationId: op(), previewId: cancelledPreview, reason: 'escape' }));
    await settled(h);
    okOf(await opened.learner.requestHelp({ operationId: op('help'), ...activityGuard(opened.learner) }));
    const independent = h.host.amendPolicy({ independentTask: { active: true, taskRef: 'task-new-curvature', permittedTools: ['inspect.learner'], neutralScaffold: ['landscape', 'start'] } });
    okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-new-curvature', policy: independent }));
    // The host ends the independent task in its policy before reopening (a conformant host grants nothing else then).
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: h.host.amendPolicy({ independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] } }) }));
    okOf(await opened.control.reopenInstructional({ operationId: op(), ...activityGuard(opened.learner) }));
    await settled(h);
    const events = h.host.events(ACTIVITY);
    expectValidEvents(events);
    const byId = new Map(events.map(event => [event.eventId, event]));
    const causes = (event: InteractionEvent) => event.causes.map(id => byId.get(id)!);
    const one = (event: InteractionEvent) => { expect(event.causes, `${event.type} #${event.sequence}`).toHaveLength(1); return causes(event)[0]!; };
    for (const event of events) {
      const body = event.payload as Record<string, unknown>;
      switch (event.type) {
        case 'stage.changed': expect(one(event).type).toBe('reveal.requested'); expect(one(event).operationId).toBe(event.operationId); break;
        case 'reveal.authorized': case 'exposure.scope-authorized': {
          const assistance = h.host.receipts(ACTIVITY).some(receipt => receipt.receiptId === body.receiptId && receipt.contract === 'study-harness.assistance-receipt');
          if (assistance) { if (event.causes.length) expect(one(event).type).toBe('help.requested'); }
          else { expect(one(event).type).toBe('reveal.requested'); expect(one(event).operationId).toBe(event.operationId); }
          break;
        }
        case 'reveal.displayed': case 'reveal.uncertain':
          expect(['reveal.authorized', 'exposure.scope-authorized']).toContain(one(event).type);
          expect((one(event).payload as { exposureId: string }).exposureId).toBe(body.exposureId);
          break;
        case 'preview.observed': case 'preview.cancelled':
          expect(one(event).type).toBe('preview.started');
          expect((one(event).payload as { previewId: string }).previewId).toBe(body.previewId);
          break;
        case 'parameters.committed':
          if (typeof body.previewId === 'string') { expect(one(event).type).toBe('preview.started'); expect((one(event).payload as { previewId: string }).previewId).toBe(body.previewId); }
          break;
        case 'response.superseded': case 'response.invalidated':
          expect(causes(event).map(item => [item.type, (item.payload as { response: { responseId: string } }).response.responseId])).toEqual([['response.submitted', 'resp-1'], ['response.submitted', 'resp-2']]);
          break;
        case 'assistance.recorded': if (body.kind === 'help') expect(one(event).type).toBe('help.requested'); break;
        case 'context.instructional-reopened': expect(one(event).type).toBe('assistance.recorded'); break;
        default: break;
      }
    }
    expect(['stage.changed', 'reveal.displayed', 'preview.cancelled', 'response.superseded', 'context.instructional-reopened'].every(type => typesOf(events).includes(type as InteractionEvent['type']))).toBe(true);
  });
});

describe('observed display interval (report §5.1; G14)', () => {
  it('records the end and its reason when a stage change hides the displayed groups', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const [displayed] = exposuresOf(h);
    expect(displayed!.displayed).toMatchObject({ monotonicMs: expect.any(Number) });
    expect(displayed!.displayed!.endedMonotonicMs).toBeUndefined();
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'closed' }));
    const [ended] = exposuresOf(h);
    expect(ended!.displayed).toMatchObject({ endedBy: 'stage', endedMonotonicMs: expect.any(Number) });
    expect(ended!.displayed!.endedMonotonicMs!).toBeGreaterThanOrEqual(ended!.displayed!.monotonicMs);
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    expect(saved.artifact.exposures[0]!.displayed).toMatchObject({ endedBy: 'stage' });
  });

  it('records independent work as the end reason', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const independent = h.host.amendPolicy({ independentTask: { active: true, taskRef: 'task-1', permittedTools: ['inspect.learner'], neutralScaffold: ['landscape', 'start'] } });
    okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-1', policy: independent }));
    expect(exposuresOf(h)[0]!.displayed).toMatchObject({ endedBy: 'independent' });
  });
});

describe('only the learner surface attests display (report §6.3 step 4; G15)', () => {
  it('tutor and host bindings cannot register a surface, report visibility or acknowledge display; the exposure stays authorized', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await settled(h);
    const hostBinding = opened.prepared.binding('host', 'host-panel');
    expect(() => opened.tutor.registerSurface('tutor-fake-surface')).toThrow(TypeError);
    expect(() => hostBinding.registerSurface('host-surface')).toThrow(TypeError);
    for (const binding of [opened.tutor, hostBinding]) {
      const projection = binding.getProjection();
      binding.acknowledgeDisplay({ projectionId: projection.projectionId, projectionDigest: projection.projectionDigest, surfaceId: opened.surface });
      binding.reportVisibility({ surfaceId: opened.surface, visible: false });
    }
    await settled(h);
    expect(exposuresOf(h)).toEqual([expect.objectContaining({ displayStatus: 'authorized' })]);
    expect(h.host.calls('recordDisplayAck')).toEqual([]);
    expect(typesOf(h.host.events(ACTIVITY))).not.toContain('reveal.displayed');
    expect(opened.learner.getProjection().status.ui).not.toBe('suspended');
    ackCurrent(opened.learner);
    await settled(h);
    expect(exposuresOf(h)).toEqual([expect.objectContaining({ displayStatus: 'displayed' })]);
  });
});

describe('the host resolves a pending preview on close (report §14; G68)', () => {
  /** Explore-step card with an exploration scope and an active keyboard preview at η = 0.4. */
  async function previewing(h: Harness): Promise<{ opened: Opened; previewId: string }> {
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened);
    const previewId = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' })).preview!.previewId;
    okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 0.4 } }));
    await until(() => opened.learner.getProjection().frame?.kind === 'tentative');
    ackCurrent(opened.learner);
    await settled(h);
    return { opened, previewId };
  }

  it('cancel (the default) ends the preview as interrupted; exposure records and observations survive', async () => {
    const h = make();
    const { opened, previewId } = await previewing(h);
    const before = exposuresOf(h).map(record => record.exposureId);
    okOf(await opened.control.close({ operationId: op(), reason: 'Lesson finished.' }));
    await settled(h);
    const events = h.host.events(ACTIVITY);
    expect(events.find(event => event.type === 'preview.observed' && event.payload.previewId === previewId)!.payload).toMatchObject({ outcome: 'interrupted' });
    expect(events.find(event => event.type === 'preview.cancelled')!.payload).toEqual({ previewId, reason: 'navigation' });
    expect(events.at(-1)!).toMatchObject({ type: 'activity.closed', payload: { reason: 'Lesson finished.', pending: 'cancel' } });
    expect(exposuresOf(h).map(record => record.exposureId)).toEqual(before);
    expect(count(events, 'parameters.committed')).toBe(1);
  });

  it('commit commits the latest tentative values through the guarded path, attributed to the host', async () => {
    const h = make();
    const { opened, previewId } = await previewing(h);
    okOf(await opened.control.close({ operationId: op(), reason: "Keep the learner's last value.", pending: 'commit' }));
    await settled(h);
    const events = h.host.events(ACTIVITY);
    const committed = events.filter(event => event.type === 'parameters.committed').at(-1)!;
    expect(committed).toMatchObject({ actor: { kind: 'host' }, payload: { previewId, gesture: 'keyboard', cause: 'commit', params: expect.objectContaining({ eta: 0.4 }) } });
    expect(events.find(event => event.type === 'preview.observed')!.payload).toMatchObject({ previewId, outcome: 'committed' });
    expect(events.at(-1)!).toMatchObject({ type: 'activity.closed', payload: { pending: 'commit' } });
    expect(exposuresOf(h).length).toBeGreaterThanOrEqual(2);
  });

  it('retain keeps the draft without committing it; a backup records it and a restore reports it for the host to re-offer', async () => {
    const h = make();
    const { opened, previewId } = await previewing(h);
    okOf(await opened.control.close({ operationId: op(), reason: 'Pause the lesson.', pending: 'retain' }));
    await settled(h);
    const events = h.host.events(ACTIVITY);
    expect(events.find(event => event.type === 'preview.observed')!.payload).toMatchObject({ previewId, outcome: 'interrupted' });
    expect(typesOf(events)).not.toContain('preview.cancelled');
    expect(count(events, 'parameters.committed')).toBe(1);
    expect(events.at(-1)!).toMatchObject({ type: 'activity.closed', payload: { pending: 'retain' } });
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    expect(saved.artifact.scientific.params.eta).toBe(0.25);
    expect(saved.artifact.pending).toEqual({ kind: 'preview', previewId, params: expect.objectContaining({ eta: 0.4 }), baseRunId: saved.artifact.scientific.runId });
    h.adapter.dispose(ACTIVITY);
    const restored = await h.adapter.restore(saved.artifact, { operationId: op('restore'), hostSessionRevision: 0 });
    if (!restored.ok) throw new Error(JSON.stringify(restored.diagnostics));
    expect(restored.report.restored).toBe('read-only');
    expect(restored.report.pendingDraft).toEqual({ previewId, params: expect.objectContaining({ eta: 0.4 }), baseRunId: saved.artifact.scientific.runId });
    // The draft is offered back to the host, never applied: the restored card is closed, with no preview and no controls.
    const projection = restored.prepared.binding('learner', 's').getProjection();
    expect(projection.preview).toBeNull();
    expect(projection.controls).toEqual([]);
    expect((h.adapter.getState(ACTIVITY, 'host') as { scientific: { params: Record<string, number> } }).scientific.params.eta).toBe(0.25);
    // A later backup of the closed activity keeps the retained draft.
    const again = await restored.prepared.host.save({ operationId: op('save'), kind: 'backup' });
    if (!again.ok) throw new Error(JSON.stringify(again.diagnostics));
    expect(again.artifact.pending).toMatchObject({ kind: 'preview', previewId });
    expect(again.artifact.scientific.params.eta).toBe(0.25);
  });
});

describe('a flush-first step does not wait silently for stalled appends (report §7.2; Phase 4a F3)', () => {
  it('is refused promptly with PERSISTENCE_PENDING, shows awaiting persistence, and succeeds when repeated after saving', async () => {
    const h = make({ adapter: { persistenceWaitMs: 50 } });
    const opened = await open(h);
    await enterExplore(h, opened);
    h.host.failNext('appendEvents', 'timeout');
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const input = { operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-curvature' };
    const transitions = h.host.calls('requestStageTransition').length;
    const started = Date.now();
    expect(codesOf(await opened.control.requestStageTransition(input))).toEqual(['PERSISTENCE_PENDING']);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(opened.learner.getProjection().status.ui).toBe('awaiting-persistence');
    expect(h.host.calls('requestStageTransition')).toHaveLength(transitions);
    expect(opened.learner.getProjection().stage.id).toBe('explore-step');
    // The host answers (here: the stalled call fails and the batch is resent); the step is then repeated as is.
    expect(h.host.releaseHung()).toBe(1);
    await until(() => opened.learner.getProjection().status.persistence === 'pending-recovery');
    okOf(await opened.learner.retryPersistence({ operationId: op() }));
    await settled(h);
    expect(opened.learner.getProjection().status.persistence).toBe('saved');
    expect(opened.learner.getProjection().status.ui).not.toBe('awaiting-persistence');
    okOf(await opened.control.requestStageTransition(input));
    expect(opened.learner.getProjection().stage.id).toBe('explore-curvature');
    await settled(h);
    expectValidEvents(h.host.events(ACTIVITY));
  });
});

describe('unacknowledged events survive a host abort (report §6.3, §7.2; native crash:display-ack-before-commit)', () => {
  /**
   * A reveal whose journal batches are held while the display acknowledgement crashes the host before its commit. The
   * order is fixed by explicit host gates, not wall-clock delays: no journal batch reaches the host before the crash,
   * and the backup is written while the display acknowledgement is still outstanding.
   */
  async function crashedBeforeAck(h: Harness) {
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    h.host.hold('appendEvents').hold('recordDisplayAck').crashAt('before-ack-commit');
    okOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: ['trace'] }));
    ackCurrent(opened.learner);
    await until(() => h.host.waiting('recordDisplayAck') === 1);
    expect(h.host.waiting('appendEvents')).toBeGreaterThan(0);
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    // The acknowledgement reaches the host, which crashes before committing it; the held journal batches then fail.
    await h.host.release('recordDisplayAck');
    expect(h.host.crashed).toBe(true);
    await h.host.release('appendEvents');
    expect(h.host.events(ACTIVITY).map(event => event.type)).not.toContain('reveal.requested');
    await new Promise(resolve => setTimeout(resolve, 0));
    return saved.artifact;
  }
  const restart = (h: Harness) => {
    const host = h.host.restoreInto(new MemoryHost({ policy: h.host.policy() }));
    host.interruptUnacknowledged();
    const adapter = createStudyHarnessAdapter({ catalog: h.catalog, host });
    disposers.push(() => adapter.dispose());
    return { host, adapter };
  };

  it('the backup carries the events the host never received; the restore resends them by eventId and the host journal becomes complete', async () => {
    const h = make();
    const artifact = await crashedBeforeAck(h);
    const pending = artifact.journal.pendingEvents ?? [];
    expect(pending.map(event => event.type)).toEqual(['reveal.requested', 'reveal.authorized', 'reveal.displayed']);
    expect(pending.map(event => event.eventId)).toEqual(artifact.journal.pendingEventIds);
    expect(h.host.events(ACTIVITY).map(event => event.type)).not.toContain('reveal.requested');
    const { host, adapter } = restart(h);
    const restored = await adapter.restore(JSON.stringify(artifact), { operationId: op('restore'), hostSessionRevision: 0 });
    if (!restored.ok) throw new Error(JSON.stringify(restored.diagnostics));
    expect(restored.report.notes.join(' ')).toMatch(/3 events that were unacknowledged when the artifact was saved were resent to the host journal/);
    await until(() => host.events(ACTIVITY).some(event => event.type === 'artifact.restored'));
    await until(() => host.exposures(ACTIVITY)[0]?.displayStatus === 'displayed');
    const events = host.events(ACTIVITY);
    expectValidEvents(events);
    expect(events.filter(event => artifact.journal.pendingEventIds.includes(event.eventId))).toEqual(pending);
    expect(typesOf(events).slice(-4)).toEqual(['reveal.requested', 'reveal.authorized', 'reveal.displayed', 'artifact.restored']);
    expect(count(events, 'operation.failed')).toBe(0);
    const summary = adapter.summarizeInteraction(ACTIVITY, { audience: 'host' });
    if (!('limitations' in summary)) throw new Error(JSON.stringify(summary));
    expect(summary.limitations.join(' ')).not.toMatch(/could not be recorded in the journal/);
    // Restoring the same backup again resends nothing new: the host already holds the events.
    adapter.dispose(ACTIVITY);
    const again = await adapter.restore(JSON.stringify(artifact), { operationId: op('restore'), hostSessionRevision: 0 });
    if (!again.ok) throw new Error(JSON.stringify(again.diagnostics));
    expect(again.report.notes.join(' ')).toMatch(/3 events that were unacknowledged when the artifact was saved are already in the host journal/);
  });

  it('events the artifact did not carry are recorded as an explicit, durable loss; the summary is incomplete', async () => {
    const h = make();
    const artifact = await crashedBeforeAck(h);
    // An artifact written before pending events were carried (or with more than its budget) lists them by ID only.
    const { integrity: _integrity, ...body } = structuredClone(artifact);
    delete body.journal.pendingEvents;
    body.schemas = body.schemas.filter(entry => entry.contract !== 'study-harness.interaction-event');
    const older: ActivityArtifact = { ...body, integrity: artifactIntegrity(body) };
    const { host, adapter } = restart(h);
    const restored = await adapter.restore(older, { operationId: op('restore'), hostSessionRevision: 0 });
    if (!restored.ok) throw new Error(JSON.stringify(restored.diagnostics));
    expect(restored.report.notes.join(' ')).toMatch(/3 events that were unacknowledged when the artifact was saved could not be recovered \(the artifact did not carry them\)/);
    await until(() => host.events(ACTIVITY).some(event => event.type === 'artifact.restored'));
    const marker = host.events(ACTIVITY).find(event => event.type === 'operation.failed')!;
    expect(marker.payload).toMatchObject({ operation: 'appendEvents', recoverable: false, lost: { count: 3, types: [], afterSequence: artifact.journal.cursor.lastSequence } });
    const summary = adapter.summarizeInteraction(ACTIVITY, { audience: 'host' });
    if (!('complete' in summary)) throw new Error(JSON.stringify(summary));
    expect(summary.complete).toBe(false);
    expect(summary.limitations.join(' ')).toMatch(/3 events after event \d+ could not be recorded in the journal/);
    const saved = await restored.prepared.host.save({ operationId: op('save'), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    expect(saved.artifact.journal.lost).toMatchObject({ count: 3 });
  });

  it('a crash after the intent commit with the request event still unsent: the restore resends it and keeps the host-held grant as history', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    const artifactBefore = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!artifactBefore.ok) throw new Error(JSON.stringify(artifactBefore.diagnostics));
    await settled(h);
    // Explicit gates (not delays): the backup is written while the exposure intent is outstanding at the host and the
    // request event has not reached the journal; the host then commits the intent and crashes before replying.
    h.host.hold('appendEvents').hold('recordExposureIntent').crashAt('after-intent-commit-before-reply');
    const reveal = opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: ['trace'] });
    await until(() => h.host.waiting('recordExposureIntent') === 1);
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    await h.host.release('recordExposureIntent');
    expect(h.host.crashed).toBe(true);
    expect(codesOf(await reveal)).toEqual(['PERSISTENCE_FAILED']);
    expect(saved.artifact.journal.pendingEvents?.map(event => event.type)).toEqual(['reveal.requested']);
    await h.host.release('appendEvents');
    expect(h.host.events(ACTIVITY).map(event => event.type)).not.toContain('reveal.requested');
    await new Promise(resolve => setTimeout(resolve, 0));
    const { host, adapter } = restart(h);
    const restored = await adapter.restore(saved.artifact, { operationId: op('restore'), hostSessionRevision: 0 });
    if (!restored.ok) throw new Error(JSON.stringify(restored.diagnostics));
    await until(() => host.events(ACTIVITY).some(event => event.type === 'artifact.restored'));
    expect(typesOf(host.events(ACTIVITY)).slice(-2)).toEqual(['reveal.requested', 'artifact.restored']);
    expect(restored.report.notes.join(' ')).toMatch(/1 exposure records came from the host's records/);
    expect(exposuresOf({ ...h, adapter } as Harness)).toEqual([expect.objectContaining({ displayStatus: 'uncertain', uncertainty: expect.objectContaining({ code: 'INTERRUPTED_BEFORE_ACK' }) })]);
    expect(restored.prepared.binding('learner', 's').getProjection().views.map(view => view.viewId)).not.toContain('trace-plot');
  });
});
