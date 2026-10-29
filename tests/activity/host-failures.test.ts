/**
 * Host failure integration (report §7.2, §14; A16, A49, A43): atomic and interrupted saves, a full host store,
 * corrupted payloads, missing content, partial migration, backup restore after a host restart, queue overflow and
 * stale callbacks after disposal. Every failure is recoverable or explicitly refused with a recovery path; evidence is
 * never dropped silently and no model is substituted. Results use the memory host double and inline workers; they are
 * fixture-host results, not evidence about the Study Harness host's storage.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTRACTS, DRAFT_0_9, DRAFT_0_9_TO_1_0, commandCapacity, createMigrationRegistry, createStudyHarnessAdapter, draft09Integrity, migrateArtifact, systemReserve,
  type ActivityArtifact, type HostPort, type InteractionEvent, type LearnerProjection, type MigrationStep,
} from '@experiment-kit/activity';
import {
  ackCurrent, activityGuard, codesOf, enterExplore, guards, harness, manifest, okOf, op, open, policyFor, settled, template, until, type Harness, type Opened,
} from './support/adapter-harness.js';
import { MemoryHost } from './support/memory-host.js';
import { PortableBackupError, exportPortableBackup, importPortableBackup } from './support/portable-backup.js';

let disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
const make = (...args: Parameters<typeof harness>): Harness => { const h = harness(...args); disposers.push(() => h.adapter.dispose()); return h; };
const ACTIVITY = 'act-quadratic-1';
const restoreInput = () => ({ operationId: op('restore'), hostSessionRevision: 0 });
const committedEta = (opened: Opened): number => opened.learner.getProjection().controls.find(control => control.parameter === 'eta')!.value;

/** Host port whose store can be "full": saves and journal appends then fail with a storage quota error before commit. */
function quotaPort(host: MemoryHost) {
  const state = { full: false, refused: 0 };
  const quota = () => { state.refused++; return Promise.reject(new DOMException('The host store is full.', 'QuotaExceededError')); };
  const port: HostPort = {
    getPolicy: request => host.getPolicy(request), registerActivity: request => host.registerActivity(request), requestStageTransition: request => host.requestStageTransition(request),
    recordExposureIntent: request => host.recordExposureIntent(request), recordDisplayAck: request => host.recordDisplayAck(request), recordAssistance: request => host.recordAssistance(request),
    getJournalCursor: request => host.getJournalCursor(request),
    appendEvents: request => state.full ? quota() : host.appendEvents(request),
    saveArtifact: request => state.full ? quota() : host.saveArtifact(request),
  };
  return { port, state };
}

