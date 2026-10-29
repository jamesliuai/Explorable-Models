/**
 * The host-agnostic HostPort conformance kit (`@explorable-models/activity/conformance`, external gate G2, A54 preparation)
 * run against the test-only memory host in its `conformant` profile, and against sabotaged variants of it: each defect
 * a real host could have must make the kit fail the step that checks that semantics. Results produced here are
 * memory-fixture-host results and never evidence about the Study Harness application.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isHostRefusal, templateRef, type ActivityRequest, type HostPolicy, type HostPort } from '@explorable-models/activity';
import {
  HOST_CONFORMANCE_RESULT_JSON_SCHEMA, HOST_CONFORMANCE_STEPS, runHostPortConformance, stepOutcome,
  type HostConformanceHooks, type HostConformanceOptions, type HostConformanceRun, type HostCrashPoint,
} from '@explorable-models/activity/conformance';
import { createInstalledCatalog, INSTALLED_KERNELS, quadraticGradientDescentManifest as manifest, quadraticGradientDescentTemplate as template } from '@explorable-models/catalog';
import { modelIdentity, schemaErrors, type JsonSchema } from '@explorable-models/core/model';
import { inlineWorkers } from '../core/support/inline-worker.js';
import { MemoryHost, type CrashPoint, type MemoryHostSnapshot } from './support/memory-host.js';

const TEMPLATE = templateRef(template);
const MODEL = { modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest };
const SOLUTION = template.groups.filter(group => group.solutionBearing).map(group => group.id);
const NEUTRAL = template.groups.filter(group => group.kind === 'equation' && !group.solutionBearing).map(group => group.id);
const TOOLS: HostPolicy['allowedTools'] = ['discover', 'prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'operate.navigation', 'operate.playback', 'operate.presentation', 'summarize', 'save', 'restore', 'close'];

/** A host policy for one activity: solution-bearing groups held back until the host authorizes them. */
function policyFor(activityId: string, patch: Partial<HostPolicy> = {}): HostPolicy {
  return {
    contract: 'study-harness.host-policy', schemaVersion: '1.0', policyId: `pol-${activityId}`, revision: 1, issuedAt: '2026-10-26T08:00:00.000Z', expiresAt: null, revoked: false,
    mode: 'approved', approved: [{ template: TEMPLATE, model: MODEL }], allowedTools: TOOLS,
    visibleGroups: template.groups.filter(group => !group.solutionBearing).map(group => group.id), permittedControls: template.controls.map(control => control.parameter),
    export: { learnerSnapshot: true, capture: false, backup: true }, inspection: { developer: false, tutor: 'learner-visible', teacher: true },
    independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] }, sampling: { allowed: false, maxPositions: 0 },
    exploratory: { allowed: false, maxParametersOverride: 0 },
    ...patch,
  };
}
const requestFor = (activityId: string): ActivityRequest => ({
  activityId, objectiveIds: ['obj-step-size'], hostSessionId: 'hs-kit', hostSessionRevision: 0, template: { templateId: template.templateId, version: template.version }, mode: 'approved',
});
const CRASH: Record<HostCrashPoint, CrashPoint> = { 'intent-before-commit': 'before-intent-commit', 'intent-after-commit': 'after-intent-commit-before-reply', 'display-ack-before-commit': 'before-ack-commit' };

/** The memory host under test plus the host-side hooks a real host would implement over its own store. */
interface Fixture { host: MemoryHost; hooks: HostConformanceHooks; options: HostConformanceOptions }
type HostFactory = (snapshot?: MemoryHostSnapshot) => MemoryHost;

