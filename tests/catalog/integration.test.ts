/**
 * Integration of the installed catalogue with the activity contracts (report §5, A02, D10): the installed template
 * and manifest, records built from their identities, and records carrying real kernel frames must be accepted by
 * the activity schemas in TypeScript and, from the same emitted schema files, in Rust.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyRecord, groupDigests, templateRef, validateInstanceSemantics, validatePolicySemantics, validateRecord, validateTemplateSemantics,
  type ActivityInstance, type HostPolicy, type InteractionEvent, type InteractionSummary, type QuantityResult, type ScientificSnapshot,
  type SchemaName, type StageTransitionRequest,
} from '@explorable-models/activity';
import { evaluateRequest, modelIdentity, type ModelManifest } from '@explorable-models/core/model';
import { INSTALLED_KERNELS, quadraticGradientDescentManifest as manifest, quadraticGradientDescentTemplate as template } from '@explorable-models/catalog';
import { rustDecisions } from '../activity/support/rust.js';

const identity = modelIdentity(manifest);
const MODEL = { modelId: manifest.modelId, version: manifest.version, digest: identity.digest };
const TEMPLATE = templateRef(template);
const ACTIVITY = 'act-quadratic-0001';
const defaults = Object.fromEntries(Object.entries(manifest.parameters).map(([id, definition]) => [id, definition.default]));

/** Parameter sets across every regime and numerical edge of the installed domain (η·a ≤ 4, |x0| ≤ 10). */
const SWEEP: Record<string, number>[] = [
  { a: 2, eta: 0.25, x0: 4 }, { a: 2, eta: 0.5, x0: 4 }, { a: 2, eta: 0.75, x0: 4 }, { a: 5, eta: 0.4, x0: 4 }, { a: 2, eta: 2, x0: 10 },
  { a: 10, eta: 0.4, x0: -10 }, { a: 0.1, eta: 2, x0: 1e-300 }, { a: 2, eta: 0.75, x0: Number.MIN_VALUE }, { a: 2, eta: 0, x0: 0 },
];
const INDICES = [0, 1, 2, 40, 300, 1000];
const frames = SWEEP.flatMap(params => INDICES.map(index => ({ params, data: evaluateRequest({ manifest, params, position: { kind: 'index', index } }, INSTALLED_KERNELS) })));

const revisions = { scientific: { modelDigest: MODEL.digest, runId: 'run-0001', version: 1 }, presentation: 0, activity: 0, hostSession: 0, policy: 1 };
const event = (sequence: number, type: InteractionEvent['type'], payload: Record<string, unknown>): InteractionEvent => ({
  contract: 'study-harness.interaction-event', schemaVersion: '1.0', eventId: `evt-${sequence}`, activityId: ACTIVITY, sequence, operationId: `op-${sequence}`,
  actor: { kind: 'learner', binding: 'surface-main' }, type, revisions, payload, monotonicMs: sequence, causes: [],
});
const positionEvents = frames.map(({ data }, index) => event(index + 1, 'position.changed', {
  runId: 'run-0001', from: { kind: 'index', index: 0, maxIndex: 1000 }, to: data.position, cause: 'navigate', visibleQuantities: data.quantities,
}));
const summary: InteractionSummary = {
  contract: 'study-harness.interaction-summary', schemaVersion: '1.0', summarizerVersion: '1.0.0', activityId: ACTIVITY, audience: 'teacher', template: TEMPLATE, model: MODEL,
  cursor: { fromSequence: 1, toSequence: frames.length, acknowledgedThrough: frames.length }, complete: false,
  committedConfigurations: frames.filter(({ data }) => data.position.kind === 'index' && data.position.index === 1000).map(({ params, data }, index) => ({
    runId: `run-${index + 1}`, params, furthestPosition: data.position, cause: 'commit' as const, sequence: index + 1, observations: data.quantities,
  })),
  previewObservations: [], revealed: [], comparisons: [], responses: [], omitted: { committedConfigurations: 0, previewObservations: 0, events: 0 },
  limitations: ['Integration fixture: built from kernel frames, not from a journal.'], text: 'Explored 9 committed configurations.',
};

