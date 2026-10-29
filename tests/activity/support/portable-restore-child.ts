/**
 * TEST-ONLY child process for tests/activity/portable-backup.test.ts (report §14, A48). A fresh Node process whose
 * network APIs are replaced by throwing stubs imports a portable host backup into an EMPTY memory host store, restores
 * the checkpoint artifact through a new adapter over the bundle's content-addressed template and model (kernels are
 * installed code, run by in-process inline workers), continues the activity by one step, imports the same bundle a
 * second time, and prints one JSON report on stdout. It reads nothing but the bundle directory given as argument.
 *
 * Usage (cwd = repository root, so tsconfig paths resolve to source):
 *   node --import tsx tests/activity/support/portable-restore-child.ts <bundle-dir>
 */
import dns from 'node:dns';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';

// ---- network disabled before any toolkit module is loaded ------------------------------------------------------
const attempts: string[] = [];
const refuse = (name: string) => (..._args: unknown[]): never => { attempts.push(name); throw new Error(`Network access is disabled in this restore (${name}).`); };
const blockedClass = (name: string) => class { constructor() { attempts.push(name); throw new Error(`Network access is disabled in this restore (${name}).`); } };
const scope = globalThis as Record<string, unknown>;
scope.fetch = refuse('fetch');
scope.WebSocket = blockedClass('WebSocket');
for (const name of ['XMLHttpRequest', 'EventSource']) scope[name] = blockedClass(name);
Object.assign(net, { connect: refuse('net.connect'), createConnection: refuse('net.createConnection') });
net.Socket.prototype.connect = refuse('net.Socket.connect') as never;
Object.assign(http, { request: refuse('http.request'), get: refuse('http.get') });
Object.assign(https, { request: refuse('https.request'), get: refuse('https.get') });
Object.assign(tls, { connect: refuse('tls.connect') });
Object.assign(dns, { lookup: refuse('dns.lookup'), resolve: refuse('dns.resolve') });
Object.assign(dns.promises, { lookup: refuse('dns.promises.lookup'), resolve: refuse('dns.promises.resolve') });

const directory = process.argv[2];
if (!directory) throw new Error('Usage: portable-restore-child.ts <bundle-dir>');
const read = (path: string): string | null => { const file = join(directory, path); return existsSync(file) ? readFileSync(file, 'utf8') : null; };

const { importPortableBackup, bundleCatalog } = await import('./portable-backup.js');
const { MemoryHost } = await import('./memory-host.js');
const { inlineWorkers, until } = await import('../../core/support/inline-worker.js');
const { createStudyHarnessAdapter } = await import('@explorable-models/activity');
const { createInstalledCatalog, INSTALLED_KERNELS } = await import('@explorable-models/catalog');

const imported = importPortableBackup(null, read);
const activityId = imported.checkpoint.instance.activityId;
const host = MemoryHost.fromSnapshot(imported.store);
const workers = inlineWorkers(INSTALLED_KERNELS);
const installed = createInstalledCatalog({ workerFactory: workers.factory });
const catalog = bundleCatalog(imported.content, ref => installed.status(ref), workers.factory);
const adapter = createStudyHarnessAdapter({ catalog, host });
const checkpointPath = JSON.parse(read('manifest.json')!).artifacts.find((entry: { artifactId: string }) => entry.artifactId === imported.checkpoint.artifactId).path as string;
const eventsBefore = host.events(activityId).length;
const result = await adapter.restore(read(checkpointPath)!, { operationId: 'portable-restore-1', hostSessionRevision: imported.checkpoint.instance.hostSessionRevision });
if (!result.ok) throw new Error(`restore failed: ${JSON.stringify(result.diagnostics)}`);
await until(() => host.events(activityId).length > eventsBefore, 5000);
const learner = result.prepared.binding('learner', 'restored-surface');
learner.registerSurface('restored-surface');
const projection = learner.getProjection();
const state = adapter.getState(activityId, 'host');
if (!('scientific' in state)) throw new Error('host state unavailable');
const restoredState = { scientific: state.scientific, instance: state.instance, exposures: state.exposures };
const restoredEvents = host.events(activityId).map(event => ({ eventId: event.eventId, sequence: event.sequence, type: event.type }));

// The restored activity continues offline under fresh guards.
const stepped = await learner.step({ operationId: 'portable-step-1', ...learner.getProjection().guards, delta: 1 });
await until(() => host.events(activityId).length > restoredEvents.length, 5000);
const afterStep = adapter.getState(activityId, 'host');

// Importing the same bundle again adds nothing: every record is identified by its own ID.
const reimport = importPortableBackup(host.snapshot(), read);
const table = reimport.store.activities[activityId]!;
adapter.dispose();
const report = {
  importReport: imported.report,
  content: { template: imported.content.templateRef, model: imported.content.modelRef },
  restore: result.report,
  projection: { ui: projection.status.ui, position: projection.frame?.position ?? null, frameKind: projection.frame?.kind ?? null, playing: projection.navigation?.playing ?? null, presentation: projection.presentation, comparisons: projection.comparisons.map(item => item.label), stage: projection.stage.id },
  restored: restoredState,
  restoredEvents,
  step: { ok: stepped.ok, position: 'scientific' in afterStep ? afterStep.scientific?.position ?? null : null },
  hostRecords: {
    exposures: host.exposures(activityId).map(record => ({ exposureId: record.exposureId, receiptId: record.receiptId, displayStatus: record.displayStatus })),
    receipts: host.receipts(activityId).map(receipt => ({ receiptId: receipt.receiptId, contract: receipt.contract })),
    events: host.events(activityId).length,
  },
  reimport: { report: reimport.report, events: table.events.length, exposures: table.exposures.length, receipts: table.receipts.length, uniqueEventIds: new Set(table.events.map(event => event.eventId)).size },
  network: attempts,
  workers: { created: workers.workers.length, live: workers.live },
};
process.stdout.write(JSON.stringify(report), () => process.exit(0));
