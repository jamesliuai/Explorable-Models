/**
 * Policy-scoped activity tools (report §5.3, §6.2 tool channel, §7.3, §8.6, §15.1, §16; A21 tool channel, A55):
 * descriptors and their declared scope against runtime behaviour, learner-visible inspection equal to the surface
 * projection, discovery and on-demand detail, preparation with personalised parameters, guarded operations,
 * proposals, host-routed reveals, summaries, save/restore/close, isolated sampling and the misuse matrix through the
 * tools and, where meaningful, the same cases through the direct adapter APIs. Fixture-host results only.
 */
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createVisualizationSession, evaluateDocument } from '../../packages/core/src/declarative/index';
import type { VisualizationSession } from '../../packages/core/src/declarative/types';
import { FORBIDDEN_TEX_COMMANDS, templateRef, type ToolOperation } from '@experiment-kit/activity';
import { prepareMath, REJECTED_TEX_COMMANDS } from '../../packages/player/src/activity/math';
import { companionText } from '../../packages/player/src/activity/capture';
import { captureMetadata, composeCaptureSvg, selectCaptureView } from '../../packages/player/src/activity/capture-renderer';
import type { ActivityBinding, LearnerProjection } from '../../packages/activity/src/api';
import {
  ACTIVITY_TOOL_DESCRIPTORS, ACTIVITY_TOOL_REASONS, AUTHORITY_FIELDS, createActivityTools, createVisualizationTools,
  type ActivityToolAudience, type ActivityToolResult,
} from '@experiment-kit/agent';
import { codesOf as bindingCodes, policyFor, requestFor, settled, template } from '../activity/support/adapter-harness.js';
import {
  ACTIVITY_ID, ALL_OPERATIONS, QUADRATIC, acknowledge, atExplore, codesOf, dataOf, expectNoRestricted, expectSafeFailure, expectedGuards, opId, prepareThroughTools, revealExploreStep, rig,
  type Rig, type RigOptions,
} from './support/activity-tools.js';

const rigs: Rig[] = [];
const sessions: VisualizationSession[] = [];
const make = (options: RigOptions = {}): Rig => { const r = rig(options); rigs.push(r); return r; };
afterEach(() => { for (const r of rigs.splice(0)) r.h.adapter.dispose(); for (const session of sessions.splice(0)) session.dispose(); });

const without = (operations: readonly ToolOperation[], removed: ToolOperation): ToolOperation[] => operations.filter(op => op !== removed);
/** Projection data covered by projectionDigest (everything but projectionId, status.live and presentation.revision). */
function covered(projection: any): unknown {
  const { projectionId: _id, status, presentation, ...rest } = JSON.parse(JSON.stringify(projection));
  const { live: _live, ...stable } = status;
  const { revision: _revision, ...view } = presentation;
  return { ...rest, status: stable, presentation: view };
}
const parameterEvents = (r: Rig) => r.h.host.events(ACTIVITY_ID).filter(event => event.type === 'parameters.committed');

/** A valid input for every tool (built from fresh guards and a fresh operationId per call) and the operations it needs. */
type Sample = { name: string; input: (expected: Record<string, unknown>) => Record<string, unknown>; operations: ToolOperation[]; audience?: ActivityToolAudience };
const SAMPLES: Sample[] = [
  { name: 'activity_discover', input: () => ({}), operations: ['discover'] },
  { name: 'activity_describe_template', input: () => ({ ...QUADRATIC }), operations: ['discover'] },
  { name: 'activity_inspect', input: () => ({}), operations: ['inspect.learner'] },
  { name: 'activity_inspect', input: () => ({ view: 'full' }), operations: ['inspect.tutor'] },
  { name: 'activity_inspect', input: () => ({ view: 'full' }), operations: ['inspect.teacher'], audience: 'teacher' },
  { name: 'activity_propose_revision', input: () => ({ operationId: opId(), proposal: { kind: 'stage', toStage: 'explore-curvature' } }), operations: ['propose-revision'] },
  { name: 'activity_request_reveal', input: expected => ({ operationId: opId(), target: { kind: 'groups', groups: ['landscape'] }, expected }), operations: ['request-reveal'] },
  { name: 'activity_operate', input: expected => ({ action: 'pause', operationId: opId(), expected }), operations: ['operate.playback'] },
  { name: 'activity_operate', input: expected => ({ action: 'reset', operationId: opId(), expected }), operations: ['operate.parameters'] },
  { name: 'activity_operate', input: expected => ({ action: 'select', operationId: opId(), target: null, expected }), operations: ['operate.presentation'] },
  { name: 'activity_operate', input: expected => ({ action: 'step', operationId: opId(), delta: 1, expected }), operations: ['operate.navigation'] },
  { name: 'activity_summarize', input: () => ({}), operations: ['summarize'] },
  { name: 'activity_save', input: () => ({ operationId: opId(), kind: 'learner-snapshot' }), operations: ['save'] },
  { name: 'activity_sample', input: () => ({ parameters: { a: 2, eta: 0.5, x0: 4 }, positions: [{ kind: 'index', index: 3 }] }), operations: ['sample'], audience: 'teacher' },
  { name: 'activity_close', input: expected => ({ operationId: opId(), reason: 'completed', expected }), operations: ['close'] },
];