function fixture(make: HostFactory = snapshot => snapshot ? MemoryHost.fromSnapshot(snapshot, { profile: 'conformant' }) : new MemoryHost({ policy: policyFor('default'), profile: 'conformant' }),
  overrides: Partial<HostConformanceHooks> = {}): Fixture {
  const workers = inlineWorkers(INSTALLED_KERNELS);
  const catalog = createInstalledCatalog({ workerFactory: workers.factory });
  let counter = 0;
  const box: Fixture = { host: make(), hooks: null as unknown as HostConformanceHooks, options: null as unknown as HostConformanceOptions };
  const hooks: HostConformanceHooks = {
    async openActivity() {
      const activityId = `act-kit-${++counter}`;
      box.host.setActivityPolicy(activityId, policyFor(activityId));
      return requestFor(activityId);
    },
    async restart() {
      // A new host over the same durable tables; the restart rule runs as on any host start.
      const next = make(box.host.snapshot());
      next.interruptUnacknowledged();
      box.host = next;
      return next;
    },
    async respond({ activityId, kind, stageId, taskId }) {
      const { expected, produced } = box.host.respond(activityId);
      return { response: { responseId: `resp-${activityId}-${produced}`, taskId, taskRevision: 1, kind, modality: 'text', stageId }, expectedHostSessionRevision: expected, hostSessionRevision: produced };
    },
    async hostSessionRevision({ activityId }) { return box.host.hostSessionRevision(activityId); },
    async authorizeReveal({ activityId, groups }) {
      return box.host.amendActivityPolicy(activityId, current => ({ visibleGroups: [...new Set([...current.visibleGroups, ...groups])] }));
    },
    async startIndependentTask({ activityId }) {
      const taskId = `${activityId}-task-${++counter}`;
      const taskRef = `task-${counter}`;
      const policy = policyFor(taskId, { visibleGroups: NEUTRAL, permittedControls: [], independentTask: { active: true, taskRef, permittedTools: ['inspect.learner'], neutralScaffold: NEUTRAL } });
      box.host.setActivityPolicy(taskId, policy);
      return { request: requestFor(taskId), taskRef, policy };
    },
    async armCrash(point) { box.host.crashAt(CRASH[point]); },
    ...overrides,
  };
  box.hooks = hooks;
  box.options = {
    subject: 'memory-fixture-host', catalog, hooks,
    host: { name: 'memory-host', commit: '0000000', dirty: true, binarySha256: '0'.repeat(64), platform: { os: 'macOS', osVersion: '26.0', arch: 'arm64' } },
    packages: [{ name: '@explorable-models/activity', version: '0.3.0-preview.1', sha256: '0'.repeat(64) }],
    limitations: ['Test-only memory host (tests/activity/support/memory-host.ts); not a reference host and not the Study Harness application.'],
    adapter: { persistenceWaitMs: 2000 },
  };
  return box;
}
/** The current host, wherever a restart moved it (the HostPort the kit is handed delegates to it). */
const delegating = (box: Fixture): HostPort => new Proxy({} as HostPort, { get: (_, key) => { const value = (box.host as unknown as Record<PropertyKey, unknown>)[key]; return typeof value === 'function' ? value.bind(box.host) : value; } });
const run = (box: Fixture): Promise<HostConformanceRun> => runHostPortConformance(delegating(box), box.options);
const outcome = (run: HostConformanceRun, step: string, id: string) => run.checks.find(check => check.step === step && check.id === id)?.outcome;
const failedIn = (run: HostConformanceRun) => run.checks.filter(check => check.outcome === 'fail').map(check => `${check.step}/${check.id}`);