describe('saves are atomic and retryable (A49)', () => {
  it('a save that fails before the host commit stores nothing; the same operation then succeeds exactly once', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    h.host.failNext('saveArtifact', 'throw');
    const operationId = op('save');
    const failed = await opened.control.save({ operationId, kind: 'backup' });
    expect(codesOf(failed)).toEqual(['PERSISTENCE_FAILED']);
    expect(failed.ok ? '' : failed.diagnostics[0]!.recovery).toMatch(/same operation ID/);
    expect(h.host.artifacts()).toEqual([]);
    // The activity is unaffected and keeps working.
    okOf(opened.learner.pause({ operationId: op(), ...guards(opened.learner) }));
    const saved = await opened.control.save({ operationId, kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    await settled(h);
    expect(h.host.artifacts().map(item => item.artifactId)).toEqual([saved.artifact.artifactId]);
    const types = h.host.events(ACTIVITY).map(event => event.type);
    expect(types.filter(type => type === 'operation.failed')).toHaveLength(1);
    expect(types.filter(type => type === 'artifact.saved')).toHaveLength(1);
  });

  it('a save the host committed before the reply was lost is retried under the same identity and never duplicated', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    h.host.failNext('saveArtifact', 'disconnect-after-commit');
    const operationId = op('save');
    expect(codesOf(await opened.control.save({ operationId, kind: 'backup' }))).toEqual(['PERSISTENCE_FAILED']);
    const committed = h.host.artifacts();
    expect(committed).toHaveLength(1);
    await settled(h);
    const retried = await opened.control.save({ operationId, kind: 'backup' });
    if (!retried.ok) throw new Error(JSON.stringify(retried.diagnostics));
    expect(retried.artifact).toEqual(committed[0]);
    await settled(h);
    expect(h.host.artifacts()).toHaveLength(1);
    expect(h.host.events(ACTIVITY).filter(event => event.type === 'artifact.saved').map(event => event.payload.artifactId)).toEqual([committed[0]!.artifactId]);
  });

  it('a full host store refuses saves and journal writes without half-writing; evidence is kept and flushed after space is freed', async () => {
    const host = new MemoryHost({ policy: policyFor() });
    const quota = quotaPort(host);
    const h = make({ host, port: () => quota.port });
    const opened = await open(h);
    await enterExplore(h, opened);
    const journaled = host.events(ACTIVITY).length;
    quota.state.full = true;
    const save = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    expect(codesOf(save)).toEqual(['PERSISTENCE_FAILED']);
    expect(host.artifacts()).toEqual([]);
    // Commits are accepted locally and held as unacknowledged evidence; the learner sees the pending state.
    for (const eta of [0.5, 0.75]) okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta } }));
    await until(() => opened.learner.getProjection().status.persistence === 'pending-recovery');
    expect(host.events(ACTIVITY)).toHaveLength(journaled);
    // A step that needs a flushed journal is refused as pending, not taken.
    expect(codesOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-curvature' }))).toEqual(['PERSISTENCE_PENDING']);
    expect(opened.learner.getProjection().stage.id).toBe('explore-step');
    quota.state.full = false;
    okOf(await opened.learner.retryPersistence({ operationId: op() }));
    await settled(h);
    const events = host.events(ACTIVITY);
    events.forEach((event, index) => expect(event.sequence).toBe(index + 1));
    expect(events.filter(event => event.type === 'parameters.committed').map(event => (event.payload.params as Record<string, number>).eta)).toEqual([0.25, 0.5, 0.75]);
    expect(events.filter(event => event.type === 'operation.failed')).toHaveLength(1);
    expect(opened.learner.getProjection().status.persistence).toBe('saved');
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    expect(saved.ok).toBe(true);
    expect(quota.state.refused).toBeGreaterThanOrEqual(2);
  });
});