describe('descriptors and their declared scope (A55)', () => {
  it('publishes twelve compact descriptors whose inputs never accept authority fields', () => {
    expect(ACTIVITY_TOOL_DESCRIPTORS.map(item => item.name)).toEqual([
      'activity_discover', 'activity_describe_template', 'activity_prepare', 'activity_inspect', 'activity_propose_revision', 'activity_request_reveal', 'activity_operate',
      'activity_summarize', 'activity_save', 'activity_restore', 'activity_close', 'activity_sample',
    ]);
    expect(JSON.stringify(ACTIVITY_TOOL_DESCRIPTORS).length).toBeLessThan(32 * 1024);
    const keys = new Set<string>();
    const walk = (schema: unknown): void => {
      if (!schema || typeof schema !== 'object') return;
      const record = schema as Record<string, unknown>;
      if (record.type === 'object' && record.properties) expect(record.additionalProperties).toBe(false);
      if (record.properties) for (const key of Object.keys(record.properties as object)) keys.add(key);
      for (const value of Object.values(record)) walk(value);
    };
    for (const descriptor of ACTIVITY_TOOL_DESCRIPTORS) {
      walk(descriptor.inputSchema);
      expect(descriptor.outputSchema).toBeTruthy();
      expect(descriptor.scope.audiences.length).toBeGreaterThan(0);
      const takesOperationId = JSON.stringify(descriptor.inputSchema).includes('"operationId"');
      expect(takesOperationId, descriptor.name).toBe(descriptor.scope.mutates);
    }
    for (const field of AUTHORITY_FIELDS) expect(keys.has(field), field).toBe(false);
  });

  it('the published schema file is exactly the runtime descriptors', () => {
    const published = JSON.parse(readFileSync(new URL('../../docs/study-harness/activity-tool-schemas.json', import.meta.url), 'utf8'));
    expect(published, 'regenerate with npm run build:packages (scripts/generate-api.mjs)').toEqual(JSON.parse(JSON.stringify(ACTIVITY_TOOL_DESCRIPTORS)));
  });

  it('enforces every declared operation, audience and host route at run time', async () => {
    const base = make({ audience: 'tutor', policy: { inspection: { developer: false, tutor: 'full', teacher: true } } });
    await prepareThroughTools(base, { stageId: 'explore-step' });
    const call = async (tools: ReturnType<typeof createActivityTools>, sample: Sample) => tools.execute(sample.name, sample.input(await expectedGuards(base)));
    const reason = (result: ActivityToolResult) => result.ok ? null : result.diagnostics[0]!.message;
    for (const sample of SAMPLES) {
      const audience = sample.audience ?? 'tutor';
      const descriptor = ACTIVITY_TOOL_DESCRIPTORS.find(item => item.name === sample.name)!;
      const declared = [...descriptor.scope.operations, ...Object.values(descriptor.scope.variants ?? {}).flat()];
      for (const op of sample.operations) expect(declared, `${sample.name} declares ${op}`).toContain(op);
      const tutor = () => ({ binding: base.prepared().binding('tutor', 'tool-executor'), host: base.prepared().host });
      const granted = createActivityTools({ ...base.context, audience, ...tutor() });
      const allowed = await call(granted, sample);
      expect(allowed.ok, `${sample.name} with its grant: ${JSON.stringify(allowed).slice(0, 300)}`).toBe(true);
      for (const op of sample.operations) {
        const ungranted = createActivityTools({ ...base.context, audience, allowedOperations: without(ALL_OPERATIONS, op), ...tutor() });
        const denied = await call(ungranted, sample);
        expect(codesOf(denied), `${sample.name} without grant ${op}`).toEqual(['POLICY_DENIED']);
        expect(reason(denied)).toBe(ACTIVITY_TOOL_REASONS['not-granted'].message);
        // Granted by the host but not allowed by the current policy (same revision).
        const guards = await expectedGuards(base);
        const policy = base.h.host.policy();
        // (A policy that allows sampling must list the sample tool, so that flag is withdrawn together with it.)
        base.h.host.setPolicy({ ...policy, allowedTools: without(policy.allowedTools, op), ...(op === 'sample' ? { sampling: { allowed: false, maxPositions: 0 } } : {}) });
        const disallowed = await granted.execute(sample.name, sample.input(guards));
        base.h.host.setPolicy(policy);
        expect(codesOf(disallowed), `${sample.name} without policy ${op}`).toEqual(['POLICY_DENIED']);
        expect(reason(disallowed)).toBe(ACTIVITY_TOOL_REASONS['not-allowed'].message);
      }
      for (const other of (['learner-visible', 'tutor', 'teacher'] as const).filter(item => !descriptor.scope.audiences.includes(item))) {
        const wrong = createActivityTools({ ...base.context, audience: other, ...tutor() });
        const result = await call(wrong, sample);
        expect(codesOf(result), `${sample.name} for ${other}`).toEqual(['POLICY_DENIED']);
        expect(reason(result)).toBe(ACTIVITY_TOOL_REASONS.audience.message);
      }
      if (descriptor.scope.hostRoute) {
        const unrouted = createActivityTools({ ...base.context, audience, binding: base.prepared().binding('tutor', 'tool-executor') });
        const result = await call(unrouted, sample);
        expect(codesOf(result)).toEqual(['POLICY_DENIED']);
        expect(reason(result)).toBe(ACTIVITY_TOOL_REASONS['no-host-route'].message);
      }
    }
  });

  it('prepare and restore declare an absent activity and the host lifecycle, and enforce both', async () => {
    const r = make();
    const noLifecycle = createActivityTools({ ...r.context, lifecycle: undefined } as never);
    expect(codesOf(await noLifecycle.execute('activity_prepare', { operationId: opId(), template: QUADRATIC }))).toEqual(['POLICY_DENIED']);
    expect(codesOf(await noLifecycle.execute('activity_restore', { operationId: opId(), artifactId: 'artifact-1' }))).toEqual(['POLICY_DENIED']);
    const ungranted = createActivityTools({ ...r.context, allowedOperations: without(ALL_OPERATIONS, 'prepare') });
    expect(codesOf(await ungranted.execute('activity_prepare', { operationId: opId(), template: QUADRATIC }))).toEqual(['POLICY_DENIED']);
    await prepareThroughTools(r);
    expect(codesOf(await r.tools.execute('activity_prepare', { operationId: opId(), template: QUADRATIC }))).toEqual(['CONFLICT']);
    expect(codesOf(await r.tools.execute('activity_restore', { operationId: opId(), artifactId: 'artifact-1' }))).toEqual(['CONFLICT']);
    expect(r.h.host.calls('registerActivity')).toHaveLength(1);
  });

  it('validates input with the published schemas: unknown, authority and missing fields name the exact path', async () => {
    const r = make();
    await prepareThroughTools(r);
    const expected = await expectedGuards(r);
    const unknown = await r.tools.execute('activity_operate', { action: 'pause', operationId: opId(), expected, extra: 1 });
    expect(unknown.ok ? null : unknown.diagnostics[0]).toMatchObject({ code: 'INVALID_INPUT', path: '$.extra', message: ACTIVITY_TOOL_REASONS['unknown-field'].message });
    for (const field of ['actor', 'origin', 'sessionId', 'activityId', 'review', 'principal']) {
      const result = await r.tools.execute('activity_operate', { action: 'pause', operationId: opId(), expected, [field]: field === 'actor' ? 'host' : 'x' });
      expect(result.ok ? null : result.diagnostics[0], field).toMatchObject({ code: 'INVALID_INPUT', path: `$.${field}`, message: ACTIVITY_TOOL_REASONS['authority-field'].message });
    }
    const missing = await r.tools.execute('activity_operate', { action: 'commit-parameters', operationId: opId(), expected });
    expect(missing.ok ? null : missing.diagnostics[0]).toMatchObject({ path: '$.values', message: ACTIVITY_TOOL_REASONS.required.message });
    const wrongAction = await r.tools.execute('activity_operate', { action: 'teleport', operationId: opId(), expected });
    expect(wrongAction.ok ? null : wrongAction.diagnostics[0]).toMatchObject({ path: '$.action' });
    const badGuard = await r.tools.execute('activity_operate', { action: 'pause', operationId: opId(), expected: { ...expected, scientificVersion: -1 } });
    expect(badGuard.ok ? null : badGuard.diagnostics[0]).toMatchObject({ path: '$.expected.scientificVersion', message: ACTIVITY_TOOL_REASONS.shape.message });
    expect(codesOf(await r.tools.execute('visualization_create', {}))).toEqual(['UNSUPPORTED_CAPABILITY']);
  });
});

describe('learner-visible inspection is the surface projection (A21 tool channel)', () => {
  it('returns exactly the projection-digest-covered data at prediction, after reveal and after a commit', async () => {
    const r = make({ audience: 'learner-visible' });
    await prepareThroughTools(r);
    const check = async () => {
      await settled(r.h);
      const inspected = dataOf(await r.tools.execute('activity_inspect', {}));
      const surface = r.learner().getProjection();
      expect(inspected.projection.projectionDigest).toBe(surface.projectionDigest);
      expect(covered(inspected.projection)).toEqual(covered(surface));
      expect(Object.keys(inspected).sort()).toEqual(['expected', 'projection', 'view']);
      return inspected;
    };
    expectNoRestricted(JSON.stringify(await check()));
    await revealExploreStep(r);
    await check();
    dataOf(await r.tools.execute('activity_operate', { action: 'commit-parameters', operationId: opId(), values: { eta: 0.75 }, expected: await expectedGuards(r) }));
    const after = await check();
    expect(after.projection.controls.find((control: { parameter: string }) => control.parameter === 'eta').value).toBe(0.75);
  });

  it('stays equal in an independent task, which needs a host re-authorization', async () => {
    const r = make({ audience: 'learner-visible' });
    await atExplore(r);
    const independent = policyFor({
      allowedTools: ALL_OPERATIONS, revision: 2, issuedAt: '2026-10-26T08:30:00.000Z',
      independentTask: { active: true, taskRef: 'task-new-curvature', permittedTools: ['inspect.learner', 'summarize'], neutralScaffold: ['landscape'] },
    });
    r.h.host.setPolicy(independent);
    const entered = await r.prepared().host.enterIndependentTask({ operationId: opId('independent'), taskRef: 'task-new-curvature', policy: independent });
    expect(entered.ok).toBe(true);
    // The executor was authorized under revision 1: everything is stale until the host binds a new tool set.
    expect(codesOf(await r.tools.execute('activity_inspect', {}))).toEqual(['STALE_POLICY_REVISION']);
    const rebound = createActivityTools({ ...r.context, policyRevision: 2, binding: r.prepared().binding('tutor', 'tool-executor'), host: r.prepared().host });
    await settled(r.h);
    const inspected = dataOf(await rebound.execute('activity_inspect', {}));
    expect(covered(inspected.projection)).toEqual(covered(r.learner().getProjection()));
    expect(inspected.projection.context).toBe('independent');
    expect(inspected.projection.views.map((view: { viewId: string }) => view.viewId)).toEqual(['landscape']);
    expect(codesOf(await rebound.execute('activity_operate', { action: 'pause', operationId: opId(), expected: inspected.expected }))).toEqual(['INDEPENDENT_CONTEXT']);
    expect(codesOf(await rebound.execute('activity_request_reveal', { operationId: opId(), target: { kind: 'groups', groups: ['trace'] }, expected: inspected.expected }))).toEqual(['INDEPENDENT_CONTEXT']);
  });

  it('full inspection needs both the host grant and the inspection policy, and never reaches cached receipts', async () => {
    const learnerOnly = make({ audience: 'tutor' });
    await prepareThroughTools(learnerOnly);
    expect(codesOf(await learnerOnly.tools.execute('activity_inspect', { view: 'full' }))).toEqual(['POLICY_DENIED']);
    const visible = createActivityTools({ ...learnerOnly.context, audience: 'learner-visible', binding: learnerOnly.prepared().binding('tutor', 'tool-executor') });
    expect(codesOf(await visible.execute('activity_inspect', { view: 'full' }))).toEqual(['POLICY_DENIED']);

    const teacher = make({ audience: 'teacher', policy: { inspection: { developer: false, tutor: 'learner-visible', teacher: true } } });
    await prepareThroughTools(teacher);
    const full = dataOf(await teacher.tools.execute('activity_inspect', { view: 'full' }));
    expect(full.state.scientific.params).toEqual({ a: 2, eta: 0.25, x0: 4 });
    expect(full.state.exposures).toEqual([]);
    const ungranted = createActivityTools({ ...teacher.context, allowedOperations: without(ALL_OPERATIONS, 'inspect.teacher'), binding: teacher.prepared().binding('tutor', 'tool-executor') });
    expect(codesOf(await ungranted.execute('activity_inspect', { view: 'full' }))).toEqual(['POLICY_DENIED']);
    const operation = { action: 'select', operationId: opId(), target: null, expected: await expectedGuards(teacher) };
    const first = dataOf(await teacher.tools.execute('activity_operate', operation));
    const replay = dataOf(await teacher.tools.execute('activity_operate', operation));
    expect(replay).toEqual(first);
    expect(JSON.stringify(replay)).not.toContain('"scientific"');
    expect(JSON.stringify(replay)).not.toContain('"exposures"');
  });
});

