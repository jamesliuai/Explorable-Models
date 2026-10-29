import { describe, expect, it } from 'vitest';
import type { ActivityTemplate, EventType, ExposureRecord, InteractionEvent, InteractionSummary, ResponseRef } from '../../packages/activity/src/contracts.js';
import { SUMMARY_LIMITS } from '../../packages/activity/src/contracts.js';
import { groupContentDigest } from '../../packages/activity/src/identity.js';
import { validateRecord } from '../../packages/activity/src/validator.js';
import { FORBIDDEN_SUMMARY_TERMS, SummaryError, representatives, summarize, trySummarize, type SummaryInput } from '../../packages/activity/src/summary.js';
import { event as exemplarEvent, predictInstance, quadraticManifest, quadraticTemplate } from '../../packages/activity/fixtures-src/exemplars.js';

const digest = (groupId: string) => ({ groupId, contentDigest: groupContentDigest(quadraticTemplate, quadraticManifest, groupId) });
const TRAJECTORY = digest('g-trajectory'), POSITION = digest('g-position');
const index = (value: number) => ({ kind: 'index' as const, index: value, maxIndex: 1000 });
const valid = (value: number | number[]) => ({ status: 'valid' as const, value });
const frame = (runId: string, at: number, kind: 'committed' | 'tentative' = 'committed') => ({ frameId: `frame-${runId}-${at}`, runId, kind, position: index(at) });
const at = (type: EventType, sequence: number, payload: Record<string, unknown>, extra: Partial<InteractionEvent> = {}) => exemplarEvent(type, sequence, payload, extra);
const response = (responseId: string, status: ResponseRef['status']): ResponseRef => ({ responseId, taskId: 'task-regime-1', taskRevision: 1, kind: 'prediction', modality: 'text', stageId: 'predict', status });

