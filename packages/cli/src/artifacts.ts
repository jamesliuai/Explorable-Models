import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import { TOOLKIT_ROOT, type CompiledProject } from './compiler.js';
import { CliError, MAX_BUNDLE_BYTES, digest, ensureEmptyDestination, exists, listFiles, writeJSON } from './files.js';
import type { CheckReport } from '../../core/src/types.js';
import { copyPlaybackLicenses } from './licenses.js';

async function zipDirectory(directory: string): Promise<Uint8Array> {
  const inputs: Record<string, Uint8Array> = {}; let total = 0;
  for (const relative of await listFiles(directory)) {
    const bytes = await readFile(path.join(directory, relative)); total += bytes.byteLength;
    if (total > MAX_BUNDLE_BYTES) throw new CliError('RESOURCE_LIMIT', 'Artifact exceeds the 64 MiB export limit.');
    inputs[relative.split(path.sep).join('/')] = bytes;
  }
  return zipSync(inputs, { level: 6 });
}
export async function exportArtifact(project: CompiledProject, directory: string, report: CheckReport, zip = false): Promise<unknown> {
  if (!report.passed || report.definitionRevision !== project.definition.definitionRevision) throw new CliError('CHECK_FAILED', 'Only a candidate with passed checks for this exact definition can be exported.');
  await ensureEmptyDestination(directory);
  await cp(project.directory, directory, { recursive: true });
  const sourceDirectory = path.join(directory, 'source',project.definition.manifest.id); await mkdir(sourceDirectory,{recursive:true});
  for (const [relative, source] of Object.entries(project.source)) {
    const destination = path.join(sourceDirectory, relative); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, source);
  }
  await writeFile(path.join(sourceDirectory, 'package-lock.json'), project.dependencyLock);
  await writeFile(path.join(directory, 'model.md'), project.source['model.md']!);
  await writeJSON(path.join(directory, 'experiment.json'), project.definition.manifest);
  await writeJSON(path.join(directory, 'check-report.json'), report);
  for (const name of ['LICENSE','THIRD_PARTY_NOTICES.md']) if(await exists(path.join(TOOLKIT_ROOT,name))) await cp(path.join(TOOLKIT_ROOT,name),path.join(directory,name));
  await copyPlaybackLicenses(directory);
  await writeFile(path.join(directory, 'source.zip'), await zipDirectory(sourceDirectory));
  await writeJSON(path.join(directory,'source-manifest.json'),{schemaVersion:'1.0',experiments:{[project.definition.manifest.id]:{definitionRevision:project.definition.definitionRevision,files:Object.keys(project.source).concat('package-lock.json').map(relative=>relative.split(path.sep).join('/')),archive:'source.zip'}}});
  await writeFile(path.join(directory, 'SERVING.txt'), 'Serve this directory over HTTP (for example: npx http-server .). Open index.html. Direct file:// loading is not supported. All playback dependencies are bundled locally; no model API or external network is required. The source/ directory is editable source. check-report.json records quantitative checks, not scientific certification or learning evidence.\n');
  const assets: {path:string;sha256:string;bytes:number}[] = [];
  for (const relative of await listFiles(directory)) { const bytes = await readFile(path.join(directory, relative)); assets.push({path:relative.split(path.sep).join('/'),sha256:digest(bytes),bytes:bytes.byteLength}); }
  const manifest = { schemaVersion: '1.0', experimentId: project.definition.manifest.id, definitionRevision: project.definition.definitionRevision, runtimeVersion: '0.1.0', exportedAt: new Date().toISOString(), dependencyLockDigest: digest(project.dependencyLock), assets, capabilities: { offlineHTTPPlayback: true, fileURLPlayback: false, hostileCodeIsolation: false }, modelReview: project.definition.manifest.review ?? { status: 'unreviewed' }, learnerEvidence: 'not_evaluated' };
  await writeJSON(path.join(directory, 'bundle-manifest.json'), manifest);
  const archive = zip ? `${directory}.zip` : undefined;
  if (archive) await writeFile(archive, await zipDirectory(directory));
  return { directory, ...(archive ? { archive } : {}), definitionRevision: project.definition.definitionRevision, report: { passed: report.passed, suiteId: report.suiteId, provenance: report.provenance }, files: assets.length + 1 };
}