describe('discovery and on-demand template detail', () => {
  it('lists only approved exact versions with separate validation, review and activity scope, and unsupported alternatives', async () => {
    const r = make();
    const result = await r.tools.execute('activity_discover', {});
    const data = dataOf(result);
    expect(data.templates).toHaveLength(1);
    const [entry] = data.templates;
    expect(entry.template).toEqual(templateRef(template));
    expect(entry.availability).toBe('approved');
    expect(entry.review).toEqual({ lifecycle: 'reference-checked', scope: 'no independent subject review' });
    expect(entry.validation.kind).toBe('technical');
    expect(entry.controls.map((control: { parameter: string }) => control.parameter)).toEqual(['eta', 'a', 'x0']);
    expect(data.unsupported.find((item: { capability: string }) => item.capability === 'general-ode-solving').alternative).toMatch(/not installed/);
    expect(data.operations).toEqual(ALL_OPERATIONS);
    expect(result.ok && result.scope).toMatchObject({ validation: { kind: 'technical' }, review: null, activity: null });
    expect(JSON.stringify(data)).not.toMatch(/independently reviewed/i);

    const exploratory = make({ policy: { exploratory: { allowed: true, maxParametersOverride: 3 } } });
    const listed = dataOf(await exploratory.tools.execute('activity_discover', {}));
    expect(listed.templates.length).toBe(5);
    expect(listed.templates.filter((item: { availability: string }) => item.availability === 'exploratory-only')).toHaveLength(4);
    const limited = createActivityTools({ ...r.context, allowedOperations: ['discover', 'inspect.learner'] });
    expect(dataOf(await limited.execute('activity_discover', {})).operations).toEqual(['discover', 'inspect.learner']);
  });

  it('returns learner-safe detail by default and full detail only for an authorized teacher', async () => {
    const tutor = make();
    const safe = dataOf(await tutor.tools.execute('activity_describe_template', { ...QUADRATIC }));
    expect(safe.detail).toBe('learner-safe');
    expect(safe).not.toHaveProperty('equations');
    expect(safe).not.toHaveProperty('constraints');
    expect(safe.stages.find((stage: { id: string }) => stage.id === 'predict')).not.toHaveProperty('instruction');
    expectNoRestricted(JSON.stringify(safe));
    expect(safe.controls.every((control: { personalisable: boolean }) => control.personalisable)).toBe(true);
    expect(safe.groups.find((group: { id: string }) => group.id === 'trace').solutionBearing).toBe(true);
    const teacher = make({ audience: 'teacher' });
    const full = dataOf(await teacher.tools.execute('activity_describe_template', { ...QUADRATIC }));
    expect(full.detail).toBe('full');
    expect(full.equations.map((equation: { id: string }) => equation.id)).toContain('substituted-update');
    expect(full.constraints).toHaveLength(1);
    const deniedTeacher = make({ audience: 'teacher', policy: { inspection: { developer: false, tutor: 'learner-visible', teacher: false } } });
    expect(dataOf(await deniedTeacher.tools.execute('activity_describe_template', { ...QUADRATIC })).detail).toBe('learner-safe');
    expect(codesOf(await tutor.tools.execute('activity_describe_template', { templateId: 'linear-transformation', version: '1.0.0' }))).toEqual(['INVALID_REFERENCE']);
    expect(codesOf(await tutor.tools.execute('activity_describe_template', { templateId: 'general-ode', version: '1.0.0' }))).toEqual(['INVALID_REFERENCE']);
  });
});

describe('preparation with personalised parameters', () => {
  it('prepares the bound activity with permitted parameters; the host owns the activity, session and objectives', async () => {
    const r = make();
    const prepared = await prepareThroughTools(r, { parameters: { eta: 0.5, x0: -3 } });
    expect(prepared.activityId).toBe(ACTIVITY_ID);
    expect(prepared.authorization).toEqual({ current: true });
    expect(prepared.validation.defaultsEvaluated).toBe(true);
    const registered = r.h.host.calls('registerActivity')[0]!.request as { instance: { activityId: string; hostSessionId: string; objectiveIds: string[]; initialParameters: Record<string, number> } };
    expect(registered.instance).toMatchObject({ activityId: ACTIVITY_ID, hostSessionId: 'session-1', objectiveIds: ['obj-step-size'], initialParameters: { a: 2, eta: 0.5, x0: -3 } });
    expect(prepared.projection.controls.map((control: { parameter: string; value: number }) => [control.parameter, control.value])).toEqual([['eta', 0.5], ['a', 2], ['x0', -3]]);
    expect(parameterEvents(r)[0]!.actor.kind).toBe('host');
    expect(r.binds).toBe(1);
  });

  it('rejects non-personalisable, out-of-domain and unknown requests before anything is registered, with repairable paths', async () => {
    const r = make({ policy: { permittedControls: ['eta', 'a'] } });
    const notPermitted = await r.tools.execute('activity_prepare', { operationId: opId(), template: QUADRATIC, parameters: { x0: 1 } });
    expect(notPermitted.ok ? null : notPermitted.diagnostics[0]).toMatchObject({ code: 'POLICY_DENIED', path: '$.parameters.x0', message: ACTIVITY_TOOL_REASONS.personalisation.message });
    const outOfDomain = await r.tools.execute('activity_prepare', { operationId: opId(), template: QUADRATIC, parameters: { eta: 3 } });
    expect(outOfDomain.ok ? null : outOfDomain.diagnostics[0]).toMatchObject({ code: 'OUT_OF_DOMAIN', path: '$.parameters.eta' });
    const constraint = await r.tools.execute('activity_prepare', { operationId: opId(), template: QUADRATIC, parameters: { eta: 1, a: 9 } });
    expect(codesOf(constraint)).toEqual(['CONSTRAINT_VIOLATION']);
    expectSafeFailure(constraint);
    expect(codesOf(await r.tools.execute('activity_prepare', { operationId: opId(), template: { templateId: 'general-ode', version: '1.0.0' } }))).toEqual(['INVALID_REFERENCE']);
    expect(codesOf(await r.tools.execute('activity_prepare', { operationId: opId(), template: QUADRATIC, scenarioId: 'step-9' }))).toEqual(['INVALID_REFERENCE']);
    expect(r.h.host.calls('registerActivity')).toHaveLength(0);
    // Repair: the same request within the domain, with a new operation ID.
    expect(dataOf(await r.tools.execute('activity_prepare', { operationId: opId(), template: QUADRATIC, parameters: { eta: 0.5 } })).projection.stage.id).toBe('predict');
  });
});