/** A realistic journal: initial run, navigation, a reveal, a committed preview, a comparison, a cancelled preview, an exploration grant, a response and an unfinished preview. */
function journal(): InteractionEvent[] {
  return [
    at('activity.opened', 1, { stageId: 'predict' }),
    at('parameters.committed', 2, { runId: 'run-1', previousRunId: null, params: { x0: 8, eta: 0.5, a: 1 }, cause: 'initial', visibleQuantities: { x: valid(8), loss: valid(32) } }, { frame: frame('run-1', 0) }),
    at('position.changed', 3, { runId: 'run-1', from: index(0), to: index(5), cause: 'step', visibleQuantities: { x: valid(0.25) } }, { frame: frame('run-1', 5) }),
    at('playback.paused', 4, { runId: 'run-1', position: index(12) }),
    at('reveal.requested', 5, { idempotencyKey: 'op-reveal-1', scope: 'reveal', groups: [TRAJECTORY, POSITION], intendedStage: 'explore' }, { actor: { kind: 'tutor', binding: 'tool-executor-1' } }),
    at('reveal.authorized', 6, { exposureId: 'exp-1', receiptId: 'rcpt-1', scope: 'reveal', groups: [TRAJECTORY, POSITION], activityRevision: 3 }, { actor: { kind: 'host', binding: 'host-api' } }),
    at('reveal.displayed', 7, { exposureId: 'exp-1', receiptId: 'rcpt-1', projectionDigest: 'sha256:' + 'a'.repeat(64), frameId: 'frame-run-1-5', surfaceId: 'surface-main' }),
    at('preview.started', 8, { previewId: 'pv-1', baseRunId: 'run-1', parameter: 'eta', gesture: 'pointer' }),
    at('preview.observed', 9, { previewId: 'pv-1', outcome: 'committed', samplingPolicy: 'first-last-evenly-spaced', omitted: 4, rendered: [
      { params: { a: 1, eta: 0.6, x0: 8 }, frameId: 'frame-pv-1-1' }, { params: { a: 1, eta: 1, x0: 8 }, frameId: 'frame-pv-1-4' }, { params: { a: 1, eta: 1.5, x0: 8 }, frameId: 'frame-pv-1-8' }] }),
    at('parameters.committed', 10, { runId: 'run-2', previousRunId: 'run-1', params: { a: 1, eta: 1.5, x0: 8 }, cause: 'commit', previewId: 'pv-1', gesture: 'pointer', visibleQuantities: { x: valid(8), loss: valid(32) } }, { frame: frame('run-2', 0) }),
    at('comparison.retained', 11, { runId: 'run-1', label: 'η = 0.5' }),
    at('preview.started', 12, { previewId: 'pv-2', baseRunId: 'run-2', parameter: 'x0', gesture: 'keyboard' }),
    at('preview.cancelled', 13, { previewId: 'pv-2', reason: 'escape' }),
    at('comparison.removed', 14, { runId: 'run-1' }),
    at('exposure.scope-authorized', 15, { exposureId: 'exp-2', receiptId: 'rcpt-2', scope: 'exploration', groups: [TRAJECTORY], activityRevision: 4, parameterDomain: { eta: [0, 2] } }, { actor: { kind: 'host', binding: 'host-api' } }),
    at('response.submitted', 16, { response: response('resp-1', 'submitted') }, { actor: { kind: 'host', binding: 'host-api' } }),
    at('preview.started', 17, { previewId: 'pv-3', baseRunId: 'run-2', parameter: 'eta', gesture: 'pointer' }),
    at('view.changed', 18, { change: 'camera', presentationRevision: 3, viewId: 'plot' }),
  ];
}
const exposure = (exposureId: string, receiptId: string, groups: typeof TRAJECTORY[], displayStatus: ExposureRecord['displayStatus'], extra: Partial<ExposureRecord> = {}): ExposureRecord => ({
  contract: 'study-harness.exposure-record', schemaVersion: '1.0', exposureId, activityId: predictInstance.activityId, receiptId, scope: 'reveal', groups,
  template: predictInstance.template, model: predictInstance.model, activityRevision: 3, intendedStage: 'explore', displayStatus, ...extra,
});
const EXPOSURES = [exposure('exp-1', 'rcpt-1', [TRAJECTORY, POSITION], 'displayed'), exposure('exp-2', 'rcpt-2', [TRAJECTORY], 'authorized', { scope: 'exploration', activityRevision: 4, parameterDomain: { eta: [0, 2] } })];

function input(overrides: Partial<SummaryInput> = {}): SummaryInput {
  const events = journal();
  return {
    events: events.slice(0, 15), pending: events.slice(15), trimmedBefore: 0, instance: { ...predictInstance, responses: [response('resp-1', 'superseded'), response('resp-0', 'submitted')] },
    template: quadraticTemplate, manifest: quadraticManifest, exposures: EXPOSURES, audience: 'tutor', ...overrides,
  };
}
/** Every string anywhere in a value. */
const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

