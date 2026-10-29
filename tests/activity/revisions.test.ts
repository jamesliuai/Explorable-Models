/**
 * Revision spaces (docs/study-harness/revisions.md, report §4.2, A03): each change produces only its documented
 * effects. Scientific = session version + run; presentation = presentation revision; activity = host receipt
 * revision; host session = echoed host revision on response references.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { groupDigests, templateRef, type ActivityTemplate } from '@explorable-models/activity';
import { createInstalledCatalog, INSTALLED_KERNELS } from '@explorable-models/catalog';
import { modelIdentity, type ModelManifest } from '@explorable-models/core/model';
import {
  activityGuard, codesOf, enterExplore, guards, harness, manifest, okOf, op, open, policyFor, presentationGuard, requestFor, settled, template, until, type Harness, type Opened,
} from './support/adapter-harness.js';

let current: Harness | null = null;
const make = (...args: Parameters<typeof harness>) => (current = harness(...args));
afterEach(() => { current?.adapter.dispose(); current = null; });

interface Revisions { version: number; runId: string | null; index: number | null; presentation: number; activity: number; policy: number; host: number }
function revisions(h: Harness, opened: Opened): Revisions {
  const state = h.adapter.getState('act-quadratic-1', 'host') as { guards: { scientificVersion: number; runId: string | null; activityRevision: number; policyRevision: number; presentationRevision: number; hostSessionRevision: number } };
  const position = opened.learner.getProjection().frame!.position;
  return {
    version: state.guards.scientificVersion, runId: state.guards.runId, index: position.kind === 'index' ? position.index : null, presentation: state.guards.presentationRevision,
    activity: state.guards.activityRevision, policy: state.guards.policyRevision, host: state.guards.hostSessionRevision,
  };
}

describe('effects and non-effects', () => {
  it('commit, scenario and reset start a new run at index 0 and advance only the scientific version', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 4 } }));
    for (const change of [
      () => opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } }),
      () => opened.learner.applyScenario({ operationId: op(), ...guards(opened.learner), scenarioId: 'step-1.25' }),
      () => opened.learner.resetExperiment({ operationId: op(), ...guards(opened.learner) }),
    ]) {
      okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 3 } }));
      const before = revisions(h, opened);
      okOf(await change());
      const after = revisions(h, opened);
      expect(after).toEqual({ ...before, version: before.version + 1, runId: expect.any(String), index: 0 });
      expect(after.runId).not.toBe(before.runId);
    }
    expect(opened.learner.getProjection().scenarios.every(scenario => !scenario.active)).toBe(true);
  });

  it('navigation and steps keep the run and advance the version only', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const before = revisions(h, opened);
    okOf(await opened.learner.step({ operationId: op(), ...guards(opened.learner), delta: 1 }));
    expect(revisions(h, opened)).toEqual({ ...before, version: before.version + 1, index: 1 });
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 9 } }));
    expect(revisions(h, opened)).toEqual({ ...before, version: before.version + 2, index: 9 });
    okOf(await opened.learner.restartPlayback({ operationId: op(), ...guards(opened.learner) }));
    expect(revisions(h, opened)).toEqual({ ...before, version: before.version + 3, index: 0 });
  });

  it('playback ticks advance the index without changing the run or the version', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(opened.learner.play({ operationId: op(), ...guards(opened.learner) }));
    const before = revisions(h, opened);
    await until(() => (opened.learner.getProjection().frame!.position as { index: number }).index >= 1, 3000);
    const after = revisions(h, opened);
    expect(after).toEqual({ ...before, index: after.index });
    expect(after.index).toBeGreaterThanOrEqual(1);
    okOf(opened.learner.pause({ operationId: op(), ...guards(opened.learner) }));
  });

  it('camera, selection, layout and display unit advance only the presentation revision', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 2 } }));
    const before = revisions(h, opened);
    okOf(opened.learner.setCamera({ operationId: op(), ...presentationGuard(opened.learner), viewId: 'landscape', camera: { kind: '2d', center: [1, 2], zoom: 2 } }));
    okOf(opened.learner.select({ operationId: op(), ...presentationGuard(opened.learner), target: 'current-iterate' }));
    okOf(opened.learner.setLayout({ operationId: op(), ...presentationGuard(opened.learner), layout: 'expanded' }));
    okOf(opened.learner.setDisplayUnit({ operationId: op(), ...presentationGuard(opened.learner), parameter: 'eta', unit: 'dimensionless' }));
    okOf(opened.learner.resetView({ operationId: op(), ...presentationGuard(opened.learner), viewId: 'landscape' }));
    expect(revisions(h, opened)).toEqual({ ...before, presentation: before.presentation + 5 });
    expect(codesOf(opened.learner.setLayout({ operationId: op(), expectedPresentationRevision: before.presentation, layout: 'card' }))).toEqual(['STALE_PRESENTATION_REVISION']);
    expect(codesOf(opened.learner.setCamera({ operationId: op(), ...presentationGuard(opened.learner), viewId: 'landscape', camera: { kind: '3d', projection: 'orthographic', position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], preset: null } }))).toEqual(['INVALID_INPUT']);
  });

  it('a stage transition sets the activity revision to the receipt value and leaves science and presentation alone', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const before = revisions(h, opened);
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    const after = revisions(h, opened);
    expect(after).toEqual({ ...before, activity: h.host.activity('act-quadratic-1')!.activityRevision });
    expect(after.activity).toBe(before.activity + 1);
    expect(codesOf(await opened.learner.requestHelp({ operationId: op(), expectedActivityRevision: before.activity, expectedPolicyRevision: 1 }))).toEqual(['STALE_ACTIVITY_REVISION']);
  });

  it('response references are guarded by the host session revision, which the adapter only echoes', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const before = revisions(h, opened);
    okOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 0, hostSessionRevision: 1, response: { responseId: 'resp-1', taskId: 'task-1', taskRevision: 1, kind: 'prediction', modality: 'speech-derived', stageId: 'predict' } }));
    expect(revisions(h, opened)).toEqual({ ...before, host: 1 });
    expect(codesOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 0, hostSessionRevision: 1, response: { responseId: 'resp-2', taskId: 'task-1', taskRevision: 1, kind: 'prediction', modality: 'text', stageId: 'predict' } }))).toEqual(['STALE_HOST_REVISION']);
    okOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 1, hostSessionRevision: 2, response: { responseId: 'resp-2', taskId: 'task-1', taskRevision: 2, kind: 'prediction', modality: 'text', stageId: 'predict' } }));
    okOf(await opened.control.updateResponseRef({ operationId: op(), expectedHostSessionRevision: 2, hostSessionRevision: 3, responseId: 'resp-1', status: 'superseded', supersededBy: 'resp-2' }));
    expect(revisions(h, opened)).toEqual({ ...before, host: 3 });
    expect(opened.prepared.instance.responses.map(item => [item.responseId, item.status])).toEqual([['resp-1', 'superseded'], ['resp-2', 'submitted']]);
    // Activity revision stays host-owned: the next stage receipt is still accepted by the host.
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await settled(h);
    expect(h.host.events().filter(event => event.type.startsWith('response.')).map(event => event.type)).toEqual(['response.submitted', 'response.submitted', 'response.superseded']);
  });

  it('a policy update advances the policy revision; stale policy guards fail', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const before = revisions(h, opened);
    const next = h.host.amendPolicy({ permittedControls: ['eta'] });
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: next }));
    expect(revisions(h, opened)).toEqual({ ...before, policy: 2 });
    expect(opened.learner.getProjection().controls.map(control => control.parameter)).toEqual(['eta']);
    expect(codesOf(await opened.control.requestStageTransition({ operationId: op(), expectedActivityRevision: before.activity, expectedPolicyRevision: 1, toStage: 'explore-step' }))).toEqual(['STALE_POLICY_REVISION']);
    expect(codesOf(await opened.control.updatePolicy({ operationId: op(), policy: next }))).toEqual(['STALE_POLICY_REVISION']);
  });
});

describe('content and model identity edits', () => {
  it('an explanatory label edit changes the template and group digests, so prior approvals do not transfer', async () => {
    const edited: ActivityTemplate = structuredClone(template);
    edited.views[0]!.marks[0]!.label = 'Objective f(x), the loss we minimise';
    const original = Object.fromEntries(groupDigests(template, manifest).map(entry => [entry.groupId, entry.contentDigest]));
    const changed = groupDigests(edited, manifest).filter(entry => entry.contentDigest !== original[entry.groupId]).map(entry => entry.groupId);
    expect(changed).toEqual(['landscape']);
    expect(templateRef(edited).digest).not.toBe(templateRef(template).digest);
    const h = make({ customCatalog: workerFactory => {
      const base = createInstalledCatalog({ workerFactory });
      return { ...base, getTemplate: ref => ref.templateId === template.templateId ? structuredClone(edited) : null, listTemplates: () => [] };
    } });
    // The host policy approves the original digest; the edited content under the same ID and version is not approved.
    expect(codesOf(await h.adapter.prepare(requestFor(), { operationId: op() }))).toEqual(['POLICY_DENIED']);
  });

  it('a model meaning edit is a new scientific revision; a template naming the old digest no longer resolves', async () => {
    const meaning: ModelManifest = structuredClone(manifest);
    meaning.quantities.position!.signConvention = 'Positive positions lie to the left of the minimum.';
    expect(modelIdentity(meaning).scientificRevision).not.toBe(modelIdentity(manifest).scientificRevision);
    const h = make({ customCatalog: workerFactory => {
      const base = createInstalledCatalog({ workerFactory });
      return { ...base, getModel: ref => ref.modelId === manifest.modelId ? structuredClone(meaning) : null };
    } });
    expect(codesOf(await h.adapter.prepare(requestFor(), { operationId: op() }))).toEqual(['INVALID_REFERENCE']);
    expect(INSTALLED_KERNELS.length).toBeGreaterThan(0);
    expect(policyFor().approved[0]!.model.digest).toBe(modelIdentity(manifest).digest);
  });
});