describe('queue overflow never drops evidence (A16)', () => {
  // R12: every learner command that journals evidence is refused at the command capacity before it changes anything,
  // so the reserve above it stays for events recorded without a command and no command loses its own evidence.
  it('refuses every evidence-bearing learner command at the command capacity without side effects', async () => {
    const h = make({ adapter: { outboxLimit: 16 } });
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.control.requestExplorationScope({ operationId: op('scope'), ...activityGuard(opened.learner), groups: ['step-control', 'trace', 'observations'], parameterDomain: { eta: [0, 2] } }));
    okOf(opened.learner.retainComparison({ operationId: op(), ...guards(opened.learner), label: 'Kept' }));
    await settled(h);
    h.host.failNext('appendEvents', 'throw', { times: 1000 });
    const pending = () => (h.adapter.getDiagnostics(ACTIVITY) as { activities: { outbox: { pending: number } }[] }).activities[0]!.outbox.pending;
    for (let i = 0; pending() < commandCapacity(16); i++) okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: Number((0.1 + (i % 9) * 0.1).toFixed(1)) } }));
    expect(pending()).toBe(commandCapacity(16));
    const before = opened.learner.getProjection();
    const runId = before.guards.expectedRunId!;
    const keptRun = before.comparisons[0]!.runId;
    const outcomes: [string, { ok: boolean; diagnostics?: { code: string }[] }][] = [
      ['retainComparison', opened.learner.retainComparison({ operationId: op(), ...guards(opened.learner), label: 'Another' })],
      ['removeComparison', opened.learner.removeComparison({ operationId: op(), ...guards(opened.learner), runId: keptRun })],
      ['commitParameters', await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.75 } })],
      ['resetExperiment', await opened.learner.resetExperiment({ operationId: op(), ...guards(opened.learner) })],
      ['navigate', await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 3 } })],
      ['step', await opened.learner.step({ operationId: op(), ...guards(opened.learner), delta: 1 })],
      ['restartPlayback', await opened.learner.restartPlayback({ operationId: op(), ...guards(opened.learner) })],
      ['play', opened.learner.play({ operationId: op(), ...guards(opened.learner) })],
      ['beginPreview', opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' })],
    ];
    for (const [name, outcome] of outcomes) expect([name, codesOf(outcome)]).toEqual([name, ['PERSISTENCE_BACKPRESSURE']]);
    const after = opened.learner.getProjection();
    expect(after.guards.expectedRunId).toBe(runId);
    expect(after.comparisons.map(item => item.runId)).toEqual([keptRun]);
    expect(after.frame?.position).toEqual(before.frame?.position);
    expect(after.preview).toBeNull();
    expect(after.navigation?.playing).toBe(false);
    expect(pending()).toBe(commandCapacity(16));
    // Nothing was lost: every accepted command's evidence is still in the outbox, and no loss is recorded.
    const summary = h.adapter.summarizeInteraction(ACTIVITY, { audience: 'host' }) as { limitations: string[] };
    expect(summary.limitations.join(' ')).not.toMatch(/could not be recorded/);
  });

  it('refuses evidence-bearing commands at the bound, keeps every accepted event and delivers them in order once the host recovers', async () => {
    const host = new MemoryHost({ policy: policyFor() });
    const quota = quotaPort(host);
    const h = make({ host, port: () => quota.port, adapter: { outboxLimit: 6 } });
    const opened = await open(h);
    await enterExplore(h, opened);
    const base = host.events(ACTIVITY).length;
    quota.state.full = true;
    const accepted: number[] = [], refused: number[] = [];
    for (let step = 1; step <= 12; step++) {
      const eta = Number((0.1 * step).toFixed(1));
      const outcome = await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta } });
      if (outcome.ok) accepted.push(eta);
      else { expect(codesOf(outcome)).toEqual(['PERSISTENCE_BACKPRESSURE']); refused.push(eta); }
    }
    // Commands stop at the command capacity; the reserve above it is kept for events recorded without a command.
    expect(systemReserve(6)).toBe(2);
    expect(accepted).toHaveLength(commandCapacity(6));
    expect(refused).toHaveLength(12 - commandCapacity(6));
    // A refused step did not happen: the committed experiment is the last accepted one.
    expect(committedEta(opened)).toBe(accepted.at(-1));
    expect(opened.learner.getProjection().status.persistence).toBe('pending-recovery');
    // Viewing continues read-only (presentation-only changes are bounded separately and never displace evidence).
    expect(opened.learner.describeCurrentValues()).toBeTruthy();
    quota.state.full = false;
    okOf(await opened.learner.retryPersistence({ operationId: op() }));
    await settled(h);
    const committed = host.events(ACTIVITY).slice(base).filter(event => event.type === 'parameters.committed').map(event => (event.payload.params as Record<string, number>).eta);
    expect(committed).toEqual(accepted);
    host.events(ACTIVITY).forEach((event, index) => expect(event.sequence).toBe(index + 1));
    const summary = h.adapter.summarizeInteraction(ACTIVITY, { audience: 'host' });
    expect('complete' in summary && summary.complete).toBe(true);
  });
});