describe('interaction summary content (A17)', () => {
  it('summarizes configurations, previews, exposures, comparisons and responses through an explicit cursor', () => {
    const summary = summarize(input());
    expect(validateRecord('study-harness.interaction-summary', summary).ok).toBe(true);
    expect(summary.cursor).toEqual({ fromSequence: 1, toSequence: 18, acknowledgedThrough: 15 });
    expect(summary.complete).toBe(false);
    expect(summary.template).toEqual(predictInstance.template);
    expect(summary.model).toEqual(predictInstance.model);
    expect(summary.committedConfigurations).toEqual([
      // Furthest position from playback (index 12); values come from the furthest event that recorded values (index 5).
      { runId: 'run-1', params: { a: 1, eta: 0.5, x0: 8 }, furthestPosition: index(12), cause: 'initial', sequence: 2, observations: { x: valid(0.25) } },
      { runId: 'run-2', params: { a: 1, eta: 1.5, x0: 8 }, furthestPosition: index(0), cause: 'commit', sequence: 10, observations: { loss: valid(32), x: valid(8) } },
    ]);
    expect(Object.keys(summary.committedConfigurations[0]!.params)).toEqual(['a', 'eta', 'x0']);
    expect(summary.previewObservations).toEqual([
      { previewId: 'pv-1', outcome: 'committed', samplingPolicy: 'first-last-evenly-spaced', rendered: [{ params: { a: 1, eta: 0.6, x0: 8 }, frameId: 'frame-pv-1-1' }, { params: { a: 1, eta: 1, x0: 8 }, frameId: 'frame-pv-1-4' }, { params: { a: 1, eta: 1.5, x0: 8 }, frameId: 'frame-pv-1-8' }], omitted: 4 },
      { previewId: 'pv-2', outcome: 'cancelled', samplingPolicy: 'no rendered values recorded', rendered: [], omitted: 0 },
      { previewId: 'pv-3', outcome: 'interrupted', samplingPolicy: 'no rendered values recorded', rendered: [], omitted: 0 },
    ]);
    expect(summary.revealed).toEqual([
      { exposureId: 'exp-1', groups: ['g-trajectory', 'g-position'], displayStatus: 'displayed', sequence: 6 },
      { exposureId: 'exp-2', groups: ['g-trajectory'], displayStatus: 'authorized', sequence: 15 },
    ]);
    expect(summary.comparisons).toEqual([{ runId: 'run-1', label: 'η = 0.5', action: 'retained', sequence: 11 }, { runId: 'run-1', label: 'η = 0.5', action: 'removed', sequence: 14 }]);
    expect(summary.responses).toEqual([response('resp-1', 'superseded'), response('resp-0', 'submitted')]);
    expect(summary.omitted).toEqual({ committedConfigurations: 0, previewObservations: 0, events: 0 });
    expect(summary.limitations).toEqual([
      'Events 16–18 are not yet acknowledged by the host.',
      'Preview pv-3 has no recorded end (interrupted or still active), so the recorded observations are incomplete.',
      'Preview observations are samples of rendered values (first, last and evenly spaced); they do not enumerate every value tried.',
      'Exposure exp-2 was authorized without an acknowledged display and is counted as potentially seen.',
    ]);
    expect(summary.text).toBe('Summary of events 1–18 for activity act-quadratic-0001, template quadratic-descent-regimes 1.0.0, model quadratic-descent 1.0.0. '
      + 'Recorded 2 committed configurations. Recorded 3 previews (1 committed, 1 cancelled, 1 interrupted); rendered values are samples, not every value tried. '
      + 'Revealed content groups: Descent path, Position and loss. 1 exposure not confirmed as displayed is counted as potentially seen. '
      + 'Comparisons: 1 retained, 1 removed. Host response references: 2. The record is incomplete through event 18; see the limitations.');
  });

  it('is byte-identical for the same journal regardless of input order or object key order', () => {
    const first = JSON.stringify(summarize(input()));
    const shuffled = input();
    shuffled.events = [...shuffled.events].reverse().map(item => item.type === 'parameters.committed' ? { ...item, payload: Object.fromEntries(Object.entries(item.payload).reverse()) } : item);
    shuffled.pending = [...shuffled.pending].reverse();
    expect(JSON.stringify(summarize(shuffled))).toBe(first);
    expect(JSON.stringify(summarize(input()))).toBe(first);
  });

  it('reports complete only when every event in the range is held, acknowledged and nothing is omitted', () => {
    const early = summarize(input({ fromSequence: 1, toSequence: 7 }));
    expect(early).toMatchObject({ complete: true, cursor: { fromSequence: 1, toSequence: 7, acknowledgedThrough: 7 }, previewObservations: [], limitations: [] });
    expect(early.committedConfigurations.map(item => item.runId)).toEqual(['run-1']);
    expect(early.text).toContain('The record is complete through event 7.');
    const middle = summarize(input({ fromSequence: 8, toSequence: 15 }));
    expect(middle.complete).toBe(true);
    expect(middle.committedConfigurations.map(item => item.runId)).toEqual(['run-2']);
    expect(middle.previewObservations.map(item => [item.previewId, item.outcome])).toEqual([['pv-1', 'committed'], ['pv-2', 'cancelled']]);
    expect(middle.revealed).toEqual([{ exposureId: 'exp-2', groups: ['g-trajectory'], displayStatus: 'authorized', sequence: 15 }]);
    // A cursor that ends inside a preview does not invent an outcome for it.
    const cut = summarize(input({ fromSequence: 8, toSequence: 8 }));
    expect(cut.previewObservations).toEqual([]);
    expect(cut.limitations).toContain('Preview pv-1 ends after event 8, outside this summary.');
    // A pending event inside the range makes it incomplete.
    expect(summarize(input({ fromSequence: 15, toSequence: 16 })).complete).toBe(false);
  });

  it('reports trimmed or missing history as omitted events instead of claiming completeness', () => {
    const events = journal();
    const summary = summarize(input({ events: events.slice(5, 15), trimmedBefore: 5 }));
    expect(summary.omitted.events).toBe(5);
    expect(summary.complete).toBe(false);
    expect(summary.limitations[0]).toBe('Events 1–5 are not held locally (5 acknowledged events were trimmed from local history); the host journal holds the full record.');
    expect(summary.committedConfigurations.map(item => item.runId)).toEqual(['run-2']);
    const gap = summarize(input({ events: [...events.slice(0, 3), ...events.slice(4, 15)], fromSequence: 1, toSequence: 15 }));
    expect(gap).toMatchObject({ complete: false, omitted: { events: 1 } });
    expect(gap.limitations[0]).toBe('Events 4 are not held locally; the host journal holds the full record.');
  });

  it('marks uncertain exposures from the current record as potentially seen', () => {
    const restored = [EXPOSURES[0]!, { ...EXPOSURES[1]!, displayStatus: 'uncertain' as const, uncertainty: { code: 'INTERRUPTED_BEFORE_ACK' as const, reason: 'Restored without a display acknowledgement.' } }];
    const summary = summarize(input({ exposures: restored }));
    expect(summary.revealed[1]).toMatchObject({ exposureId: 'exp-2', displayStatus: 'uncertain' });
    expect(summary.limitations).toContain('Exposure exp-2 (INTERRUPTED_BEFORE_ACK) is uncertain and counted as potentially seen.');
    const unlinked = summarize(input({ exposures: [...restored, exposure('exp-9', 'rcpt-9', [POSITION], 'displayed')] }));
    expect(unlinked.complete).toBe(false);
    expect(unlinked.limitations).toContain('Exposure record exp-9 has no authorizing event in the local journal; see the host exposure records.');
  });

  it('reports coalesced presentation changes', () => {
    expect(summarize(input({ coalescedViewChanges: 3 })).limitations).toContain('3 presentation changes coalesced into later presentation state were not journaled individually.');
  });

  it('summarizes an empty journal as complete without inventing activity', () => {
    const summary = summarize(input({ events: [], pending: [], exposures: [], instance: predictInstance }));
    expect(summary).toMatchObject({ cursor: { fromSequence: 0, toSequence: 0, acknowledgedThrough: 0 }, complete: true, committedConfigurations: [], revealed: [], limitations: [] });
    expect(summary.text).toBe('No events are recorded for activity act-quadratic-0001. Recorded 0 committed configurations. No previews were recorded. No content was revealed in this range. The record is complete through event 0.');
  });
});