const instance: ActivityInstance = {
  contract: 'study-harness.activity-instance', schemaVersion: '1.0', activityId: ACTIVITY, objectiveIds: ['obj-step-size'], hostSessionId: 'host-session-1',
  hostSessionRevision: 0, template: TEMPLATE, model: MODEL, initialParameters: defaults, mode: 'approved', stage: { id: template.initialStage, enteredAtSequence: 0 },
  activityRevision: 0, policy: { policyId: 'policy-1', revision: 1 }, context: { kind: 'instructional' }, responses: [], allowedActions: ['prepare', 'operate.parameters'],
  persistence: 'saved', closed: false,
};
const policy: HostPolicy = {
  contract: 'study-harness.host-policy', schemaVersion: '1.0', policyId: 'policy-1', revision: 1, issuedAt: '2026-10-26T09:00:00Z', expiresAt: null, revoked: false,
  mode: 'approved', approved: [{ template: TEMPLATE, model: MODEL }], allowedTools: ['discover', 'prepare', 'request-reveal', 'operate.parameters', 'operate.navigation', 'summarize'],
  visibleGroups: template.groups.map(group => group.id), permittedControls: template.controls.map(control => control.parameter),
  export: { learnerSnapshot: true, capture: false, backup: true }, inspection: { developer: false, tutor: 'learner-visible', teacher: false },
  independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] }, sampling: { allowed: false, maxPositions: 0 },
  exploratory: { allowed: false, maxParametersOverride: 0 },
};
/** Entering step exploration reveals the solution-bearing groups visible in that stage, bound to their content digests. */
const explore = template.stages.find(stage => stage.id === 'explore-step')!;
const revealing = groupDigests(template, manifest).filter(entry => explore.visible[entry.groupId] && template.groups.find(group => group.id === entry.groupId)!.solutionBearing);
const transition: StageTransitionRequest = {
  activityId: ACTIVITY, operationId: 'op-stage-1', idempotencyKey: 'op-stage-1', fromStage: 'predict', toStage: 'explore-step', basedOnActivityRevision: 0,
  expectedPolicyRevision: 1, actor: 'host', groups: revealing, template: TEMPLATE, model: MODEL,
};
const last = frames.at(-1)!.data;
const scientific: ScientificSnapshot = {
  contract: 'study-harness.scientific-snapshot', schemaVersion: '1.0', model: MODEL, scientificRevision: identity.scientificRevision,
  runtime: { id: 'explorable-models.model-runtime', version: '1.0.0' }, runId: 'run-0001', params: last.params, position: last.position, terminal: last.terminal.reached, comparisons: [],
};

const RECORDS: [string, SchemaName, unknown][] = [
  ['template', 'study-harness.activity-template', template],
  ['manifest', 'explorable-models.model-manifest', manifest],
  ['instance', 'study-harness.activity-instance', instance],
  ['policy', 'study-harness.host-policy', policy],
  ['stage-transition', 'study-harness.stage-transition-request', transition],
  ['scientific', 'study-harness.scientific-snapshot', scientific],
  ['summary', 'study-harness.interaction-summary', summary],
  ...positionEvents.map((value, index): [string, SchemaName, unknown] => [`event-${index}`, 'study-harness.interaction-event', value]),
];

describe('installed catalogue content in the activity contracts', () => {
  it('binds the installed template to the exact manifest digest', () => {
    expect(template.model).toEqual(MODEL);
    expect(validateTemplateSemantics(template, manifest)).toEqual([]);
    const retitled = { ...structuredClone(manifest), title: 'Retitled copy' } as ModelManifest;
    expect(validateTemplateSemantics(template, retitled).map(item => `${item.code} ${item.path}`)).toEqual(['INVALID_REFERENCE $.model.digest']);
  });

  it('builds schema-valid and semantically valid instance, policy and stage-transition records from catalogue identities', () => {
    expect(revealing.map(entry => entry.groupId)).toEqual(['trace', 'observations']);
    expect(validateInstanceSemantics(instance, template)).toEqual([]);
    expect(validatePolicySemantics(policy)).toEqual([]);
    for (const [name, contract, value] of RECORDS.filter(([name]) => !name.startsWith('event-'))) {
      expect(validateRecord(contract, value), name).toEqual({ ok: true, diagnostics: [] });
      // Records declare their contract and version; host-port messages are identified by their channel instead.
      if (contract !== 'study-harness.stage-transition-request') expect(classifyRecord(value), name).toEqual({ kind: 'study-harness', contract, version: '1.0' });
    }
  });

  it('records every real kernel frame of the domain sweep in events and summaries, including values beyond ±1e15', () => {
    const results: QuantityResult[] = frames.flatMap(({ data }) => Object.values(data.quantities));
    // The sweep reaches every status the journal must carry (D10): huge finite values, overflow, underflow and subnormals.
    expect(results.some(result => result.status === 'valid' && typeof result.value === 'number' && Math.abs(result.value) > 1e15)).toBe(true);
    expect(results.some(result => result.status === 'numerical-limit' && result.code === 'OVERFLOW')).toBe(true);
    expect(results.some(result => result.status === 'numerical-limit' && result.code === 'UNDERFLOW')).toBe(true);
    expect(results.some(result => result.status === 'valid' && result.approximation?.code === 'UNDERFLOW')).toBe(true);
    const rejected = positionEvents.map((value, index) => [index, validateRecord('study-harness.interaction-event', value)] as const).filter(([, result]) => !result.ok);
    expect(rejected.map(([index, result]) => `${JSON.stringify(frames[index]!.params)}@${INDICES[index % INDICES.length]}: ${result.diagnostics[0]!.path}`)).toEqual([]);
    expect(summary.committedConfigurations).toHaveLength(SWEEP.length);
    expect(validateRecord('study-harness.interaction-summary', summary)).toEqual({ ok: true, diagnostics: [] });
  });

  it('is accepted by the Rust validator from the same emitted schema files', () => {
    const root = mkdtempSync(join(tmpdir(), 'catalog-contracts-'));
    try {
      for (const [name, contract, value] of RECORDS) writeFileSync(join(root, `${name}.json`), JSON.stringify({ contract, expect: 'valid', why: 'Installed catalogue content.', value }));
      const decisions = rustDecisions(root);
      expect(decisions.map(decision => decision.file).sort()).toEqual(RECORDS.map(([name]) => `${name}.json`).sort());
      expect(decisions.filter(decision => !decision.valid).map(decision => decision.file)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 900_000);
});