describe('guarded operations through the tutor binding', () => {
  it('commits, navigates, plays and changes presentation with guards; attribution is the tutor binding', async () => {
    const r = make();
    await atExplore(r);
    const before = await expectedGuards(r);
    const committed = dataOf(await r.tools.execute('activity_operate', { action: 'commit-parameters', operationId: opId(), values: { eta: 0.75 }, expected: before }));
    expect(committed.expected.runId).not.toBe(before.runId);
    expect(committed.projection.navigation.value).toBe(0);
    expect(parameterEvents(r).at(-1)!.actor).toEqual({ kind: 'tutor', binding: 'tool-executor' });
    const stepped = dataOf(await r.tools.execute('activity_operate', { action: 'step', operationId: opId(), delta: 1, expected: committed.expected }));
    expect(stepped.projection.navigation.value).toBe(1);
    const navigated = dataOf(await r.tools.execute('activity_operate', { action: 'navigate', operationId: opId(), position: { kind: 'index', index: 5 }, expected: stepped.expected }));
    expect(navigated.projection.navigation.value).toBe(5);
    expect(navigated.expected.runId).toBe(committed.expected.runId);
    const camera = dataOf(await r.tools.execute('activity_operate', { action: 'set-camera', operationId: opId(), viewId: 'landscape', camera: { kind: '2d', center: [0, 10], zoom: 2 }, expected: navigated.expected }));
    expect(camera.expected.presentationRevision).toBe(navigated.expected.presentationRevision + 1);
    expect(camera.expected.runId).toBe(navigated.expected.runId);
    const played = dataOf(await r.tools.execute('activity_operate', { action: 'play', operationId: opId(), expected: camera.expected }));
    expect(played.projection.navigation.playing).toBe(true);
    dataOf(await r.tools.execute('activity_operate', { action: 'pause', operationId: opId(), expected: await expectedGuards(r) }));
    const selected = dataOf(await r.tools.execute('activity_operate', { action: 'select', operationId: opId(), target: 'landscape', expected: await expectedGuards(r) }));
    expect(selected.projection.presentation.selection).toBe('landscape');
  });

  it('stale guards fail with a repairable path and change nothing; expected revisions grant nothing', async () => {
    const r = make();
    await atExplore(r);
    const guards = await expectedGuards(r);
    dataOf(await r.tools.execute('activity_operate', { action: 'commit-parameters', operationId: opId(), values: { eta: 0.5 }, expected: guards }));
    const count = parameterEvents(r).length;
    const stale = await r.tools.execute('activity_operate', { action: 'commit-parameters', operationId: opId(), values: { eta: 1 }, expected: guards });
    expect(stale.ok ? null : stale.diagnostics[0]).toMatchObject({ code: 'STALE_MODEL_REVISION', path: '$.expected.scientificVersion' });
    expectSafeFailure(stale);
    const forged = await r.tools.execute('activity_operate', { action: 'commit-parameters', operationId: opId(), values: { eta: 1 }, expected: { ...(await expectedGuards(r)), policyRevision: 99 } });
    expect(forged.ok ? null : forged.diagnostics[0]).toMatchObject({ code: 'STALE_POLICY_REVISION', path: '$.expected.policyRevision' });
    // A current guard does not elevate: the fixed curvature control stays fixed in this stage.
    const fixed = await r.tools.execute('activity_operate', { action: 'commit-parameters', operationId: opId(), values: { a: 3 }, expected: await expectedGuards(r) });
    expect(codesOf(fixed)).toEqual(['POLICY_DENIED']);
    expect(fixed.ok ? null : fixed.diagnostics[0]!.path).toBe('$.values.a');
    expect(parameterEvents(r)).toHaveLength(count);
  });
});

describe('bounded proposals', () => {
  it('checks parameter, scenario and stage proposals without changing anything and hints the applying tool', async () => {
    const r = make();
    await atExplore(r);
    const others = () => r.h.host.events(ACTIVITY_ID).filter(event => event.type !== 'parameters.committed').length;
    const events = others();
    const parameters = dataOf(await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'parameters', values: { eta: 0.75 } } }));
    expect(parameters.verdict).toBe('acceptable');
    expect(parameters.apply.tool).toBe('activity_operate');
    expect(dataOf(await r.tools.execute('activity_operate', { ...parameters.apply.input, operationId: opId() })).projection.controls[0].value).toBe(0.75);
    const scenario = dataOf(await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'scenario', scenarioId: 'step-1.25' } }));
    expect(scenario.apply.input).toMatchObject({ action: 'apply-scenario', scenarioId: 'step-1.25' });
    const stage = dataOf(await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'stage', toStage: 'explore-curvature' } }));
    expect(stage.verdict).toBe('host-decision-required');
    expect(stage.apply.tool).toBe('activity_request_reveal');
    await settled(r.h);
    expect(others()).toBe(events);
    expect(codesOf(await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'parameters', values: { eta: 5 } } }))).toEqual(['OUT_OF_DOMAIN']);
    expect(codesOf(await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'parameters', values: { a: 3 } } }))).toEqual(['POLICY_DENIED']);
    expect(codesOf(await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'scenario', scenarioId: 'step-9' } }))).toEqual(['NOT_FOUND']);
    expect(codesOf(await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'stage', toStage: 'free-explore' } }))).toEqual(['INVALID_REFERENCE']);
    const edit = await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'template-edit', views: [] } });
    expect(edit.ok ? null : edit.diagnostics[0]!.path).toBe('$.proposal.kind');
  });

  it('reports a coupled constraint violation for a combined proposal', async () => {
    const r = make();
    await prepareThroughTools(r, { stageId: 'free-explore' });
    const violation = await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'parameters', values: { a: 10, eta: 0.5 } } });
    expect(codesOf(violation)).toEqual(['CONSTRAINT_VIOLATION']);
    expectSafeFailure(violation);
  });

  it('exploratory composition is a separate candidate labelled exploratory, not reviewed, and only where the policy allows it', async () => {
    const session = await createVisualizationSession({ evaluator: { evaluate: async request => evaluateDocument(request), dispose() {} } });
    sessions.push(session);
    const composition = createVisualizationTools({ session });
    const discovered = await composition.execute('visualization_discover', { includeExample: true, includeSchema: false });
    const example = (discovered.ok ? discovered.data : null) as { example: Record<string, unknown> };
    const approved = make({ composition });
    await prepareThroughTools(approved);
    const denied = await approved.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'exploratory-composition', document: example.example } });
    expect(denied.ok ? null : denied.diagnostics[0]).toMatchObject({ code: 'POLICY_DENIED', message: ACTIVITY_TOOL_REASONS['exploratory-mode'].message });

    const r = make({ composition, policy: { mode: 'exploratory', exploratory: { allowed: true, maxParametersOverride: 3 } } });
    await prepareThroughTools(r);
    const digest = templateRef(r.h.catalog.getTemplate(QUADRATIC)!).digest;
    const proposed = await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'exploratory-composition', document: example.example } });
    const data = dataOf(proposed);
    expect(data).toMatchObject({ verdict: 'exploratory-candidate', label: 'exploratory, not reviewed', template: null });
    expect(proposed.ok && proposed.scope.review).toEqual({ lifecycle: 'exploratory', scope: 'exploratory, not reviewed' });
    expect(templateRef(r.h.catalog.getTemplate(QUADRATIC)!).digest).toBe(digest);
    // Guessed candidate IDs: the activity tools take none, and the document tools do not resolve one either.
    const guessed = await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'exploratory-composition', candidateId: 'candidate-guess', edits: [{ op: 'metadata', title: 'x' }] } });
    expect(guessed.ok ? null : guessed.diagnostics[0]).toMatchObject({ code: 'INVALID_INPUT', path: '$.proposal.candidateId' });
    const inspected = await composition.execute('visualization_inspect', {});
    const guard = { ...(inspected.ok ? (inspected.data as { guard: Record<string, unknown> }).guard : {}), operationId: 'guessed-commit' };
    expect((await composition.execute('visualization_commit', { candidateId: 'candidate-guess', guard })).ok).toBe(false);
    const unsafe = [
      { ...example.example, title: '<script>alert(1)</script>' },
      { ...example.example, views: [{ id: 'eq', type: 'equation', title: 'Rule', equation: '\\href{javascript:alert(1)}{x}' }] },
      { ...example.example, views: [{ id: 'eq', type: 'equation', title: 'Rule', equation: '\\def\\x{\\x}\\x' }] },
      { ...example.example, description: 'See https://evil.example/payload.js' },
    ];
    for (const document of unsafe) {
      const result = await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'exploratory-composition', document } });
      expect(result.ok ? null : result.diagnostics[0]!.message).toBe(ACTIVITY_TOOL_REASONS['unsafe-text'].message);
    }
    const forgedReview = await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'exploratory-composition', document: { ...example.example, provenance: { review: 'reviewed', checks: 'author' } } } });
    expect(codesOf(forgedReview)).toContain('INVALID_INPUT');
    expect(forgedReview.ok ? '' : forgedReview.diagnostics[0]!.path).toMatch(/^\$\.proposal\.document/);
    const impersonation = await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'exploratory-composition', document: { ...example.example, id: QUADRATIC.templateId } } });
    expect(impersonation.ok ? null : impersonation.diagnostics[0]!.message).toBe(ACTIVITY_TOOL_REASONS['template-identity'].message);
    const noCompose = createActivityTools({ ...r.context, allowedOperations: without(ALL_OPERATIONS, 'compose.exploratory'), binding: r.prepared().binding('tutor', 'tool-executor') });
    expect(codesOf(await noCompose.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'exploratory-composition', document: example.example } }))).toEqual(['POLICY_DENIED']);
  });
});