describe('summary limits and truncation (A17)', () => {
  it('selects the first, the last and evenly spaced representatives', () => {
    expect(representatives([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 3, 6, 9]);
    expect(representatives([0, 1, 2], 5)).toEqual([0, 1, 2]);
    expect(representatives([0, 1, 2], 1)).toEqual([0]);
    expect(representatives([0, 1, 2], 0)).toEqual([]);
  });

  it('keeps at most the configured representative configurations and counts the omission', () => {
    const commits = Array.from({ length: 7 }, (_, item) => at('parameters.committed', item + 1, { runId: `run-${item + 1}`, previousRunId: item ? `run-${item}` : null, params: { a: 1, eta: 0.25 * (item + 1), x0: 8 }, cause: item ? 'commit' : 'initial' }));
    const summary = summarize(input({ events: commits, pending: [], exposures: [], instance: predictInstance, limits: { committedConfigurations: 3 } }));
    expect(summary.committedConfigurations.map(item => item.runId)).toEqual(['run-1', 'run-4', 'run-7']);
    expect(summary.omitted.committedConfigurations).toBe(4);
    expect(summary.complete).toBe(false);
    expect(summary.limitations).toContain('Showing 3 of 7 committed configurations: the first, the last and evenly spaced by sequence.');
    expect(summary.text).toContain('Recorded 7 committed configurations, of which 3 are listed.');
  });

  it('shrinks to the 32 KiB default and to a lowered byte limit, marking truncation', () => {
    const vector = (seed: number) => Array.from({ length: 200 }, (_, item) => seed + item / 7);
    const commits = Array.from({ length: 30 }, (_, item) => at('parameters.committed', item + 1, {
      runId: `run-${item + 1}`, previousRunId: item ? `run-${item}` : null, params: { a: 1, eta: 0.05 * (item + 1), x0: 8 }, cause: item ? 'commit' : 'initial', visibleQuantities: { trace: valid(vector(item)) },
    }));
    const base = input({ events: commits, pending: [], exposures: [], instance: predictInstance, audience: 'teacher' });
    const summary = summarize(base);
    expect(new TextEncoder().encode(JSON.stringify(summary)).length).toBeLessThanOrEqual(SUMMARY_LIMITS.bytes);
    expect(summary.committedConfigurations.length).toBeLessThan(20);
    expect(summary.committedConfigurations[0]!.observations.trace).toBeDefined();
    expect(summary.omitted.committedConfigurations).toBe(30 - summary.committedConfigurations.length);
    expect(summary.complete).toBe(false);
    expect(summary.limitations).toContain(`The summary was reduced to fit the ${SUMMARY_LIMITS.bytes}-byte limit.`);
    const small = summarize({ ...base, limits: { bytes: 4096 } });
    expect(new TextEncoder().encode(JSON.stringify(small)).length).toBeLessThanOrEqual(4096);
    expect(small.limitations).toContain('Recorded values were left out of the committed configurations to fit the size limit.');
    expect(() => summarize({ ...base, limits: { bytes: 200 } })).toThrow(SummaryError);
  });

  it('allows limits to be lowered only and validates the cursor', () => {
    const reject = (overrides: Partial<SummaryInput>, path: string) => {
      const result = trySummarize(input(overrides));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]).toMatchObject({ code: 'INVALID_INPUT', path });
    };
    reject({ limits: { committedConfigurations: 21 } }, '$.limits.committedConfigurations');
    reject({ limits: { bytes: SUMMARY_LIMITS.bytes + 1 } }, '$.limits.bytes');
    reject({ limits: { previewObservations: -1 } }, '$.limits.previewObservations');
    reject({ limits: { everything: 1 } as never }, '$.limits.everything');
    reject({ fromSequence: 9, toSequence: 3 }, '$.fromSequence');
    reject({ fromSequence: 1.5 }, '$.fromSequence');
    reject({ trimmedBefore: -1 }, '$.trimmedBefore');
    reject({ pending: [{ ...journal()[15]!, activityId: 'act-other' }] }, '$.pending[0].activityId');
    reject({ pending: [{ ...journal()[15]!, sequence: 3 }] }, '$.pending[0].sequence');
    expect(() => summarize(input({ limits: { committedConfigurations: 25 } }))).toThrow(SummaryError);
    expect(summarize(input({ limits: { committedConfigurations: 20, previewObservations: 1 } })).previewObservations.map(item => item.previewId)).toEqual(['pv-1']);
  });
});

