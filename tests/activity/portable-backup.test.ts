/**
 * Portable host backup restored in a fresh process (report §14, A48; W11 data path). The original process runs a
 * quadratic activity through reveal, exploration, commits, navigation, a retained comparison, a camera and layout
 * change, a host response reference and a help request, then saves a backup. The host store is written to an
 * "original machine" directory; a portable bundle is exported from it; the original directory is deleted; and a fresh
 * child Node process with networking disabled imports the bundle into an EMPTY memory host store and restores the
 * checkpoint. Results are fixture-host results (memory host, inline workers), not evidence about the Study Harness host.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { conservativeExposures, type ActivityArtifact, type AudienceState, type ExposureRecord, type InteractionEvent } from '@explorable-models/activity';
import {
  MODEL, TEMPLATE, activityGuard, authorizeExploration, enterExplore, guards, harness, manifest, okOf, op, open, presentationGuard, settled, template,
} from './support/adapter-harness.js';
import type { MemoryHostSnapshot } from './support/memory-host.js';
import { PortableBackupError, exportPortableBackup, importPortableBackup, type PortableBackup } from './support/portable-backup.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHILD = 'tests/activity/support/portable-restore-child.ts';
const scratch: string[] = [];
afterAll(async () => { for (const directory of scratch) await rm(directory, { recursive: true, force: true }); });

type HostState = AudienceState & { scientific: NonNullable<AudienceState['scientific']>; exposures: ExposureRecord[] };
interface ChildReport {
  importReport: { imported: Record<string, number>; duplicates: Record<string, number> };
  content: { template: unknown; model: unknown };
  restore: { restored: string; notes: string[] };
  projection: { ui: string; position: unknown; frameKind: string | null; playing: boolean | null; presentation: { layout: string; views: Record<string, unknown> }; comparisons: string[]; stage: string };
  restored: { scientific: HostState['scientific']; instance: HostState['instance']; exposures: ExposureRecord[] };
  restoredEvents: { eventId: string; sequence: number; type: string }[];
  step: { ok: boolean; position: unknown };
  hostRecords: { exposures: { exposureId: string; receiptId: string; displayStatus: string }[]; receipts: { receiptId: string; contract: string }[]; events: number };
  reimport: { report: { imported: Record<string, number>; duplicates: Record<string, number> }; events: number; exposures: number; receipts: number; uniqueEventIds: number };
  network: string[];
  workers: { created: number; live: number };
}

async function writeBundle(directory: string, bundle: PortableBackup): Promise<void> {
  for (const [path, body] of Object.entries({ ...bundle.files, 'manifest.json': JSON.stringify(bundle.manifest, null, 2) })) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), body);
  }
}
const reader = (files: Record<string, string>) => (path: string): string | null => Object.hasOwn(files, path) ? files[path]! : null;
function withManifest(bundle: PortableBackup): Record<string, string> { return { ...bundle.files, 'manifest.json': JSON.stringify(bundle.manifest) }; }

/** Runs the supported-work scenario and saves a backup once every event is acknowledged. */
async function supportedSession() {
  const h = harness();
  const opened = await open(h);
  await enterExplore(h, opened);
  await authorizeExploration(h, opened);
  const learner = opened.learner;
  const previewId = okOf(learner.beginPreview({ operationId: op(), ...guards(learner), gesture: 'pointer', parameter: 'eta' })).preview!.previewId;
  okOf(learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 0.4 } }));
  okOf(learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 0.5 } }));
  await settled(h);
  okOf(await learner.commitPreview({ operationId: op(), ...guards(learner), previewId }));
  okOf(await learner.navigate({ operationId: op(), ...guards(learner), position: { kind: 'index', index: 3 } }));
  okOf(learner.retainComparison({ operationId: op(), ...guards(learner), label: 'Half step' }));
  okOf(await learner.commitParameters({ operationId: op(), ...guards(learner), displayValues: { eta: 0.75 } }));
  okOf(await learner.navigate({ operationId: op(), ...guards(learner), position: { kind: 'index', index: 5 } }));
  okOf(learner.setCamera({ operationId: op(), ...presentationGuard(learner), viewId: 'landscape', camera: { kind: '2d', center: [1, 10], zoom: 1.5 } }));
  okOf(learner.setLayout({ operationId: op(), ...presentationGuard(learner), layout: 'side' }));
  okOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 0, hostSessionRevision: 1, response: { responseId: 'resp-1', taskId: 'task-1', taskRevision: 1, kind: 'prediction', modality: 'text', stageId: 'predict' } }));
  okOf(await learner.requestHelp({ operationId: op(), ...activityGuard(learner) }));
  await settled(h);
  const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
  if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
  await settled(h);
  const state = h.adapter.getState('act-quadratic-1', 'host') as HostState;
  return { h, opened, artifact: saved.artifact, state, projection: learner.getProjection() };
}