describe('one hostile-TeX list for the tools and the learner surface (A35, §16)', () => {
  it('the exploratory screen refuses exactly the commands the learner math renderer refuses', async () => {
    expect(REJECTED_TEX_COMMANDS).toBe(FORBIDDEN_TEX_COMMANDS);
    const session = await createVisualizationSession({ evaluator: { evaluate: async request => evaluateDocument(request), dispose() {} } });
    sessions.push(session);
    const composition = createVisualizationTools({ session });
    const discovered = await composition.execute('visualization_discover', { includeExample: true, includeSchema: false });
    const example = (discovered.ok ? discovered.data : null) as { example: Record<string, unknown> };
    const r = make({ composition, policy: { mode: 'exploratory', exploratory: { allowed: true, maxParametersOverride: 3 } } });
    await prepareThroughTools(r);
    for (const command of FORBIDDEN_TEX_COMMANDS) {
      const equation = `x + \\${command}{y}`;
      expect(prepareMath(equation), command).toMatchObject({ ok: false, reason: 'rejected-command' });
      const document = { ...example.example, views: [{ id: 'eq', type: 'equation', title: 'Rule', equation }] };
      const result = await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'exploratory-composition', document } });
      expect(result.ok ? null : result.diagnostics[0]!.message, command).toBe(ACTIVITY_TOOL_REASONS['unsafe-text'].message);
    }
    // A longer control word that merely starts with a refused name passes both screens alike.
    expect(prepareMath('\\urlx + \\letter').ok).toBe(true);
  });
});

describe('host-routed reveal', () => {
  it('authorizes through the host, records tutor attribution and waits for the surface acknowledgement', async () => {
    const r = make();
    await prepareThroughTools(r);
    const result = dataOf(await r.tools.execute('activity_request_reveal', { operationId: opId(), target: { kind: 'stage', toStage: 'explore-step' }, expected: await expectedGuards(r) }));
    expect(result).toMatchObject({ status: 'authorized', display: 'awaiting-display' });
    expect(result.labels.length).toBeGreaterThan(0);
    expect(result.note).toMatch(/not evidence/);
    await settled(r.h);
    expect(r.h.host.exposures(ACTIVITY_ID).map(record => record.displayStatus)).toEqual(['authorized']);
    acknowledge(r);
    await settled(r.h);
    expect(r.h.host.exposures(ACTIVITY_ID).map(record => record.displayStatus)).toEqual(['displayed']);
    const requested = r.h.host.events(ACTIVITY_ID).find(event => event.type === 'reveal.requested')!;
    expect(requested.actor).toEqual({ kind: 'tutor', binding: 'host-control' });
    expect(r.learner().getProjection().views.map(view => view.viewId)).toContain('trace-plot');
  });

  it('reports pending when the host did not record it and resends the same request on retry', async () => {
    const r = make();
    await prepareThroughTools(r);
    r.h.host.failNext('requestStageTransition', 'throw');
    const input = { operationId: opId(), target: { kind: 'stage', toStage: 'explore-step' }, expected: await expectedGuards(r) };
    const pending = dataOf(await r.tools.execute('activity_request_reveal', input));
    expect(pending.status).toBe('pending');
    expect(pending.diagnostics[0].code).toBe('PERSISTENCE_FAILED');
    expect(r.learner().getProjection().views.map(view => view.viewId)).not.toContain('trace-plot');
    const retried = dataOf(await r.tools.execute('activity_request_reveal', input));
    expect(retried.status).toBe('authorized');
    await settled(r.h);
    expect(r.h.host.events(ACTIVITY_ID).filter(event => event.type === 'stage.changed')).toHaveLength(1);
    expect(r.h.host.receipts(ACTIVITY_ID)).toHaveLength(1);
  });

  it('reports denied, never pending, when the host refuses the reveal, and does not resend it', async () => {
    const r = make();
    await prepareThroughTools(r);
    for (const code of ['POLICY_DENIED', 'INVALID_INPUT'] as const) {
      r.h.host.failNext('requestStageTransition', 'reject', { code });
      const input = { operationId: opId(), target: { kind: 'stage', toStage: 'explore-step' }, expected: await expectedGuards(r) };
      const denied = dataOf(await r.tools.execute('activity_request_reveal', input));
      expect(denied.status, code).toBe('denied');
      expect(denied.diagnostics).toEqual([expect.objectContaining({ code, path: '$', message: ACTIVITY_TOOL_REASONS['host-refused'].message })]);
      expect(r.learner().getProjection().views.map(view => view.viewId)).not.toContain('trace-plot');
      expect(r.learner().getProjection().pendingReveal).toBeNull();
      expect(dataOf(await r.tools.execute('activity_request_reveal', input)).status).toBe('denied');
    }
    expect(r.h.host.calls('requestStageTransition').map(call => call.outcome)).toEqual(['rejected', 'rejected']);
    await settled(r.h);
    expect(r.h.host.events(ACTIVITY_ID).filter(event => event.type === 'stage.changed')).toEqual([]);
  });

  it('reports denied for groups the stage or policy does not permit, and nothing is shown', async () => {
    const r = make();
    await atExplore(r);
    const denied = dataOf(await r.tools.execute('activity_request_reveal', { operationId: opId(), target: { kind: 'groups', groups: ['regime'] }, expected: await expectedGuards(r) }));
    expect(denied.status).toBe('denied');
    expect(denied.diagnostics[0].code).toBe('POLICY_DENIED');
    expect(JSON.stringify(r.learner().getProjection())).not.toContain('"regime"');
    expect(codesOf(await r.tools.execute('activity_request_reveal', { operationId: opId(), target: { kind: 'groups', groups: ['answers'] }, expected: await expectedGuards(r) }))).toEqual(['INVALID_REFERENCE']);
  });
});

describe('summaries, save, restore and close', () => {
  it('summarizes for the tool set audience and only with visible values', async () => {
    const r = make({ audience: 'learner-visible' });
    await prepareThroughTools(r);
    const summary = dataOf(await r.tools.execute('activity_summarize', {}));
    expect(summary.audience).toBe('learner');
    expect(summary.summary.audience).toBe('learner');
    expectNoRestricted(JSON.stringify(summary));
    const teacher = make({ audience: 'teacher', policy: { inspection: { developer: false, tutor: 'learner-visible', teacher: false } } });
    await prepareThroughTools(teacher);
    expect(codesOf(await teacher.tools.execute('activity_summarize', {}))).toEqual(['POLICY_DENIED']);
    expect(codesOf(await r.tools.execute('activity_summarize', { limits: { committedConfigurations: 99 } }))).toEqual(['INVALID_INPUT']);
  });

  it('saves through the host as a reference, restores only the bound activity by ID, and closes', async () => {
    const r = make();
    await atExplore(r);
    const saved = dataOf(await r.tools.execute('activity_save', { operationId: opId(), kind: 'backup' }));
    expect(saved).toMatchObject({ kind: 'backup', storedBy: 'host', restorable: true });
    expect(JSON.stringify(saved)).not.toMatch(/"scientific"|"exposures"|"instance"/);
    expect(r.h.host.artifacts().map(artifact => artifact.artifactId)).toContain(saved.artifactId);
    const closed = dataOf(await r.tools.execute('activity_close', { operationId: opId(), reason: 'completed', expected: await expectedGuards(r) }));
    expect(closed.closed).toBe(true);
    expect(r.h.host.events(ACTIVITY_ID).at(-1)!.type).toBe('activity.closed');
    r.h.adapter.dispose(ACTIVITY_ID);
    expect(codesOf(await r.tools.execute('activity_restore', { operationId: opId(), artifactId: 'artifact-guess' }))).toEqual(['NOT_FOUND']);
    expect(codesOf(await r.tools.execute('activity_restore', { operationId: opId(), artifactId: 'https://evil.example/artifact.json' }))).toEqual(['INVALID_INPUT']);
    const restored = dataOf(await r.tools.execute('activity_restore', { operationId: opId(), artifactId: saved.artifactId }));
    // The backup predates the close, but the host closed the activity: the host's activity state governs a restore
    // (report §14; R01, R04), so it reopens read-only instead of reopening work the host ended.
    expect(restored.restored).toBe('read-only');
    expect(restored.projection.stage.id).toBe('explore-step');
    expect(restored.projection.status.ui).toBe('empty');
    expect(restored.projection.views).toEqual([]);
    expect(restored.projection.navigation?.playing ?? false).toBe(false);
    expect(r.binds).toBe(2);
    const other = make({ activityId: 'act-other' });
    expect(codesOf(await other.tools.execute('activity_restore', { operationId: opId(), artifactId: saved.artifactId }))).toEqual(['NOT_FOUND']);
  });
});