describe('HostPort conformance kit against the memory host (memory-fixture-host)', () => {
  it('passes every step of the G2 sequence and produces a record in the template form', async () => {
    const box = fixture();
    const result = await run(box);
    expect(failedIn(result), JSON.stringify(result.checks.filter(check => check.outcome !== 'pass'), null, 1)).toEqual([]);
    expect(result.problems).toEqual([]);
    for (const step of HOST_CONFORMANCE_STEPS) expect(result.result.steps[step].outcome, step).toBe('pass');
    expect(result.result.result).toBe('pass');
    expect(result.result.subject).toBe('memory-fixture-host');
    expect(result.result.kit?.name).toBe('@explorable-models/activity/conformance');
    // Every HostPort semantics the kit is meant to check was actually evaluated (not skipped).
    for (const [step, id] of [
      ['open-quadratic', 'unknown-activity-refused'], ['prediction-reference', 'host-revision-durable'], ['prediction-reference', 'registration-ahead-refused'],
      ['authorize-reveal', 'grant-outside-policy-refused'], ['authorize-reveal', 'refusal-reported-with-convention-code'], ['authorize-reveal', 'refusal-not-retried'],
      ['authorize-reveal', 'authorization-is-not-display'], ['authorize-reveal', 'display-ack-requires-authorization'], ['authorize-reveal', 'intent-replay-identical'],
      ['authorize-reveal', 'fingerprint-conflict-refused'], ['authorize-reveal', 'durable-before-return'], ['commit-exploration', 'duplicate-eventid-deduped'],
      ['commit-exploration', 'sequence-gap-refused'], ['save', 'save-conflict-refused'], ['save', 'checkpoint-durable'], ['reopen-verify', 'host-records-read-on-restore'], ['reopen-verify', 'host-activity-state'],
      ['reopen-verify', 'assistance-read-back-after-restart'],
      // Host-read semantics of `ActivityRecords.activity` (R01, R04): the stage a receipt moved to and the receipt that moved
      // it, the context lineage, a registration that never moves the host's state, a forged grant the host's records do
      // not confirm, and an earlier checkpoint that adopts the host's stage and revision and continues.
      ['authorize-reveal', 'host-stage-follows-receipt'], ['authorize-reveal', 'stage-receipt-named'], ['reopen-verify', 'host-lineage-instructional'],
      ['reopen-verify', 'host-revision-is-latest-receipt'], ['reopen-verify', 'stage-receipt-kept'], ['reopen-verify', 'registration-keeps-host-state'],
      ['reopen-verify', 'forged-grant-not-confirmed'], ['reopen-verify', 'earlier-checkpoint-adopts-host-state'], ['reopen-verify', 'saved-grant-confirmed-by-host'],
      ['reopen-verify', 'host-step-after-earlier-checkpoint'], ['independent-task', 'independent-lineage'],
      ['independent-task', 'host-refuses-instructional-grant'], ['crash-after-display', 'journal-complete-or-loss-recorded'],
    ] as const) expect(outcome(result, step, id), `${step}/${id}`).toBe('pass');
    // The record validates against the docs template file itself (read from disk), and the kit's embedded schema is that
    // template exactly.
    const schema = JSON.parse(readFileSync(new URL('../../docs/study-harness/templates/host-conformance-result.schema.json', import.meta.url), 'utf8')) as JsonSchema;
    expect(schema).toEqual(JSON.parse(JSON.stringify(HOST_CONFORMANCE_RESULT_JSON_SCHEMA)));
    expect(schemaErrors(result.result, schema)).toEqual([]);
    // A subject label outside the three the template allows is rejected.
    expect(schemaErrors({ ...result.result, subject: 'study-harness' }, schema).length).toBeGreaterThan(0);
  }, 60_000);

  it('records steps the host cannot exercise as not run, never as passed', async () => {
    const box = fixture();
    const { openActivity } = box.hooks;
    box.options = { ...box.options, hooks: { openActivity }, environment: { 'camera-change': 'Display-dependent in this host (window hidden).' } };
    const result = await run(box);
    expect(result.problems).toEqual([]);
    expect(result.result.result).toBe('incomplete');
    expect(result.result.steps['open-quadratic'].outcome).toBe('pass');
    expect(result.result.steps['camera-change']).toMatchObject({ outcome: 'not-run (environment)', environmentReason: 'Display-dependent in this host (window hidden).' });
    for (const step of ['prediction-reference', 'terminate', 'reopen-verify', 'independent-task', 'crash-before-intent', 'crash-after-intent', 'crash-after-display'] as const) {
      expect(result.result.steps[step].outcome, step).toBe('not-run');
      expect(result.result.steps[step].reason, step).toMatch(/supplied no|Depends on/);
    }
    // Without authorizeReveal the reveal step stops after its host-side probe instead of passing.
    expect(result.result.steps['authorize-reveal'].outcome).toBe('not-run');
    expect(stepOutcome([])).toBe('not-run');
  }, 60_000);

  it('records the host-read checks as not run when the host omits its activity state, never as passed', async () => {
    const withheld: HostFactory = snapshot => {
      const host = snapshot ? MemoryHost.fromSnapshot(snapshot, { profile: 'conformant' }) : new MemoryHost({ policy: policyFor('default'), profile: 'conformant' });
      host.withholdActivity = true;
      return host;
    };
    const result = await run(fixture(withheld));
    expect(failedIn(result)).toEqual([]);
    for (const [step, id] of [
      ['authorize-reveal', 'host-stage-follows-receipt'], ['authorize-reveal', 'stage-receipt-named'], ['reopen-verify', 'host-activity-state'], ['reopen-verify', 'host-lineage-instructional'],
      ['reopen-verify', 'registration-keeps-host-state'], ['reopen-verify', 'forged-grant-not-confirmed'], ['reopen-verify', 'earlier-checkpoint-adopts-host-state'],
      ['independent-task', 'independent-lineage'],
    ] as const) expect(outcome(result, step, id), `${step}/${id}`).toBe('not-run');
    expect(result.result.steps['reopen-verify'].outcome).toBe('not-run');
    expect(result.result.result).toBe('incomplete');
  }, 60_000);

  it('never labels a run by itself', async () => {
    const box = fixture();
    await expect(runHostPortConformance(box.host, { ...box.options, subject: undefined as never })).rejects.toThrow(TypeError);
    await expect(runHostPortConformance(box.host, { ...box.options, subject: 'Study Harness' as never })).rejects.toThrow(/Label the host/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Sabotaged hosts: each makes the kit fail the step that checks the violated semantics.
// ---------------------------------------------------------------------------------------------------------------
const MUTATING = ['registerActivity', 'requestStageTransition', 'recordExposureIntent', 'recordDisplayAck', 'recordAssistance', 'appendEvents', 'saveArtifact'] as const;

/** Appends a resent event again as a new journal entry instead of recognizing its eventId. */
class NoEventDedupe extends MemoryHost {
  override appendEvents(request: Parameters<MemoryHost['appendEvents']>[0]) {
    const known = new Set(this.events(request.activityId).map(event => event.eventId));
    if (!request.events.some(event => known.has(event.eventId))) return super.appendEvents(request);
    let last = this.events(request.activityId).at(-1)?.sequence ?? 0;
    const events = request.events.map(event => known.has(event.eventId) ? { ...event, eventId: `${event.eventId}-again-${last + 1}`, sequence: ++last } : { ...event, sequence: ++last });
    return super.appendEvents({ ...request, events });
  }
}
/** Acknowledges every write before it is durable: a write is committed only when the next write begins. */
class AcknowledgesBeforeCommit extends MemoryHost {
  /** The state before the latest write began (that write is acknowledged but not yet durable); null before any write. */
  private durable: MemoryHostSnapshot | null = null;
  constructor(...args: ConstructorParameters<typeof MemoryHost>) {
    super(...args);
    for (const method of MUTATING) {
      const original = (this as unknown as Record<string, (request: unknown) => Promise<unknown>>)[method]!.bind(this);
      (this as unknown as Record<string, (request: unknown) => Promise<unknown>>)[method] = request => { this.durable = super.snapshot(); return original(request); };
    }
  }
  override snapshot(): MemoryHostSnapshot { return this.durable ? structuredClone(this.durable) : super.snapshot(); }
}
/** Reports its refusals as transient failures (no refusal code), so they look retryable and are retried. */
function refusalsAsFailures(host: MemoryHost): MemoryHost {
  for (const method of [...MUTATING, 'getPolicy', 'getJournalCursor', 'getActivityRecords'] as const) {
    const original = (host as unknown as Record<string, (request: unknown) => Promise<unknown>>)[method]!.bind(host);
    (host as unknown as Record<string, (request: unknown) => Promise<unknown>>)[method] = async request => {
      try { return await original(request); } catch (error) { if (isHostRefusal(error)) throw new Error('The host is temporarily unavailable.'); throw error; }
    };
  }
  return host;
}
/** Accepts a display acknowledgement for an exposure it never authorized (or under another receipt). */
class AcknowledgesUnauthorizedDisplay extends MemoryHost {
  override recordDisplayAck(request: Parameters<MemoryHost['recordDisplayAck']>[0]) {
    const known = this.exposures(request.activityId).find(record => record.exposureId === request.exposureId);
    if (!known || known.receiptId !== request.receiptId) return Promise.resolve({ ok: true as const, hostTimestamp: '2026-10-26T09:00:00.000Z' });
    return super.recordDisplayAck(request);
  }
}

/** Reports a stale activity revision in its records instead of the host-owned counter (R04: hosts are the authority). */
class StaleActivityState extends MemoryHost {
  override async getActivityRecords(request: Parameters<MemoryHost['getActivityRecords']>[0]) {
    const records = await super.getActivityRecords(request);
    return records.activity ? { ...records, activity: { ...records.activity, activityRevision: 0 } } : records;
  }
}

/** Names the latest receipt of any kind as the one that moved the activity to its stage. */
class LatestReceiptAsStageReceipt extends MemoryHost {
  override async getActivityRecords(request: Parameters<MemoryHost['getActivityRecords']>[0]) {
    const records = await super.getActivityRecords(request);
    const latest = this.receipts(request.activityId).at(-1)?.receiptId;
    return records.activity && latest ? { ...records, activity: { ...records.activity, stageReceiptId: latest } } : records;
  }
}
/** Reports one instructional lineage for every activity: an independent task never ends the earlier grants. */
class ContinuousLineage extends MemoryHost {
  override async getActivityRecords(request: Parameters<MemoryHost['getActivityRecords']>[0]) {
    const records = await super.getActivityRecords(request);
    return records.activity ? { ...records, activity: { ...records.activity, lineage: { context: { kind: 'instructional' as const }, fromActivityRevision: 0 } } } : records;
  }
}
/** Reads its exposure records from the latest backup it stored instead of its own receipts. */
class RecordsFromCheckpoint extends MemoryHost {
  override async getActivityRecords(request: Parameters<MemoryHost['getActivityRecords']>[0]) {
    const records = await super.getActivityRecords(request);
    const latest = this.artifacts().filter(artifact => artifact.kind === 'backup' && artifact.instance.activityId === request.activityId).at(-1);
    return latest ? { ...records, exposures: structuredClone(latest.exposures) } : records;
  }
}
/** Adopts the stage and activity revision of a re-registered instance (a host that trusts the adapter's claims). */
class AdoptsRegisteredState extends MemoryHost {
  override async registerActivity(request: Parameters<MemoryHost['registerActivity']>[0]) {
    const known = this.activity(request.instance.activityId);
    const ack = await super.registerActivity(request);
    if (known) {
      const durable = this.snapshot();
      const table = durable.activities[request.instance.activityId]!;
      table.stage = request.instance.stage.id;
      table.activityRevision = request.instance.activityRevision;
      MemoryHost.fromSnapshot(durable, { profile: 'conformant' }).restoreInto(this);
    }
    return ack;
  }
}

describe('HostPort conformance kit against sabotaged memory hosts', () => {
  const make = <T extends MemoryHost>(Kind: new (...args: ConstructorParameters<typeof MemoryHost>) => T): HostFactory => snapshot => {
    const host = new Kind({ policy: snapshot?.policy ?? policyFor('default'), profile: 'conformant' });
    if (snapshot) MemoryHost.fromSnapshot(snapshot, { profile: 'conformant' }).restoreInto(host);
    return host;
  };

  it('a host without eventId deduplication fails commit-exploration', async () => {
    const result = await run(fixture(make(NoEventDedupe)));
    expect(outcome(result, 'commit-exploration', 'duplicate-eventid-deduped')).toBe('fail');
    expect(result.result.steps['commit-exploration'].outcome).toBe('fail');
    expect(result.result.result).toBe('fail');
  }, 60_000);

  it('a host session revision the host never committed (adapter-visible self-increment) fails prediction-reference', async () => {
    const box = fixture();
    // The response hook reports expected + 1 without the host committing a response transaction.
    box.options = { ...box.options, hooks: { ...box.hooks, respond: async ({ activityId, kind, stageId, taskId }) => {
      const expected = box.host.hostSessionRevision(activityId);
      return { response: { responseId: `resp-${activityId}`, taskId, taskRevision: 1, kind, modality: 'text', stageId }, expectedHostSessionRevision: expected, hostSessionRevision: expected + 1 };
    } } };
    const result = await run(box);
    expect(outcome(result, 'prediction-reference', 'host-revision-durable')).toBe('fail');
    expect(result.result.steps['prediction-reference'].outcome).toBe('fail');
  }, 60_000);

  it('a host that acknowledges before its write is durable fails authorize-reveal', async () => {
    const result = await run(fixture(make(AcknowledgesBeforeCommit)));
    expect(outcome(result, 'authorize-reveal', 'durable-before-return')).toBe('fail');
    expect(result.result.steps['authorize-reveal'].outcome).toBe('fail');
  }, 60_000);

  it('a host whose refusals look retryable fails the refusal checks', async () => {
    const result = await run(fixture(snapshot => refusalsAsFailures(snapshot ? MemoryHost.fromSnapshot(snapshot, { profile: 'conformant' }) : new MemoryHost({ policy: policyFor('default'), profile: 'conformant' }))));
    expect(outcome(result, 'open-quadratic', 'unknown-activity-refused')).toBe('fail');
    expect(outcome(result, 'authorize-reveal', 'refusal-reported-with-convention-code')).toBe('fail');
    expect(outcome(result, 'authorize-reveal', 'refusal-not-retried')).toBe('fail');
    expect(result.result.steps['authorize-reveal'].outcome).toBe('fail');
  }, 60_000);

  it('a host whose records misreport its activity revision fails reopen-verify', async () => {
    const result = await run(fixture(make(StaleActivityState)));
    expect(outcome(result, 'reopen-verify', 'host-activity-state')).toBe('fail');
    expect(result.result.steps['reopen-verify'].outcome).toBe('fail');
  }, 60_000);

  it('a host that names another receipt as the one that moved the stage fails reopen-verify (R04)', async () => {
    const result = await run(fixture(make(LatestReceiptAsStageReceipt)));
    // Right after the stage receipt its latest receipt is the stage receipt; after the reveal and the help it is not.
    expect(outcome(result, 'authorize-reveal', 'stage-receipt-named')).toBe('pass');
    expect(outcome(result, 'reopen-verify', 'stage-receipt-kept')).toBe('fail');
    expect(result.result.steps['reopen-verify'].outcome).toBe('fail');
  }, 60_000);

  it('a host whose context lineage ignores the independent task fails independent-task (R01)', async () => {
    const result = await run(fixture(make(ContinuousLineage)));
    expect(outcome(result, 'reopen-verify', 'host-lineage-instructional')).toBe('pass');
    expect(outcome(result, 'independent-task', 'independent-lineage')).toBe('fail');
    expect(result.result.steps['independent-task'].outcome).toBe('fail');
  }, 60_000);

  it('a host whose records repeat its latest checkpoint confirms a forged grant and fails reopen-verify (R01)', async () => {
    const result = await run(fixture(make(RecordsFromCheckpoint)));
    expect(outcome(result, 'reopen-verify', 'forged-grant-not-confirmed')).toBe('fail');
    expect(result.result.steps['reopen-verify'].outcome).toBe('fail');
  }, 60_000);

  it('a host that adopts a registered instance\'s stage and revision fails reopen-verify (R01, R04)', async () => {
    const result = await run(fixture(make(AdoptsRegisteredState)));
    expect(outcome(result, 'reopen-verify', 'registration-keeps-host-state')).toBe('fail');
    expect(result.result.steps['reopen-verify'].outcome).toBe('fail');
  }, 60_000);

  it('a host that acknowledges a display it never authorized fails authorize-reveal', async () => {
    const result = await run(fixture(make(AcknowledgesUnauthorizedDisplay)));
    expect(outcome(result, 'authorize-reveal', 'display-ack-requires-authorization')).toBe('fail');
    expect(result.result.steps['authorize-reveal'].outcome).toBe('fail');
    // The other HostPort semantics of that step still pass: the failure is attributed to the right assertion.
    expect(outcome(result, 'authorize-reveal', 'intent-replay-identical')).toBe('pass');
  }, 60_000);

  it('the test-double profile (specific rejection codes) is reported as non-conformant, not silently passed', async () => {
    const result = await run(fixture(snapshot => snapshot ? MemoryHost.fromSnapshot(snapshot) : new MemoryHost({ policy: policyFor('default') })));
    expect(result.result.result).toBe('fail');
    expect(outcome(result, 'open-quadratic', 'unknown-activity-refused')).toBe('fail');
  }, 60_000);
});