describe('events recorded without a command are never lost silently (A16, G01)', () => {
  /** Quadratic card in explore-step whose host store is then full, with commands filling the outbox to its capacity. */
  async function fullOutbox(options: { ack?: boolean } = {}) {
    const host = new MemoryHost({ policy: policyFor() });
    const quota = quotaPort(host);
    const h = make({ host, port: () => quota.port, adapter: { outboxLimit: 6 } });
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await settled(h);
    if (options.ack !== false) { ackCurrent(opened.learner); await settled(h); }
    const base = host.events(ACTIVITY).length;
    quota.state.full = true;
    let accepted = 0;
    for (let step = 1; step <= 10; step++) {
      const outcome = await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: Number((0.1 * step).toFixed(1)) } });
      if (!outcome.ok) { expect(codesOf(outcome)).toEqual(['PERSISTENCE_BACKPRESSURE']); break; }
      accepted++;
    }
    expect(accepted).toBe(commandCapacity(6));
    return { host, quota, h, opened, base };
  }
  const hide = (opened: Opened, visible: boolean) => opened.learner.reportVisibility({ surfaceId: opened.surface, visible });

  it('a suspension and its resumption use the reserve of a full outbox and reach the host journal once it recovers', async () => {
    const { host, quota, h, opened, base } = await fullOutbox();
    hide(opened, false);
    hide(opened, true);
    quota.state.full = false;
    okOf(await opened.learner.retryPersistence({ operationId: op() }));
    await settled(h);
    const types = host.events(ACTIVITY).slice(base).map(event => event.type);
    expect(types.filter(type => type === 'parameters.committed')).toHaveLength(commandCapacity(6));
    expect(types.slice(-2)).toEqual(['activity.suspended', 'activity.resumed']);
    expect(types).not.toContain('operation.failed');
    host.events(ACTIVITY).forEach((event, index) => expect(event.sequence).toBe(index + 1));
    const summary = h.adapter.summarizeInteraction(ACTIVITY, { audience: 'host' });
    expect('complete' in summary && summary.complete).toBe(true);
  });

  it('a display acknowledgement at a full outbox journals reveal.displayed from the reserve', async () => {
    const { host, quota, h, opened, base } = await fullOutbox({ ack: false });
    ackCurrent(opened.learner);
    await settled(h);
    quota.state.full = false;
    okOf(await opened.learner.retryPersistence({ operationId: op() }));
    await settled(h);
    const events = host.events(ACTIVITY);
    expect(events.slice(base).map(event => event.type).at(-1)).toBe('reveal.displayed');
    expect(host.exposures(ACTIVITY)).toEqual([expect.objectContaining({ displayStatus: 'displayed' })]);
    events.forEach((event, index) => expect(event.sequence).toBe(index + 1));
  });

  it('events beyond the reserve are counted, recorded in the journal and reported as incomplete; retrying persistence never clears the loss', async () => {
    const { host, quota, h, opened, base } = await fullOutbox();
    // Three hide/show pairs: the reserve holds the first pair; the other four events cannot be accepted.
    for (let index = 0; index < 3; index++) { hide(opened, false); hide(opened, true); }
    await settled(h);
    expect(opened.learner.getProjection().status.ui).toMatch(/awaiting-persistence|recoverable-failure/);
    quota.state.full = false;
    okOf(await opened.learner.retryPersistence({ operationId: op() }));
    await settled(h);
    const events = host.events(ACTIVITY);
    events.forEach((event, index) => expect(event.sequence).toBe(index + 1));
    const types = events.slice(base).map(event => event.type);
    expect(types.filter(type => type === 'activity.suspended')).toHaveLength(1);
    expect(types.filter(type => type === 'activity.resumed')).toHaveLength(1);
    // The loss itself is journaled as the next event once there is room.
    const marker = events.find(event => event.type === 'operation.failed')!;
    expect(marker.payload).toMatchObject({ operation: 'appendEvents', code: 'PERSISTENCE_BACKPRESSURE', recoverable: false, lost: { count: 4, types: ['activity.suspended', 'activity.resumed'] } });
    expect((marker.payload.lost as { afterSequence: number }).afterSequence).toBe(base + commandCapacity(6) + 2);
    // A further retry does not clear it: the summary stays incomplete and names the lost events.
    okOf(await opened.learner.retryPersistence({ operationId: op() }));
    await settled(h);
    const summary = h.adapter.summarizeInteraction(ACTIVITY, { audience: 'host' });
    if (!('complete' in summary)) throw new Error(JSON.stringify(summary));
    expect(summary.complete).toBe(false);
    expect(summary.limitations.join(' ')).toMatch(/4 events \(activity\.suspended, activity\.resumed\) after event \d+ could not be recorded in the journal/);
    expect(opened.learner.getProjection().status.ui).not.toBe('recoverable-failure');
    // Every later backup carries the loss record.
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    expect(saved.artifact.journal.lost).toMatchObject({ count: 4, types: ['activity.suspended', 'activity.resumed'] });
  });
});