describe('isolated sampling (§8.6)', () => {
  it('samples for an authorized teacher without changing the learner run, and is unavailable otherwise', async () => {
    const teacher = make({ audience: 'teacher' });
    await prepareThroughTools(teacher);
    const before = await expectedGuards(teacher);
    const events = teacher.h.host.events(ACTIVITY_ID).length;
    const sample = dataOf(await teacher.tools.execute('activity_sample', { parameters: { a: 2, eta: 1.5, x0: 4 }, positions: [{ kind: 'index', index: 2 }] }));
    expect(sample.frames).toHaveLength(1);
    expect(sample.provenance.model).toEqual(template.model);
    expect(await expectedGuards(teacher)).toEqual(before);
    await settled(teacher.h);
    expect(teacher.h.host.events(ACTIVITY_ID)).toHaveLength(events);
    expect(ACTIVITY_TOOL_DESCRIPTORS.find(item => item.name === 'activity_sample')!.scope).toMatchObject({ mutates: false, audiences: ['teacher'] });
    for (const audience of ['tutor', 'learner-visible'] as const) {
      const tools = createActivityTools({ ...teacher.context, audience, binding: teacher.prepared().binding('tutor', 'tool-executor') });
      expect(codesOf(await tools.execute('activity_sample', { parameters: { a: 2, eta: 1.5, x0: 4 }, positions: [{ kind: 'index', index: 2 }] }))).toEqual(['POLICY_DENIED']);
    }
    teacher.h.host.setPolicy({ ...teacher.h.host.policy(), sampling: { allowed: false, maxPositions: 0 } });
    expect(codesOf(await teacher.tools.execute('activity_sample', { parameters: { a: 2, eta: 1.5, x0: 4 }, positions: [{ kind: 'index', index: 2 }] }))).toEqual(['POLICY_DENIED']);
  });
});

