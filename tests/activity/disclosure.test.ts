/**
 * Disclosure (report §6.2, §15.1, §16, A21 data side): restricted quantities and labels are absent from the learner
 * projection JSON, accessible descriptions, learner/tutor errors, learner/tutor summaries, audience state and learner
 * snapshots. Every learner-facing error message comes from the fixed vocabulary. Browser DOM/accessibility checks are
 * the surface's responsibility and are not covered here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LEARNER_MESSAGES, type CommandOutcome, type InteractionSummary } from '@experiment-kit/activity';
import {
  activityGuard, codesOf, enterExplore, guards, harness, manifest, okOf, op, open, policyFor, presentationGuard, settled, template, type Harness, type Opened,
} from './support/adapter-harness.js';

let current: Harness | null = null;
const make = (...args: Parameters<typeof harness>) => (current = harness(...args));
afterEach(() => { current?.adapter.dispose(); current = null; });

/** Quantities, labels and texts that belong only to solution-bearing groups the predict stage does not show. */
const restricted = (() => {
  const hiddenGroups = template.groups.filter(group => group.solutionBearing);
  const quantities = hiddenGroups.filter(group => group.kind === 'quantity').flatMap(group => group.members);
  const labels = [
    ...quantities.map(id => manifest.quantities[id]!.label).filter(label => !['Position', 'Loss', 'Gradient', 'Regime'].includes(label)),
    ...template.views.flatMap(view => view.marks).filter(mark => hiddenGroups.some(group => group.id === mark.group)).map(mark => mark.label),
    ...template.equations.filter(equation => hiddenGroups.some(group => group.id === equation.group)).map(equation => equation.label),
    ...template.content.filter(entry => entry.kind !== 'learner-copy').map(entry => entry.text.slice(0, 48)),
    manifest.constraints[0]!.message.slice(0, 48),
  ];
  return { quantities, labels };
})();
const VOCABULARY = new Set(Object.values(LEARNER_MESSAGES).flatMap(text => [text.message, text.recovery]));
function expectSafe(text: string): void {
  for (const label of restricted.labels) expect(text, label).not.toContain(label);
}
function expectVocabulary(outcome: CommandOutcome | { ok: boolean; diagnostics?: { message: string; recovery?: string; path: string }[] }): void {
  if (outcome.ok) throw new Error('expected a failure');
  for (const item of (outcome as { diagnostics: { message: string; recovery?: string; path: string }[] }).diagnostics) {
    expect(VOCABULARY.has(item.message), item.message).toBe(true);
    expect(VOCABULARY.has(item.recovery ?? ''), item.recovery).toBe(true);
    expectSafe(JSON.stringify(item));
  }
}
async function predict(h: Harness): Promise<Opened> {
  const opened = await open(h);
  await settled(h);
  return opened;
}

