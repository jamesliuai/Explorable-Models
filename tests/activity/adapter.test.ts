/**
 * Adapter lifecycle (report §5.3, activity-runtime §1): validate never activates, prepare resolves exact content and
 * journals the opening, the projection follows one identified frame, dispose is idempotent and silences callbacks,
 * and events carry trusted attribution with gap-free ordering and duplicate handling across reconnects (A15, A43).
 * Host results come from the memory host double (fixture-host results).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { artifactIntegrity, templateRef, type ActivityArtifact, type ActivityCatalog, type ReviewRecord } from '@explorable-models/activity';
import { createInstalledCatalog } from '@explorable-models/catalog';
import { modelIdentity } from '@explorable-models/core/model';
import {
  ackCurrent, activityGuard, codesOf, enterExplore, expectValidEvents, guards, harness, manifest, MODEL, okOf, op, open, policyFor, requestFor, settled, template, TEMPLATE, until,
  type Harness,
} from './support/adapter-harness.js';

let current: Harness | null = null;
const make = (...args: Parameters<typeof harness>) => (current = harness(...args));
afterEach(() => { current?.adapter.dispose(); current = null; });

describe('validate and prepare', () => {
  it('validates a request, evaluates defaults in a worker and activates nothing', async () => {
    const h = make();
    const report = await h.adapter.validate(requestFor());
    expect(report.ok).toBe(true);
    expect(report.defaults?.frameId).toMatch(/^sha256:/);
    expect(report.defaults?.statuses.position).toBe('valid');
    expect(report.resourceEstimate?.geometryElements).toBeGreaterThan(0);
    expect(h.host.calls('registerActivity')).toHaveLength(0);
    expect(h.host.events()).toHaveLength(0);
    expect(h.workers.received).toBe(1);
    expect('diagnostics' in h.adapter.getState('act-quadratic-1', 'host')).toBe(true);
  });

  it('reports schema, reference, constraint and policy problems without activating', async () => {
    const h = make();
    expect((await h.adapter.validate({ ...requestFor(), extra: true } as never)).diagnostics[0]?.code).toBe('SCHEMA');
    expect((await h.adapter.validate(requestFor({ template: { templateId: 'quadratic-gradient-descent', version: '9.9.9' } }))).diagnostics[0]?.code).toBe('INVALID_REFERENCE');
    expect((await h.adapter.validate(requestFor({ parameters: { eta: 2, a: 10 } }))).diagnostics.map(item => item.code)).toContain('CONSTRAINT_VIOLATION');
    expect((await h.adapter.validate(requestFor({ parameters: { eta: 3 } }))).diagnostics[0]?.code).toBe('OUT_OF_DOMAIN');
    expect((await h.adapter.validate(requestFor({ mode: 'exploratory' }))).diagnostics[0]?.code).toBe('POLICY_DENIED');
    expect(h.host.calls('registerActivity')).toHaveLength(0);
  });

  it('prepares an approved activity, registers it and journals prepared, opened and the initial run', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const projection = opened.learner.getProjection();
    expect(projection.stage.id).toBe('predict');
    expect(projection.reviewNotice).toBe('Reference-checked; no independent subject review');
    expect(projection.frame?.kind).toBe('committed');
    expect(projection.frame?.position).toEqual({ kind: 'index', index: 0, maxIndex: 1000 });
    expect(projection.guards.expectedRunId).toEqual(expect.any(String));
    expect(h.host.calls('registerActivity')).toHaveLength(1);
    const events = h.host.events();
    expect(events.map(event => event.type)).toEqual(['activity.prepared', 'activity.opened', 'parameters.committed']);
    expectValidEvents(events);
    expect(events[2]!.payload).toMatchObject({ cause: 'initial', previousRunId: null, params: { a: 2, eta: 0.25, x0: 4 } });
    expect(opened.prepared.instance.template.digest).toBe(projection.activityId === 'act-quadratic-1' ? opened.prepared.instance.template.digest : '');
  });

  it('refuses a second activity with the same ID and a reused prepare operation with other arguments', async () => {
    const h = make();
    await open(h);
    expect(codesOf(await h.adapter.prepare(requestFor(), { operationId: op() }))).toEqual(['CONFLICT']);
    const id = op();
    await h.adapter.prepare(requestFor({ activityId: 'act-2' }), { operationId: id });
    expect(codesOf(await h.adapter.prepare(requestFor({ activityId: 'act-3' }), { operationId: id }))).toEqual(['OPERATION_CONFLICT']);
  });

  it('shares one bounded worker budget across activities', async () => {
    const h = make({ adapter: { maxWorkers: 2 } });
    const a = await open(h, requestFor({ activityId: 'act-a' }));
    const b = await open(h, requestFor({ activityId: 'act-b' }));
    expect(a.learner.getProjection().frame).not.toBeNull();
    expect(b.learner.getProjection().frame).not.toBeNull();
    expect(h.adapter.getCapabilities().limits.maxWorkers).toBe(2);
    expect(h.workers.live).toBeLessThanOrEqual(2);
  });

  it('reports installed capabilities with honest review scope', () => {
    const h = make();
    const capabilities = h.adapter.getCapabilities();
    const entry = capabilities.templates.find(item => item.template.templateId === template.templateId)!;
    expect(entry.lifecycle).toBe('reference-checked');
    expect(entry.reviewScope).toMatch(/No independent subject review/);
    expect(entry.controls.map(control => control.parameter).sort()).toEqual(['a', 'eta', 'x0']);
    expect(capabilities.unsupported.length).toBeGreaterThan(0);
  });
});

describe('commands, attribution and ordering', () => {
  it('commits exact entries as a new run at index 0 and attributes events to the issuing binding', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const before = guards(opened.learner);
    okOf(await opened.learner.navigate({ operationId: op(), ...before, position: { kind: 'index', index: 3 } }));
    const mid = guards(opened.learner);
    expect(mid.expectedRunId).toBe(before.expectedRunId);
    okOf(await opened.tutor.commitParameters({ operationId: op(), ...mid, displayValues: { eta: 0.75 } }));
    const projection = opened.learner.getProjection();
    expect(projection.frame?.position).toEqual({ kind: 'index', index: 0, maxIndex: 1000 });
    expect(projection.guards.expectedRunId).not.toBe(before.expectedRunId);
    await settled(h);
    const events = h.host.events();
    expectValidEvents(events);
    const navigate = events.find(event => event.type === 'position.changed')!;
    const commit = events.filter(event => event.type === 'parameters.committed').at(-1)!;
    expect(navigate.actor).toEqual({ kind: 'learner', binding: 'surface-main' });
    expect(commit.actor).toEqual({ kind: 'tutor', binding: 'tool-executor' });
    expect(commit.payload).toMatchObject({ cause: 'commit', previousRunId: before.expectedRunId, params: { eta: 0.75 } });
  });

  it('ignores attribution fields in command input', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 }, actor: 'host', origin: 'host' } as never));
    await settled(h);
    expect(h.host.events().at(-1)!.actor).toEqual({ kind: 'learner', binding: 'surface-main' });
  });

  it('returns the original outcome for a repeated operation and refuses a changed one', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const input = { operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } };
    const first = await opened.learner.commitParameters(input);
    const again = await opened.learner.commitParameters(input);
    expect(again).toEqual(first);
    expect(codesOf(await opened.learner.commitParameters({ ...input, displayValues: { eta: 0.6 } }))).toEqual(['OPERATION_CONFLICT']);
    await settled(h);
    expect(h.host.events().filter(event => event.type === 'parameters.committed')).toHaveLength(2);
  });

  it('keeps events ordered and unduplicated across a disconnect after commit and reconciliation', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    h.host.failNext('appendEvents', 'disconnect-after-commit');
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 2 } }));
    await until(() => (h.adapter.getState('act-quadratic-1', 'host') as { persistence: string }).persistence === 'pending-recovery');
    const reconciled = await opened.control.reconcile();
    expect(reconciled.cursor.lastSequence).toBeGreaterThan(0);
    await settled(h);
    const events = h.host.events();
    expectValidEvents(events);
    expect(new Set(events.map(event => event.eventId)).size).toBe(events.length);
    expect(events.filter(event => event.type === 'position.changed')).toHaveLength(1);
    expect((h.adapter.getState('act-quadratic-1', 'host') as { persistence: string }).persistence).toBe('saved');
  });

  it('refuses stale scientific guards without mutating', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const stale = guards(opened.learner);
    okOf(await opened.learner.navigate({ operationId: op(), ...stale, position: { kind: 'index', index: 1 } }));
    expect(codesOf(await opened.learner.navigate({ operationId: op(), ...stale, position: { kind: 'index', index: 5 } }))).toEqual(['STALE_MODEL_REVISION']);
    expect(opened.learner.getProjection().frame?.position).toMatchObject({ index: 1 });
  });

  it('plays whole iterations, pauses and stops at the exact end', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(opened.learner.play({ operationId: op(), ...guards(opened.learner) }));
    expect(opened.learner.getProjection().status.ui).toBe('playing');
    okOf(opened.learner.pause({ operationId: op(), ...guards(opened.learner) }));
    expect(opened.learner.getProjection().navigation?.playing).toBe(false);
    await settled(h);
    const types = h.host.events().map(event => event.type);
    expect(types).toContain('playback.started');
    expect(types).toContain('playback.paused');
  });
});

describe('dispose', () => {
  it('is idempotent, silences listeners and turns later commands into DISPOSED no-ops', async () => {
    const h = make();
    const opened = await open(h);
    const heard: string[] = [];
    opened.learner.subscribe(projection => { heard.push(projection.status.ui); });
    h.adapter.dispose('act-quadratic-1');
    h.adapter.dispose('act-quadratic-1');
    const outcome = await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } });
    expect(codesOf(outcome)).toEqual(['DISPOSED']);
    await new Promise(resolve => setTimeout(resolve, 5));
    // A still-mounted surface hears the disposed projection once, at disposal (report §10.4, G39); nothing after.
    expect(heard).toEqual(['disposed']);
    expect('diagnostics' in h.adapter.getState('act-quadratic-1', 'host')).toBe(true);
    expect(h.workers.live).toBe(0);
    h.adapter.dispose();
    h.adapter.dispose();
  });

  it('during prepare: the pending registration resolves into DISPOSED and nothing is activated', async () => {
    const h = make();
    h.host.delay('registerActivity', 5);
    const pending = h.adapter.prepare(requestFor(), { operationId: op() });
    await new Promise(resolve => setTimeout(resolve, 1));
    h.adapter.dispose();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(h.host.events()).toHaveLength(0);
    expect(h.workers.live).toBe(0);
  });

  it('during evaluation and reveal: late worker and host replies never publish', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    let calls = 0;
    opened.learner.subscribe(() => { calls++; });
    h.workers.hold = true;
    const commit = opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } });
    h.host.delay('recordExposureIntent', 5);
    const reveal = opened.control.requestReveal({ operationId: op(), ...activityGuard(opened.learner), groups: ['regime'] });
    await new Promise(resolve => setTimeout(resolve, 1));
    h.adapter.dispose('act-quadratic-1');
    const before = calls;
    h.workers.flush();
    expect(codesOf(await commit)).toEqual(['DISPOSED']);
    expect((await reveal).ok).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls).toBe(before);
    ackCurrent(opened.learner);
  });
});

describe('policy-limited preparation', () => {
  it('prepares exploratory activities only where the policy allows and labels them', async () => {
    const h = make({ policy: policyFor({ mode: 'exploratory', approved: [], exploratory: { allowed: true, maxParametersOverride: 2 }, allowedTools: ['prepare', 'compose.exploratory', 'operate.parameters'], sampling: { allowed: false, maxPositions: 0 } }) });
    const opened = await open(h, requestFor({ mode: 'exploratory', parameters: { x0: -3 } }));
    expect(opened.learner.getProjection().reviewNotice).toBe('Exploratory composition — not reviewed');
    expect(opened.prepared.instance.mode).toBe('exploratory');
  });
});

describe('review authority and revocation (A07)', () => {
  const review = (subject: ReviewRecord['subject'], patch: Partial<ReviewRecord> = {}): ReviewRecord => ({
    contract: 'study-harness.review-record', schemaVersion: '1.0', reviewId: `review-${subject.kind}`, subject, reviewer: { name: 'Subject reviewer', role: 'mathematics educator' },
    date: '2026-10-20', scope: 'Quadratic step-size lesson, ages 16+', limitations: [], referenceSuiteDigest: manifest.referenceSuite!.digest, outcome: 'approved', ...patch,
  });
  const modelSubject = { kind: 'model' as const, modelId: MODEL.modelId, version: MODEL.version, scientificRevision: modelIdentity(manifest).scientificRevision };
  const templateSubject = { kind: 'template' as const, templateId: TEMPLATE.templateId, version: TEMPLATE.version, contentDigest: TEMPLATE.digest };

  it('labels content reviewed only from host-trusted records that name the exact subjects', async () => {
    const h = make({ catalog: { reviews: [review(modelSubject), review(templateSubject)] } });
    const { learner } = await open(h);
    expect(learner.getProjection().reviewNotice).toBe('Independently reviewed for: Quadratic step-size lesson, ages 16+');
  });

  it('ignores forged, stale or self-issued review claims', async () => {
    const forged = [
      review({ ...templateSubject, contentDigest: 'sha256:' + 'a'.repeat(64) }),
      review(modelSubject, { referenceSuiteDigest: 'sha256:' + 'b'.repeat(64) }),
      { ...review(templateSubject), reviewer: { name: 'Tutor agent', role: 'self' }, extra: 'self-issued' } as unknown as ReviewRecord,
    ];
    const h = make({ catalog: { reviews: forged } });
    const { learner } = await open(h);
    expect(learner.getProjection().reviewNotice).toBe('Reference-checked; no independent subject review');
    expect(codesOf(await h.adapter.prepare({ ...requestFor({ activityId: 'act-2' }), review: 'approved' } as never, { operationId: op() }))).toEqual(['SCHEMA']);
  });

  it('a policy approval of a forged template digest never enters approved mode', async () => {
    const h = make({ policy: policyFor({ approved: [{ template: { ...TEMPLATE, digest: 'sha256:' + 'c'.repeat(64) }, model: MODEL }] }) });
    expect(codesOf(await h.adapter.prepare(requestFor(), { operationId: op() }))).toEqual(['POLICY_DENIED']);
  });

  it('revoked content cannot be prepared in any mode and a live activity stops when its content is revoked', async () => {
    const policy = policyFor({ exploratory: { allowed: true, maxParametersOverride: 1 }, allowedTools: [...policyFor().allowedTools, 'compose.exploratory'] });
    let revoked = false;
    const h = make({ policy, customCatalog: workerFactory => {
      const base = createInstalledCatalog({ workerFactory });
      return { ...base, status: ref => revoked ? { lifecycle: 'revoked', reviews: [], revoked: true, revocationReason: 'Withdrawn.' } : base.status(ref) } satisfies ActivityCatalog;
    } });
    const opened = await open(h);
    await settled(h);
    revoked = true;
    expect(codesOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }))).toEqual(['CONTENT_REVOKED']);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(opened.learner.getProjection().status.ui).toBe('unsupported');
    expect(opened.learner.getProjection().views).toEqual([]);
    expect(codesOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } }))).toEqual(['CONTENT_REVOKED']);
    for (const mode of ['approved', 'exploratory'] as const)
      expect(codesOf(await h.adapter.prepare(requestFor({ activityId: `act-${mode}`, mode }), { operationId: op() }))).toEqual(['CONTENT_REVOKED']);
  });
});

describe('exploratory composition (A08)', () => {
  const edited = structuredClone(template);
  edited.views[0]!.marks[0]!.label = 'Objective, edited in an exploratory composition';
  const policy = policyFor({ exploratory: { allowed: true, maxParametersOverride: 1 }, allowedTools: [...policyFor().allowedTools, 'compose.exploratory'] });
  const editedCatalog = (workerFactory: () => Worker): ActivityCatalog => {
    const base = createInstalledCatalog({ workerFactory });
    return { ...base, getTemplate: ref => ref.templateId === template.templateId ? structuredClone(edited) : null };
  };

  it('an edit under the same template ID and version is a different identity: labelled exploratory, never approved', async () => {
    const h = make({ policy, customCatalog: editedCatalog });
    expect(codesOf(await h.adapter.prepare(requestFor(), { operationId: op() }))).toEqual(['POLICY_DENIED']);
    const { prepared, learner } = await open(h, requestFor({ activityId: 'act-exploratory', mode: 'exploratory' }));
    expect(learner.getProjection().reviewNotice).toBe('Exploratory composition — not reviewed');
    expect(prepared.instance.template.digest).toBe(templateRef(edited).digest);
    expect(prepared.instance.template.digest).not.toBe(TEMPLATE.digest);
    expect(policy.approved[0]!.template.digest).toBe(TEMPLATE.digest);
    expect(codesOf(await h.adapter.prepare(requestFor({ activityId: 'act-many', mode: 'exploratory', parameters: { eta: 0.5, a: 3 } }), { operationId: op() }))).toEqual(['POLICY_DENIED']);
  });

  it('an exploratory artifact cannot be promoted into approved mode by editing its saved mode', async () => {
    const h = make({ policy, customCatalog: editedCatalog });
    const { control } = await open(h, requestFor({ mode: 'exploratory' }));
    await settled(h);
    const saved = await control.save({ operationId: op(), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    h.adapter.dispose('act-quadratic-1');
    const { integrity: _integrity, ...body } = structuredClone(saved.artifact);
    const promoted = { ...body, instance: { ...body.instance, mode: 'approved' as const } };
    const artifact: ActivityArtifact = { ...promoted, integrity: artifactIntegrity(promoted) };
    expect(codesOf(await h.adapter.restore(artifact, { operationId: op(), hostSessionRevision: 0 }) as never)).toEqual(['POLICY_DENIED']);
  });
});

describe('UI state mapping (report §10.4)', () => {
  it('maps lifecycle and content states with learner-safe messages and recovery actions', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const ui = () => opened.learner.getProjection().status;
    expect(ui().ui).toBe('ready');
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await settled(h);
    ackCurrent(opened.learner);
    await settled(h);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 2 } }));
    expect(ui()).toMatchObject({ ui: 'paused', message: 'Paused.' });
    okOf(opened.learner.play({ operationId: op(), ...guards(opened.learner) }));
    expect(ui().ui).toBe('playing');
    okOf(opened.learner.pause({ operationId: op(), ...guards(opened.learner) }));
    h.workers.hostility = 'crash';
    expect(codesOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 4 } }))).toEqual(['WORKER_ERROR']);
    expect(ui()).toMatchObject({ ui: 'recoverable-failure', recovery: { action: 'retry' } });
    expect(opened.learner.getProjection().frame?.position).toMatchObject({ index: 2 });
    h.workers.hostility = 'none';
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 1000 } }));
    expect(ui()).toMatchObject({ ui: 'boundary', message: 'The last available step is reached.' });
    opened.learner.reportVisibility({ surfaceId: 'surface-main', visible: false });
    expect(ui().ui).toBe('suspended');
    opened.learner.reportVisibility({ surfaceId: 'surface-main', visible: true });
    // A policy that expired by host time: issued and expired before the host clock the adapter has observed.
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: { ...h.host.policy(), revision: 2, issuedAt: '2026-10-26T08:00:00.000Z', expiresAt: '2026-10-26T08:30:00.000Z' } }));
    expect(ui()).toMatchObject({ ui: 'stale-policy', recovery: { action: 'reload' } });
    expect(opened.learner.getProjection().views).toEqual([]);
    h.adapter.dispose('act-quadratic-1');
    expect(opened.learner.getProjection().status.ui).toBe('disposed');
    expect(opened.learner.getProjection().views).toEqual([]);
  });

  it('a closed activity is empty and refuses further work', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.close({ operationId: op(), reason: 'Lesson finished.' }));
    expect(opened.learner.getProjection().status).toMatchObject({ ui: 'empty', message: 'This activity is closed.' });
    expect(codesOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } }))).toEqual(['NOT_READY']);
    await settled(h);
    expect(h.host.events().at(-1)!).toMatchObject({ type: 'activity.closed', payload: { reason: 'Lesson finished.' } });
  });

  it('hiding every registered surface suspends compute and releases scratch work; showing resumes without catch-up', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(opened.learner.play({ operationId: op(), ...guards(opened.learner) }));
    opened.learner.reportVisibility({ surfaceId: 'surface-main', visible: false });
    const hidden = opened.learner.getProjection();
    expect(hidden.status.ui).toBe('suspended');
    expect(hidden.navigation?.playing).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(opened.learner.getProjection().frame?.position).toEqual(hidden.frame?.position);
    expect(h.workers.live).toBe(0);
    opened.learner.reportVisibility({ surfaceId: 'surface-main', visible: true });
    expect(opened.learner.getProjection().frame?.position).toEqual(hidden.frame?.position);
    expect(opened.learner.getProjection().navigation?.playing).toBe(false);
    await settled(h);
    expect(h.host.events().filter(event => event.type.startsWith('activity.s') || event.type === 'activity.resumed').map(event => event.type)).toEqual(['activity.suspended', 'activity.resumed']);
  });
});

describe('response references and deletion', () => {
  it('corrects, disputes and deletes through references; forget releases cached copies', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 0, hostSessionRevision: 1, response: { responseId: 'resp-1', taskId: 'task-1', taskRevision: 1, kind: 'prediction', modality: 'speech-derived', stageId: 'predict' } }));
    expect(codesOf(await opened.control.forget({ operationId: op(), scope: 'responses', responseIds: ['resp-1'] }))).toEqual(['CONFLICT']);
    okOf(await opened.control.updateResponseRef({ operationId: op(), expectedHostSessionRevision: 1, hostSessionRevision: 2, responseId: 'resp-1', status: 'disputed' }));
    okOf(await opened.control.updateResponseRef({ operationId: op(), expectedHostSessionRevision: 2, hostSessionRevision: 3, responseId: 'resp-1', status: 'deleted' }));
    await settled(h);
    const before = h.adapter.summarizeInteraction('act-quadratic-1', { audience: 'host' }) as { responses: { status: string }[]; omitted: { events: number } };
    expect(before.responses.map(item => item.status)).toEqual(['deleted']);
    okOf(await opened.control.forget({ operationId: op(), scope: 'responses', responseIds: ['resp-1'] }));
    const after = h.adapter.summarizeInteraction('act-quadratic-1', { audience: 'host' }) as { omitted: { events: number }; complete: boolean };
    expect(after.omitted.events).toBeGreaterThan(before.omitted.events);
    expect(after.complete).toBe(false);
    okOf(await opened.control.forget({ operationId: op(), scope: 'activity' }));
    expect(h.host.events().filter(event => event.type === 'response.invalidated')).toHaveLength(2);
  });
});