describe('corruption, missing content, partial migration and backup restore (A49)', () => {
  async function savedBackup(h: Harness, opened: Opened): Promise<ActivityArtifact> {
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    await settled(h);
    return saved.artifact;
  }

  it('refuses a corrupted stored payload before opening anything and restores from an intact copy', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } }));
    const artifact = await savedBackup(h, opened);
    h.adapter.dispose(ACTIVITY);
    const bytes = new TextEncoder().encode(JSON.stringify(artifact));
    const flipped = bytes.slice();
    const at = new TextDecoder().decode(bytes).indexOf('"eta":0.5') + 7;
    flipped[at] = '7'.charCodeAt(0);
    const registrations = h.host.calls('registerActivity').length;
    const corrupted = await h.adapter.restore(flipped, restoreInput());
    expect(codesOf(corrupted)).toContain('INTEGRITY_FAILURE');
    expect(corrupted.ok ? '' : corrupted.diagnostics[0]!.recovery).toMatch(/another copy|original bytes/);
    expect(h.host.calls('registerActivity')).toHaveLength(registrations);
    const half = await h.adapter.restore(bytes.slice(0, bytes.length >> 1), restoreInput());
    expect(codesOf(half)).toEqual(['INTEGRITY_FAILURE']);
    const intact = await h.adapter.restore(bytes, restoreInput());
    if (!intact.ok) throw new Error(JSON.stringify(intact.diagnostics));
    expect(intact.report.restored).toBe('exact');
    expect(committedEta({ ...opened, learner: intact.prepared.binding('learner', 's2') })).toBe(0.5);
  });

  it('refuses missing content with a read-only recovery and never substitutes a similar model', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const artifact = await savedBackup(h, opened);
    h.adapter.dispose(ACTIVITY);
    // The model is missing from the installed content; a similar installed model of another ID exists.
    const missing = createStudyHarnessAdapter({ catalog: { ...h.catalog, getModel: ref => ref.modelId === manifest.modelId ? null : h.catalog.getModel(ref) }, host: h.host });
    disposers.push(() => missing.dispose());
    const refused = await missing.restore(artifact, restoreInput());
    expect(codesOf(refused)).toEqual(['UNSUPPORTED_ARTIFACT']);
    expect(refused.ok ? '' : refused.diagnostics[0]!.recovery).toMatch(/read-only|No other model/);
    expect('diagnostics' in missing.getState(ACTIVITY, 'host')).toBe(true);
    // An integrity manifest that references absent content is a missing blob, reported as such.
    const { scientific: _scientific, ...withoutScientific } = artifact;
    const blob = await h.adapter.restore(withoutScientific, restoreInput());
    expect(codesOf(blob)).toEqual(['INTEGRITY_FAILURE']);
    expect(blob.ok ? '' : blob.diagnostics[0]!.recovery).toMatch(/portable backup|content store/);
    // A portable bundle that lacks a content blob imports nothing.
    const bundle = exportPortableBackup(h.host.snapshot(), { activityId: ACTIVITY, checkpointArtifactId: artifact.artifactId, template, model: manifest });
    const files: Record<string, string> = { ...bundle.files, 'manifest.json': JSON.stringify(bundle.manifest) };
    delete files[bundle.manifest.content[1]!.path];
    const empty = h.host.snapshot();
    expect(() => importPortableBackup(empty, path => files[path] ?? null)).toThrow(PortableBackupError);
    expect(h.host.snapshot()).toEqual(empty);
  });

  it('migrates a draft 0.9 backup explicitly, refuses partial or failing migrations and keeps the original bytes', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const artifact = await savedBackup(h, opened);
    h.adapter.dispose(ACTIVITY);
    // The 0.9 draft of this backup (inverse of the documented format mapping).
    const { exposures, pending: _pending, integrity: _integrity, migratedFrom: _migrated, ...rest } = structuredClone(artifact);
    const body: Record<string, unknown> = {
      ...rest, schemaVersion: DRAFT_0_9.version, reveals: exposures,
      schemas: rest.schemas.map(entry => entry.contract === CONTRACTS.artifact ? { ...entry, version: DRAFT_0_9.version } : entry),
    };
    const draft = { ...body, integrity: draft09Integrity(body) };
    const text = JSON.stringify(draft);
    // Partial bytes and a broken source record are refused without conversion.
    expect(codesOf(await h.adapter.restore(text.slice(0, Math.floor(text.length * 0.6)), restoreInput()))).toEqual(['INTEGRITY_FAILURE']);
    const broken = structuredClone(draft) as Record<string, unknown>;
    delete broken.reveals;
    expect(codesOf(await h.adapter.restore(broken, restoreInput()))).toContain('INTEGRITY_FAILURE');
    // A chain whose second step fails leaves no partial result and does not touch the original.
    const before = JSON.stringify(draft);
    const failing: MigrationStep = { from: { contract: CONTRACTS.artifact, version: '0.8' }, to: DRAFT_0_9, verify: () => [], migrate: value => ({ value: { ...value, schemaVersion: '0.9' }, report: ['step 1'], semanticsChanged: false }) };
    const throwing: MigrationStep = { ...DRAFT_0_9_TO_1_0, migrate: () => { throw new Error('interrupted'); } };
    const registry = createMigrationRegistry([failing, throwing]);
    const partial = migrateArtifact({ ...draft, schemaVersion: '0.8' }, { registry });
    expect(partial.ok).toBe(false);
    expect(partial.ok ? [] : partial.diagnostics.map(item => item.code)).toContain('UNSUPPORTED_ARTIFACT');
    expect(JSON.stringify(draft)).toBe(before);
    // The complete draft migrates (format only), restores exactly and records its provenance.
    const restored = await h.adapter.restore(text, restoreInput());
    if (!restored.ok) throw new Error(JSON.stringify(restored.diagnostics));
    expect(restored.report.restored).toBe('exact');
    expect(restored.report.notes.join(' ')).toMatch(/Format: the draft field "reveals" is now "exposures"/);
    // The draft format had no assistance list: the restore says so instead of implying that no assistance happened.
    expect(restored.report.notes.join(' ')).toMatch(/lists no assistance receipts because its original format had no such list/);
    await settled(h);
    const event = h.host.events(ACTIVITY).at(-1)!;
    expect(event.type).toBe('artifact.restored');
    expect(event.payload.migratedFrom).toEqual({ contract: CONTRACTS.artifact, version: '0.9' });
  });

  it('restores the latest backup after a host restart; the host journal keeps events recorded after the checkpoint', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const artifact = await savedBackup(h, opened);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 1.25 } }));
    await settled(h);
    const journal = h.host.events(ACTIVITY);
    h.adapter.dispose();
    const restarted = h.host.restoreInto(new MemoryHost({ policy: h.host.policy() }));
    const adapter = createStudyHarnessAdapter({ catalog: h.catalog, host: restarted });
    disposers.push(() => adapter.dispose());
    const restored = await adapter.restore(artifact, restoreInput());
    if (!restored.ok) throw new Error(JSON.stringify(restored.diagnostics));
    await until(() => restarted.events(ACTIVITY).length > journal.length);
    const after = restarted.events(ACTIVITY);
    expect(after.slice(0, journal.length)).toEqual(journal);
    expect(after.slice(journal.length).map(event => event.type)).toEqual(['artifact.restored']);
    expect(after.at(-1)!.sequence).toBe(journal.length + 1);
    // The restored experiment is the checkpoint; nothing from after it was silently applied or erased from the host.
    const projection = restored.prepared.binding('learner', 'r').getProjection();
    expect(projection.controls.find(control => control.parameter === 'eta')!.value).toBe(artifact.scientific.params.eta);
    expect(restarted.exposures(ACTIVITY)).toEqual(h.host.exposures(ACTIVITY));
  });
});