describe('summary audience and vocabulary (A17, A21)', () => {
  // A template variant where the curvature has no learner-facing control.
  const noCurvature: ActivityTemplate = { ...quadraticTemplate, controls: quadraticTemplate.controls.filter(control => control.parameter !== 'a') };
  const extra = (): InteractionEvent[] => [at('parameters.committed', 1, { runId: 'run-1', previousRunId: null, params: { a: 2, eta: 0.5, x0: 8 }, cause: 'initial', visibleQuantities: { x: valid(8), hostTrace: valid(1) } }, { frame: frame('run-1', 0) })];
  const by = (audience: InteractionSummary['audience']) => summarize(input({ events: extra(), pending: [], exposures: [], instance: predictInstance, template: noCurvature, audience }));

  it('gives learner and tutor audiences only learner-facing parameters and recorded visible quantities', () => {
    for (const audience of ['learner', 'tutor'] as const) {
      const [configuration] = by(audience).committedConfigurations;
      expect(configuration!.params, audience).toEqual({ eta: 0.5, x0: 8 });
      expect(configuration!.observations, audience).toEqual({ x: valid(8) });
    }
    for (const audience of ['teacher', 'host'] as const) {
      const [configuration] = by(audience).committedConfigurations;
      expect(configuration!.params, audience).toEqual({ a: 2, eta: 0.5, x0: 8 });
      expect(configuration!.observations, audience).toEqual({ hostTrace: valid(1), x: valid(8) });
    }
  });

  it('takes observations from one recorded event and never merges values hidden at that point', () => {
    const [run] = summarize(input({ audience: 'learner' })).committedConfigurations;
    // `loss` was visible at index 0 but not recorded at index 5, so it is not reported for the furthest position.
    expect(run!.observations).toEqual({ x: valid(0.25) });
    expect(JSON.stringify(summarize(input({ audience: 'learner' })))).not.toContain('"multiplier"');
  });

  it('never contains assessment vocabulary in the text or any string field', () => {
    for (const word of ['understood', 'understands', 'mastered', 'mastery', 'knows', 'learned', 'learnt', 'competent', 'proficient', 'Proficiency', 'Learning']) expect(FORBIDDEN_SUMMARY_TERMS.test(word), word).toBe(true);
    for (const word of ['knowable', 'unknown', 'learner', 'masterpiece', 'mastodon']) expect(FORBIDDEN_SUMMARY_TERMS.test(word), word).toBe(false);
    const hostile: ActivityTemplate = { ...quadraticTemplate, groups: quadraticTemplate.groups.map(group => group.id === 'g-trajectory' ? { ...group, label: 'What the learner now knows' } : group) };
    const events = journal().map(item => {
      if (item.type === 'comparison.retained') return { ...item, payload: { ...item.payload, label: 'Mastered this one' } };
      if (item.type === 'preview.observed') return { ...item, payload: { ...item.payload, samplingPolicy: 'learned-sampling' } };
      return item;
    });
    const scenarios: SummaryInput[] = [
      input(), input({ fromSequence: 8, toSequence: 8 }), input({ events: [], pending: [], exposures: [] }),
      input({ template: hostile, events: events.slice(0, 15), pending: events.slice(15), coalescedViewChanges: 2, limits: { committedConfigurations: 1, previewObservations: 1 } }),
    ];
    for (const audience of ['learner', 'tutor', 'teacher', 'host'] as const) {
      for (const scenario of scenarios) {
        const summary = summarize({ ...scenario, audience });
        for (const text of strings(summary)) expect(FORBIDDEN_SUMMARY_TERMS.test(text), `${audience}: ${text}`).toBe(false);
      }
    }
    const hostileSummary = summarize(scenarios[3]!);
    expect(hostileSummary.comparisons[0]!.label).toBe('Run run-1');
    expect(hostileSummary.previewObservations[0]!.samplingPolicy).toBe('sampled rendered values');
    expect(hostileSummary.text).toContain('Revealed content groups: g-trajectory, Position and loss.');
  });
});