describe('learner channels before a reveal', () => {
  it('projection JSON, describeCurrentValues and view summaries carry no restricted content', async () => {
    const h = make();
    const opened = await predict(h);
    const projection = opened.learner.getProjection();
    expectSafe(JSON.stringify(projection));
    expectSafe(opened.learner.describeCurrentValues());
    const values = projection.views.flatMap(view => view.values.map(value => value.quantityId));
    for (const id of restricted.quantities) expect(values).not.toContain(id);
    expect(JSON.stringify(projection)).not.toContain('"position":{"status"');
  });

  it('learner and tutor errors use only the fixed vocabulary and name no hidden element', async () => {
    const h = make();
    const opened = await predict(h);
    for (const binding of [opened.learner, opened.tutor]) {
      expectVocabulary(binding.select({ operationId: op(), ...presentationGuard(binding), target: 'current-iterate' }));
      expectVocabulary(binding.setCamera({ operationId: op(), ...presentationGuard(binding), viewId: 'trace-plot', camera: null }));
      expectVocabulary(await binding.commitParameters({ operationId: op(), ...guards(binding), displayValues: { eta: 1.9 } }));
      expectVocabulary(await binding.navigate({ operationId: op(), ...guards(binding), position: { kind: 'index', index: 4 } }));
      expectVocabulary(await binding.applyScenario({ operationId: op(), ...guards(binding), scenarioId: 'step-0.75' }));
      expectVocabulary(await binding.requestHelp({ operationId: op(), expectedActivityRevision: 9, expectedPolicyRevision: 1 }));
      expectVocabulary(binding.beginPreview({ operationId: op(), ...guards(binding), gesture: 'pointer', parameter: 'eta' }));
    }
    const failed = await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { regime: 1 } as never });
    expect(codesOf(failed)).toEqual(['INVALID_INPUT']);
    expect(failed.ok ? '' : failed.diagnostics[0]!.path).toBe('$.displayValues.regime');
  });

  it('learner and tutor audience state and summaries contain only what was visible', async () => {
    const h = make();
    const opened = await predict(h);
    for (const audience of ['learner', 'tutor'] as const) {
      const state = h.adapter.getState('act-quadratic-1', audience);
      expect(state).not.toHaveProperty('scientific');
      expect(state).not.toHaveProperty('exposures');
      expectSafe(JSON.stringify(state));
      const summary = h.adapter.summarizeInteraction('act-quadratic-1', { audience }) as InteractionSummary;
      expect(summary.audience).toBe(audience);
      const observed = summary.committedConfigurations.flatMap(configuration => Object.keys(configuration.observations));
      expect(observed.every(id => id === 'start.position' || id === 'start.loss')).toBe(true);
      expectSafe(JSON.stringify(summary));
    }
    expect(h.adapter.getState('act-quadratic-1', 'teacher')).toHaveProperty('scientific');
    expect(h.adapter.getState('act-quadratic-1', 'host')).toHaveProperty('scientific.quantities.multiplier');
    expect(opened.learner.getProjection().views.length).toBeGreaterThan(0);
  });

  it('tutor full inspection and teacher inspection follow the policy flags', async () => {
    const h = make({ policy: policyFor({ inspection: { developer: false, tutor: 'full', teacher: false } }) });
    await predict(h);
    expect(h.adapter.getState('act-quadratic-1', 'tutor')).toHaveProperty('scientific');
    expect(h.adapter.getState('act-quadratic-1', 'teacher')).not.toHaveProperty('scientific');
    expect(codesOf(h.adapter.summarizeInteraction('act-quadratic-1', { audience: 'teacher' }) as never)).toEqual(['POLICY_DENIED']);
  });

  it('a learner snapshot keeps only projection-visible parameters and content and no host-only records', async () => {
    const h = make({ policy: policyFor({ permittedControls: ['eta'] }) });
    const opened = await predict(h);
    okOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 0, hostSessionRevision: 1, response: { responseId: 'resp-1', taskId: 'task-1', taskRevision: 1, kind: 'prediction', modality: 'text', stageId: 'predict' } }));
    const snapshot = await opened.control.save({ operationId: op(), kind: 'learner-snapshot' });
    if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.diagnostics));
    const artifact = snapshot.artifact;
    expect(artifact.scientific.params).toEqual({ eta: 0.25 });
    expect(artifact.instance.initialParameters).toEqual({ eta: 0.25 });
    expect(artifact.exposures).toEqual([]);
    expect(artifact.reviewRefs).toEqual([]);
    expect(artifact.instance.responses).toEqual([]);
    expect(artifact.contentRefs).toEqual(['scenario-note']);
    expectSafe(JSON.stringify(artifact));
    const backupDenied = make({ policy: policyFor({ export: { learnerSnapshot: false, capture: false, backup: false } }) });
    const denied = await open(backupDenied);
    expect(codesOf(await denied.control.save({ operationId: op(), kind: 'learner-snapshot' }) as never)).toEqual(['POLICY_DENIED']);
  });
});

describe('after a reveal', () => {
  it('only the revealed groups appear; groups of later stages stay restricted in every channel', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 2 } }));
    await settled(h);
    const later = ['Largest convergent step size', 'Update rule with current values', 'Convergence condition for a nonzero start'];
    const learner = h.adapter.summarizeInteraction('act-quadratic-1', { audience: 'learner' }) as InteractionSummary;
    for (const text of [JSON.stringify(opened.learner.getProjection()), opened.learner.describeCurrentValues(), JSON.stringify(learner)])
      for (const label of later) expect(text).not.toContain(label);
    expect(Object.keys(learner.committedConfigurations.at(-1)!.observations)).toContain('position');
    expect(Object.keys(learner.committedConfigurations.at(-1)!.observations)).not.toContain('threshold');
    expect(learner.revealed.map(item => item.groups)).toEqual([['trace', 'observations']]);
    expect(codesOf(await opened.control.requestReveal({ operationId: op(), ...activityGuard(opened.learner), groups: ['regime'] }))).toEqual(['POLICY_DENIED']);
  });
});