describe('portable host backup into an empty store in a fresh process (A48)', () => {
  it('restores exact science, content identity, permitted presentation, exposures and the journal checkpoint offline, without duplicates on reimport', async () => {
    const { h, artifact, state, projection } = await supportedSession();
    const originalEvents: InteractionEvent[] = h.host.events('act-quadratic-1');
    const assistance = h.host.receipts('act-quadratic-1').filter(receipt => receipt.contract === 'study-harness.assistance-receipt');
    expect(assistance).toHaveLength(1);
    expect(state.exposures.map(record => record.scope).sort()).toEqual(['exploration', 'stage']);

    // The original machine: the host's durable store as files.
    const root = await mkdtemp(join(tmpdir(), 'em-portable-'));
    scratch.push(root);
    const original = join(root, 'original-machine'), bundleDirectory = join(root, 'transfer', 'bundle');
    await mkdir(original, { recursive: true });
    await writeFile(join(original, 'host-store.json'), JSON.stringify(h.host.snapshot()));
    const store = JSON.parse(await readFile(join(original, 'host-store.json'), 'utf8')) as MemoryHostSnapshot;
    const bundle = exportPortableBackup(store, { activityId: 'act-quadratic-1', checkpointArtifactId: artifact.artifactId, template, model: manifest });
    await writeBundle(bundleDirectory, bundle);
    h.adapter.dispose();
    await rm(original, { recursive: true, force: true });
    expect(existsSync(original)).toBe(false);
    for (const name of await readdir(bundleDirectory, { recursive: true })) {
      const file = join(bundleDirectory, name);
      if (name.endsWith('.json')) expect(await readFile(file, 'utf8'), name).not.toContain(root);
    }
    // The bundle holds the journal through the checkpoint, the referenced host records and the exact content.
    expect(bundle.manifest.checkpoint.lastSequence).toBe(artifact.journal.cursor.lastSequence);
    expect(bundle.manifest.journal.count).toBe(artifact.journal.cursor.lastSequence);
    expect(bundle.manifest.content.map(entry => entry.ref)).toEqual([TEMPLATE, MODEL]);

    const child = spawnSync(process.execPath, ['--import', 'tsx', CHILD, bundleDirectory], { cwd: ROOT, encoding: 'utf8', timeout: 90_000, env: { ...process.env, NODE_OPTIONS: '' } });
    expect(child.status, child.stderr).toBe(0);
    const report = JSON.parse(child.stdout) as ChildReport;

    // Networking was disabled and never attempted; nothing outside the bundle was needed.
    expect(report.network).toEqual([]);
    expect(report.content).toEqual({ template: TEMPLATE, model: MODEL });
    expect(report.importReport.duplicates).toEqual({ events: 0, exposures: 0, receipts: 0, artifacts: 0 });
    expect(report.importReport.imported.events).toBe(artifact.journal.cursor.lastSequence);
    expect(report.importReport.imported.exposures).toBe(state.exposures.length);

    // Exact scientific state, content identity, permitted presentation and journal checkpoint.
    expect(report.restore.restored).toBe('exact');
    const restored = report.restored;
    expect(restored.scientific.params).toEqual(artifact.scientific.params);
    expect(restored.scientific.position).toEqual(artifact.scientific.position);
    expect(restored.scientific.restoredFrom).toBe(artifact.scientific.runId);
    expect(restored.scientific.quantities).toEqual(state.scientific.quantities);
    expect(restored.scientific.comparisons.map(item => ({ label: item.label, params: item.params, position: item.position })))
      .toEqual(artifact.scientific.comparisons.map(item => ({ label: item.label, params: item.params, position: item.position })));
    expect(restored.instance.template).toEqual(TEMPLATE);
    expect(restored.instance.model).toEqual(MODEL);
    expect(restored.instance.stage).toEqual(artifact.instance.stage);
    expect(restored.instance.activityRevision).toBe(artifact.instance.activityRevision);
    expect(restored.instance.responses).toEqual(artifact.instance.responses);
    expect(report.projection).toMatchObject({ ui: 'restored', frameKind: 'committed', playing: false, stage: 'explore-step', comparisons: ['Half step'] });
    expect(report.projection.position).toEqual(projection.frame!.position);
    expect(report.projection.presentation.layout).toBe('side');
    expect(report.projection.presentation.views).toEqual(projection.presentation.views);
    // Exposures restore conservatively: displayed stays displayed; authorized without a display acknowledgement
    // (the exploration scope) becomes uncertain, i.e. potentially seen. Nothing is dropped.
    expect(restored.exposures.map(record => [record.exposureId, record.scope, record.displayStatus]))
      .toEqual(conservativeExposures(state.exposures).map(record => [record.exposureId, record.scope, record.displayStatus]));
    expect(restored.exposures.map(record => record.displayStatus)).toEqual(['displayed', 'uncertain']);

    // Journal: the imported events keep their identity, the restore appends exactly one event after the checkpoint.
    const checkpoint = artifact.journal.cursor.lastSequence;
    expect(report.restoredEvents.slice(0, checkpoint).map(event => event.eventId)).toEqual(originalEvents.slice(0, checkpoint).map(event => event.eventId));
    expect(report.restoredEvents.slice(checkpoint).map(event => [event.sequence, event.type])).toEqual([[checkpoint + 1, 'artifact.restored']]);
    expect(report.step).toEqual({ ok: true, position: { kind: 'index', index: 6, maxIndex: 1000 } });

    // Reimport: no duplicate events, exposure or assistance records; the restore did not re-issue receipts.
    expect(report.reimport.report.imported).toEqual({ events: 0, exposures: 0, receipts: 0, artifacts: 0 });
    expect(report.reimport.report.duplicates.events).toBe(checkpoint);
    expect(report.reimport.exposures).toBe(state.exposures.length);
    expect(report.reimport.receipts).toBe(h.host.receipts('act-quadratic-1').length);
    expect(report.reimport.uniqueEventIds).toBe(report.reimport.events);
    expect(report.hostRecords.receipts.filter(receipt => receipt.contract === 'study-harness.assistance-receipt').map(receipt => receipt.receiptId)).toEqual(assistance.map(receipt => receipt.receiptId));
    expect(report.workers.live).toBe(0);
  }, 120_000);

  it('verifies the whole bundle before importing anything: missing, altered or substituted content is refused', async () => {
    const { h, artifact } = await supportedSession();
    const bundle = exportPortableBackup(h.host.snapshot(), { activityId: 'act-quadratic-1', checkpointArtifactId: artifact.artifactId, template, model: manifest });
    h.adapter.dispose();
    const files = withManifest(bundle);
    const failure = (mutate: (files: Record<string, string>) => void): PortableBackupError => {
      const copy = { ...files };
      mutate(copy);
      try { importPortableBackup(null, reader(copy)); } catch (error) { if (error instanceof PortableBackupError) return error; throw error; }
      throw new Error('expected the import to be refused');
    };
    const templatePath = bundle.manifest.content[0]!.path, modelPath = bundle.manifest.content[1]!.path;
    expect(failure(copy => { delete copy[modelPath]; })).toMatchObject({ code: 'MISSING_FILE', path: modelPath });
    expect(failure(copy => { copy[bundle.manifest.journal.path] = copy[bundle.manifest.journal.path]!.replace('"sequence":2', '"sequence":3'); })).toMatchObject({ code: 'INTEGRITY_FAILURE', path: bundle.manifest.journal.path });
    // A similar but different template under recomputed file digests is still refused: content is addressed by digest.
    const edited = { ...template, title: `${template.title} (edited)` };
    expect(failure(copy => {
      copy[templatePath] = JSON.stringify(edited);
      const manifestValue = JSON.parse(copy['manifest.json']!) as PortableBackup['manifest'];
      const entry = manifestValue.files.find(item => item.path === templatePath)!;
      entry.sha256 = `sha256:${createHash('sha256').update(copy[templatePath]!).digest('hex')}`;
      copy['manifest.json'] = JSON.stringify(manifestValue);
    })).toMatchObject({ code: 'INTEGRITY_FAILURE', path: templatePath });
    expect(failure(copy => { copy['manifest.json'] = copy['manifest.json']!.replace('"formatVersion":"1.0"', '"formatVersion":"9.0"'); })).toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    // The intact bundle imports; the same bundle twice is idempotent.
    const first = importPortableBackup(null, reader(files));
    const again = importPortableBackup(first.store, reader(files));
    expect(again.report.imported).toEqual({ events: 0, exposures: 0, receipts: 0, artifacts: 0 });
    expect(again.store).toEqual(first.store);
  });

  it('refuses a bundle whose checkpoint artifact was altered after export', async () => {
    const { h, artifact } = await supportedSession();
    const bundle = exportPortableBackup(h.host.snapshot(), { activityId: 'act-quadratic-1', checkpointArtifactId: artifact.artifactId, template, model: manifest });
    h.adapter.dispose();
    const files = withManifest(bundle);
    const path = bundle.manifest.artifacts.find(entry => entry.artifactId === artifact.artifactId)!.path;
    const tampered = JSON.parse(files[path]!) as ActivityArtifact;
    tampered.scientific.params.eta = 1.5;
    files[path] = JSON.stringify(tampered);
    expect(() => importPortableBackup(null, reader(files))).toThrow(PortableBackupError);
  });
});