describe('stale callbacks after dispose (A43, A49)', () => {
  it('disposal during save, reveal and evaluation resolves DISPOSED; no listener, display acknowledgement or journal write follows', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    let notified = 0;
    opened.learner.subscribe(() => notified++);
    h.host.delay('saveArtifact', 20).delay('requestStageTransition', 20);
    h.workers.hold = true;
    const save = opened.control.save({ operationId: op('save'), kind: 'backup' });
    const reveal = opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-step' });
    await new Promise(resolve => setTimeout(resolve, 2));
    const eventsAtDispose = h.host.events(ACTIVITY).length;
    const calls = h.host.calls().length;
    const projection: LearnerProjection = opened.learner.getProjection();
    h.adapter.dispose(ACTIVITY);
    notified = 0;
    h.workers.hold = false;
    h.workers.flush();
    const outcomes = await Promise.all([save, reveal]);
    for (const outcome of outcomes) expect(codesOf(outcome)).toEqual(['DISPOSED']);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(notified).toBe(0);
    expect(h.host.calls('recordDisplayAck')).toEqual([]);
    expect(h.host.events(ACTIVITY).length).toBe(eventsAtDispose);
    // Only the calls already in flight completed at the host; nothing new was issued after disposal.
    expect(h.host.calls().slice(calls).map(call => call.method)).toEqual([]);
    expect(opened.learner.getProjection().projectionId).not.toBe(projection.projectionId);
    expect(opened.learner.getProjection().status.ui).toBe('disposed');
    expect(h.workers.live).toBe(0);
    const late: InteractionEvent[] = h.host.events(ACTIVITY).filter(event => event.type === 'artifact.saved' || event.type === 'stage.changed');
    expect(late).toEqual([]);
  });
});