describe('misuse matrix through tools and direct APIs (§15.1, §16)', () => {
  it('forged origin, actor, session and review fields are rejected by tools and ignored by the bound adapter API', async () => {
    const r = make();
    await atExplore(r);
    for (const field of ['origin', 'actor', 'sessionId', 'hostSessionId', 'review', 'lifecycle']) {
      const result = await r.tools.execute('activity_operate', { action: 'commit-parameters', operationId: opId(), values: { eta: 1 }, expected: await expectedGuards(r), [field]: field === 'review' ? { status: 'reviewed' } : 'host' });
      expectSafeFailure(result);
      expect(result.ok ? null : result.diagnostics[0]!.message).toBe(ACTIVITY_TOOL_REASONS['authority-field'].message);
    }
    expect(codesOf(await r.tools.execute('activity_describe_template', { ...QUADRATIC, review: { outcome: 'approved' } }))).toEqual(['INVALID_INPUT']);
    // Direct API: an actor/origin claim in command input has no effect; attribution comes from the binding.
    const tutor = r.prepared().binding('tutor', 'tool-executor');
    const projection = tutor.getProjection();
    const direct = await tutor.commitParameters({ operationId: opId('direct'), ...projection.guards, displayValues: { eta: 0.5 }, actor: 'host', origin: 'host' } as never);
    expect(direct.ok).toBe(true);
    await settled(r.h);
    expect(parameterEvents(r).at(-1)!.actor.kind).toBe('tutor');
    // Direct API: a forged review claim in the activity request is a schema error, and discovery is unaffected.
    const forged = await r.h.adapter.validate({ ...requestFor({ activityId: 'act-forged' }), review: { outcome: 'approved' } } as never);
    expect(forged.ok).toBe(false);
    expect(dataOf(await r.tools.execute('activity_discover', {})).templates[0].review.lifecycle).toBe('reference-checked');
  });

  it('cross-activity requests and guessed IDs never reach another activity', async () => {
    const r = make();
    await atExplore(r);
    expect(codesOf(await r.tools.execute('activity_operate', { action: 'pause', operationId: opId(), expected: await expectedGuards(r), activityId: 'act-other' }))).toEqual(['INVALID_INPUT']);
    expect(() => createActivityTools({ ...r.context, activityId: 'act-other', binding: r.prepared().binding('tutor', 'tool-executor') })).toThrow(TypeError);
    expect(() => createActivityTools({ ...r.context, binding: r.prepared().binding('learner', 'surface-2') })).toThrow(TypeError);
    const elsewhere = createActivityTools({ ...r.context, activityId: 'act-other' });
    expect(codesOf(await elsewhere.execute('activity_inspect', {}))).toEqual(['NOT_READY']);
    const otherSession = createActivityTools({ ...r.context, hostSessionId: 'session-2', binding: r.prepared().binding('tutor', 'tool-executor') });
    expect(codesOf(await otherSession.execute('activity_inspect', {}))).toEqual(['POLICY_DENIED']);
    const guards = await expectedGuards(r);
    expect(codesOf(await r.tools.execute('activity_operate', { action: 'apply-scenario', operationId: opId(), scenarioId: 'step-9', expected: guards }))).toEqual(['NOT_FOUND']);
    expect(codesOf(await r.tools.execute('activity_operate', { action: 'select', operationId: opId(), target: 'regime', expected: guards }))).toEqual(['NOT_FOUND']);
    expect(codesOf(await r.tools.execute('activity_operate', { action: 'set-camera', operationId: opId(), viewId: 'secret-view', camera: null, expected: guards }))).toEqual(['NOT_FOUND']);
    expect(codesOf(await r.tools.execute('activity_restore', { operationId: opId(), artifactId: 'artifact-1' }))).toEqual(['CONFLICT']);
    // Direct API equivalents.
    expect(r.h.adapter.getState('act-other', 'tutor')).toMatchObject({ ok: false });
    expect(bindingCodes(await r.prepared().binding('tutor', 'tool-executor').commitPreview({ operationId: opId('direct'), ...r.learner().getProjection().guards, previewId: 'guessed-preview' }))).toEqual(['NOT_FOUND']);
  });

  it('stale authorizations: a policy revision bumped before, during and after a call', async () => {
    // Before: nothing happens.
    const before = make();
    await atExplore(before);
    const count = parameterEvents(before).length;
    before.h.host.amendPolicy({});
    const stale = await before.tools.execute('activity_operate', { action: 'commit-parameters', operationId: opId(), values: { eta: 1 }, expected: await guardsFrom(before) });
    expect(codesOf(stale)).toEqual(['STALE_POLICY_REVISION']);
    expectSafeFailure(stale);
    expect(parameterEvents(before)).toHaveLength(count);

    // During preparation (the third policy read is the final check after validation, before the commit): nothing is registered.
    let reads = 0;
    const during = make({ policySource: h => () => { if (++reads === 3) h.host.amendPolicy({}); return h.host.policy(); } });
    expect(codesOf(await during.tools.execute('activity_prepare', { operationId: opId(), template: QUADRATIC }))).toEqual(['STALE_POLICY_REVISION']);
    expect(during.h.host.calls('registerActivity')).toHaveLength(0);

    // During the host round trip of a reveal: the host refuses the stale request and nothing is shown.
    const reveal = make();
    await prepareThroughTools(reveal);
    reveal.h.host.delay('requestStageTransition', 5);
    const pending = reveal.tools.execute('activity_request_reveal', { operationId: opId(), target: { kind: 'stage', toStage: 'explore-step' }, expected: await expectedGuards(reveal) });
    await new Promise(resolve => setTimeout(resolve, 1));
    reveal.h.host.amendPolicy({});
    const outcome = dataOf(await pending);
    expect(outcome.status).toBe('denied');
    expect(outcome.diagnostics[0].code).toBe('STALE_POLICY_REVISION');
    expect(outcome.authorization.current).toBe(false);
    expect(reveal.learner().getProjection().views.map(view => view.viewId)).not.toContain('trace-plot');

    // After the commit: the commit stands and is reported, with the authorization marked stale.
    let armed = 0;
    const after = make({ policySource: h => () => { if (armed > 0 && --armed === 0) h.host.amendPolicy({}); return h.host.policy(); } });
    await atExplore(after);
    const guards = await guardsFrom(after);
    armed = 2; // the read after the commit (the first read authorizes it)
    const committed = dataOf(await after.tools.execute('activity_operate', { action: 'commit-parameters', operationId: opId(), values: { eta: 1 }, expected: guards }));
    expect(committed.authorization).toEqual({ current: false, code: 'STALE_POLICY_REVISION' });
    expect(committed.projection.controls[0].value).toBe(1);
    expect(codesOf(await after.tools.execute('activity_inspect', {}))).toEqual(['STALE_POLICY_REVISION']);

    // Direct API: an old policy revision guard is stale after the host updates the policy.
    const direct = make();
    await prepareThroughTools(direct);
    const old = direct.learner().getProjection();
    expect((await direct.prepared().host.updatePolicy({ operationId: opId('policy'), policy: { ...direct.h.host.policy(), revision: 2, issuedAt: '2026-10-26T08:30:00.000Z' } })).ok).toBe(true);
    expect(bindingCodes(await direct.prepared().binding('tutor', 'tool-executor').requestHelp({ operationId: opId('help'), expectedActivityRevision: old.activityRevision, expectedPolicyRevision: old.policyRevision }))).toEqual(['STALE_POLICY_REVISION']);
  });

  it('repeated operation IDs replay identical requests and conflict on changed arguments, in tools and direct APIs', async () => {
    const r = make();
    await atExplore(r);
    const input = { action: 'commit-parameters', operationId: opId('repeat'), values: { eta: 1 }, expected: await expectedGuards(r) };
    const [first, concurrent] = await Promise.all([r.tools.execute('activity_operate', input), r.tools.execute('activity_operate', input)]);
    const again = await r.tools.execute('activity_operate', input);
    expect(concurrent).toEqual(first);
    expect(again).toEqual(first);
    await settled(r.h);
    expect(parameterEvents(r).filter(event => event.operationId === input.operationId)).toHaveLength(1);
    const changed = await r.tools.execute('activity_operate', { ...input, values: { eta: 1.5 } });
    expect(codesOf(changed)).toEqual(['OPERATION_CONFLICT']);
    expectSafeFailure(changed);
    expect(codesOf(await r.tools.execute('activity_propose_revision', { operationId: input.operationId, proposal: { kind: 'scenario', scenarioId: 'step-0.25' } }))).toEqual(['OPERATION_CONFLICT']);
    const tutor = r.prepared().binding('tutor', 'tool-executor');
    const guards = tutor.getProjection().guards;
    expect((await tutor.commitParameters({ operationId: 'direct-repeat', ...guards, displayValues: { eta: 0.5 } })).ok).toBe(true);
    expect(bindingCodes(await tutor.commitParameters({ operationId: 'direct-repeat', ...guards, displayValues: { eta: 0.6 } }))).toEqual(['OPERATION_CONFLICT']);
  });

  it('cancellation before execution changes nothing; cancellation after commit returns the committed result idempotently', async () => {
    const r = make();
    await atExplore(r);
    const count = parameterEvents(r).length;
    const aborted = new AbortController();
    aborted.abort();
    const input = { action: 'commit-parameters', operationId: opId('cancel'), values: { eta: 1 }, expected: await expectedGuards(r) };
    expect(codesOf(await r.tools.execute('activity_operate', input, { signal: aborted.signal }))).toEqual(['CANCELLED']);
    expect(parameterEvents(r)).toHaveLength(count);
    // The same request can be retried after a cancellation that took no effect.
    const late = new AbortController();
    const running = r.tools.execute('activity_operate', input, { signal: late.signal });
    await new Promise(resolve => setTimeout(resolve, 0));
    late.abort();
    const committed = await running;
    expect(dataOf(committed).projection.controls[0].value).toBe(1);
    expect(await r.tools.execute('activity_operate', input)).toEqual(committed);
    await settled(r.h);
    expect(parameterEvents(r)).toHaveLength(count + 1);
  });

  it('prototype keys, getters, cycles, class instances and nonfinite numbers are rejected without invoking accessors', async () => {
    const r = make();
    await atExplore(r);
    const expected = await expectedGuards(r);
    let reads = 0;
    const getter = { action: 'pause', operationId: opId(), expected };
    Object.defineProperty(getter, 'values', { enumerable: true, get() { reads++; return { eta: 1 }; } });
    const cyclic: Record<string, unknown> = { action: 'pause', operationId: opId(), expected };
    cyclic.self = cyclic;
    const cases: [unknown, string][] = [
      [JSON.parse(`{"action":"pause","operationId":"${opId()}","expected":${JSON.stringify(expected)},"__proto__":{"admin":true}}`), 'reserved-key'],
      [{ action: 'pause', operationId: opId(), expected: { ...expected, constructor: 1 } }, 'reserved-key'],
      [getter, 'accessor'],
      [cyclic, 'cycle'],
      [{ action: 'pause', operationId: opId(), expected, when: new Date() }, 'not-json'],
      [{ action: 'commit-parameters', operationId: opId(), values: { eta: Number.NaN }, expected }, 'not-json'],
    ];
    for (const [value, reason] of cases) {
      const result = await r.tools.execute('activity_operate', value);
      expect(result.ok ? null : result.diagnostics[0]!.message, reason).toBe(ACTIVITY_TOOL_REASONS[reason as keyof typeof ACTIVITY_TOOL_REASONS].message);
      expectSafeFailure(result);
    }
    expect(reads).toBe(0);
    expect((({}) as Record<string, unknown>).admin).toBeUndefined();
    // Direct API: a cyclic command is invalid input.
    const tutor = r.prepared().binding('tutor', 'tool-executor');
    const loop: Record<string, unknown> = { operationId: opId('direct'), ...tutor.getProjection().guards, displayValues: { eta: 1 } };
    loop.loop = loop;
    expect(bindingCodes(await tutor.commitParameters(loop as never))).toEqual(['INVALID_INPUT']);
  });

  it('oversized inputs fail before deep traversal, through tools and the direct API', async () => {
    const r = make();
    await atExplore(r);
    const expected = await expectedGuards(r);
    const huge = await r.tools.execute('activity_operate', { action: 'pause', operationId: opId(), expected, padding: 'x'.repeat(2_000_000) });
    expect(codesOf(huge)).toEqual(['RESOURCE_LIMIT']);
    let deep: unknown = 1;
    for (let level = 0; level < 64; level++) deep = { level: deep };
    expect(codesOf(await r.tools.execute('activity_operate', { action: 'pause', operationId: opId(), expected, deep }))).toEqual(['RESOURCE_LIMIT']);
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`p${index}`, 1]));
    expect(codesOf(await r.tools.execute('activity_operate', { action: 'commit-parameters', operationId: opId(), values: many, expected }))).toEqual(['INVALID_INPUT']);
    const groups = Array.from({ length: 65 }, (_, index) => `g${index}`);
    expect(codesOf(await r.tools.execute('activity_request_reveal', { operationId: opId(), target: { kind: 'groups', groups }, expected }))).toEqual(['INVALID_INPUT']);
    const tutor = r.prepared().binding('tutor', 'tool-executor');
    expect(bindingCodes(await tutor.commitParameters({ operationId: opId('direct'), ...tutor.getProjection().guards, displayValues: many }))).toEqual(['INVALID_INPUT']);
  });

  it('arbitrary resource URLs and paths are never accepted, through tools and the direct API', async () => {
    const r = make();
    for (const templateId of ['file:///etc/passwd', 'https://evil.example/template.json', '../../catalog/x']) {
      const result = await r.tools.execute('activity_prepare', { operationId: opId(), template: { templateId, version: '1.0.0' } });
      expect(codesOf(result), templateId).toEqual(['INVALID_INPUT']);
      expectSafeFailure(result);
    }
    const direct = await r.h.adapter.validate(requestFor({ template: { templateId: 'https://evil.example/template.json', version: '1.0.0' } }));
    expect(direct.ok).toBe(false);
    expect(direct.diagnostics[0]!.code).toBe('SCHEMA');
  });

  it('capture and sampling are not available without authorization, through tools and the direct API', async () => {
    const r = make({ audience: 'tutor' });
    await prepareThroughTools(r);
    expect(codesOf(await r.tools.execute('activity_capture', { viewId: 'landscape' }))).toEqual(['UNSUPPORTED_CAPABILITY']);
    expect(dataOf(await r.tools.execute('activity_discover', {})).unsupported.map((item: { capability: string }) => item.capability)).toContain('capture');
    expect(codesOf(await r.tools.execute('activity_sample', { parameters: { a: 2, eta: 1, x0: 4 }, positions: [{ kind: 'index', index: 1 }] }))).toEqual(['POLICY_DENIED']);
    const direct = await r.h.adapter.sample({ activityId: ACTIVITY_ID, parameters: { a: 2, eta: 1, x0: 4 }, positions: [{ kind: 'index', index: 1 }], audience: 'learner' as never });
    expect(direct.ok).toBe(false);
  });

  it('errors never disclose hidden content: every failure uses the fixed vocabulary at the prediction stage', async () => {
    const r = make({ audience: 'learner-visible' });
    await prepareThroughTools(r);
    const expected = await expectedGuards(r);
    const failures: ActivityToolResult[] = [
      await r.tools.execute('activity_operate', { action: 'commit-parameters', operationId: opId(), values: { eta: 1.9 }, expected }),
      await r.tools.execute('activity_operate', { action: 'commit-parameters', operationId: opId(), values: { regime: 1 }, expected }),
      await r.tools.execute('activity_operate', { action: 'navigate', operationId: opId(), position: { kind: 'index', index: 4 }, expected }),
      await r.tools.execute('activity_operate', { action: 'select', operationId: opId(), target: 'current-iterate', expected }),
      await r.tools.execute('activity_operate', { action: 'set-camera', operationId: opId(), viewId: 'trace-plot', camera: null, expected }),
      await r.tools.execute('activity_operate', { action: 'apply-scenario', operationId: opId(), scenarioId: 'step-0.75', expected }),
      await r.tools.execute('activity_propose_revision', { operationId: opId(), proposal: { kind: 'parameters', values: { eta: 1.9, a: 3 } } }),
      await r.tools.execute('activity_inspect', { view: 'full' }),
      await r.tools.execute('activity_sample', { parameters: { a: 2, eta: 1, x0: 4 }, positions: [{ kind: 'index', index: 1 }] }),
      await r.tools.execute('activity_request_reveal', { operationId: opId(), target: { kind: 'groups', groups: ['regime'] }, expected: { ...expected, activityRevision: 9 } }),
    ];
    for (const failure of failures) expectSafeFailure(failure);
    expect(failures.every(failure => !failure.ok)).toBe(true);
  });

  it('a script-like comparison label stays inert data: refused by the tools, escaped in summaries, snapshots, SVG captures and SSR markup (G80)', async () => {
    const HOSTILE = '<img src=x onerror=alert(1)>';
    const ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';
    const markupTag = /<(img|script|svg\s+onload|iframe)\b/i;
    const handlerAttribute = /<[a-z][^>]*\son[a-z]+\s*=/i;
    /** Inert: the raw label never appears, and every occurrence of its handler text is inside the escaped label. */
    const inert = (markup: string) => {
      expect(markup).not.toContain(HOSTILE);
      expect(markup).not.toMatch(markupTag);
      expect(markup).not.toMatch(handlerAttribute);
      expect(markup.split('onerror=').length - 1).toBe(markup.split(ESCAPED).length - 1);
    };
    const r = make();
    await atExplore(r);
    const expected = await expectedGuards(r);
    // Agent tools: activity_operate has no comparison action, and no identifier field accepts markup, so a
    // script-like label cannot enter the activity through the tool channel at all.
    for (const input of [
      { action: 'retain-comparison', operationId: opId(), label: HOSTILE, expected },
      { action: 'select', operationId: opId(), target: HOSTILE, expected },
      { action: 'apply-scenario', operationId: opId(), scenarioId: HOSTILE, expected },
    ]) {
      const refused = await r.tools.execute('activity_operate', input);
      expect(codesOf(refused), input.action).toEqual(['INVALID_INPUT']);
      expectSafeFailure(refused);
      expect(JSON.stringify(refused)).not.toContain(HOSTILE);
    }
    expect(r.learner().getProjection().comparisons).toEqual([]);

    // Direct binding: the learner surface's own command retains the comparison with the label as given.
    const learner = r.learner();
    const retained = await learner.retainComparison({ operationId: opId('compare'), ...learner.getProjection().guards, label: HOSTILE });
    expect(retained.ok).toBe(true);
    await settled(r.h);
    const projection = learner.getProjection();
    expect(projection.comparisons.map(comparison => comparison.label)).toEqual([HOSTILE]);
    expect(r.h.host.events(ACTIVITY_ID).filter(event => event.type === 'comparison.retained').map(event => (event.payload as { label: string }).label)).toEqual([HOSTILE]);

    // Through the tools the label is returned as JSON string data (never interpreted), equal to the surface projection.
    const inspected = dataOf(await r.tools.execute('activity_inspect', {}));
    expect(inspected.projection.comparisons.map((comparison: { label: string }) => comparison.label)).toEqual([HOSTILE]);
    const summary = dataOf(await r.tools.execute('activity_summarize', {})).summary as { text: string; comparisons: { label: string }[] };
    expect(summary.text).not.toMatch(markupTag);
    expect(summary.text).not.toContain(HOSTILE);
    expect(summary.comparisons.every(comparison => comparison.label === HOSTILE || !markupTag.test(comparison.label))).toBe(true);

    // Learner snapshot (host-stored JSON): the label survives only as the value of a label field.
    const saved = dataOf(await r.tools.execute('activity_save', { operationId: opId(), kind: 'learner-snapshot' }));
    await settled(r.h);
    const snapshot = r.h.host.artifacts().find(artifact => artifact.artifactId === saved.artifactId)!;
    expect(snapshot.kind).toBe('learner-snapshot');
    expect(snapshot.scientific.comparisons.map(comparison => comparison.label)).toEqual([HOSTILE]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized.split('<img').length - 1).toBe(serialized.split(`"label":${JSON.stringify(HOSTILE)}`).length - 1);

    // Server-rendered learner surface: escaped text, no element or handler created.
    const { StudyActivitySurface } = await import('../../packages/player/src/activity/index');
    const forbidden = () => { throw new Error('rendering must not issue commands'); };
    const binding = new Proxy({ activityId: projection.activityId, actor: 'learner', getProjection: () => projection, subscribe: () => () => undefined } as unknown as ActivityBinding, {
      get: (target, key) => key in target ? target[key as keyof ActivityBinding] : forbidden,
    });
    const html = renderToString(createElement(StudyActivitySurface, { binding, theme: 'light' }));
    expect(html).toContain('data-eka-panel="comparisons"');
    inert(html);

    // SVG capture: the composer escapes every text line it draws (the companion lines built from the projection, the
    // projection's comparison labels and the server-rendered scene of the captured view); the companion is plain text.
    const view = selectCaptureView(projection as LearnerProjection);
    const companion = companionText(projection as LearnerProjection, view);
    const start = html.indexOf(`data-eka-view-id="${view.viewId}"`);
    const open = start < 0 ? -1 : html.lastIndexOf('<svg', start);
    const scene = open < 0 ? null : { svg: html.slice(open, html.indexOf('</svg>', open) + 6), width: 640, height: 400 };
    expect(scene?.svg, `server-rendered scene of ${view.viewId}`).toMatch(/^<svg[\s\S]*<\/svg>$/);
    const { svg } = composeCaptureSvg({
      metadata: captureMetadata('surface-1', projection as LearnerProjection, view.viewId), title: `${projection.title} — ${view.title}`, summary: view.summary, scene,
      textLines: [...companion.split('\n'), ...projection.comparisons.map(comparison => `Kept run: ${comparison.label}`)], footer: projection.reviewNotice ?? '', colors: { background: '#ffffff', text: '#17212b', muted: '#4a5866', border: '#c9d2db' }, fontFamily: 'system-ui', fontFaces: '',
    });
    expect(svg).toContain(ESCAPED);
    inert(svg);
    expect(svg).not.toMatch(/<foreignObject/i);
  });
});

async function guardsFrom(r: Rig): Promise<Record<string, unknown>> {
  const projection = r.learner().getProjection();
  return { scientificVersion: projection.guards.expectedScientificVersion, runId: projection.guards.expectedRunId, activityRevision: projection.activityRevision, policyRevision: projection.policyRevision, presentationRevision: projection.presentationRevision };
}
