/** Restore's deferred local implementation stays out of the eager consumer and cannot act after cancellation. */
import { build } from 'esbuild';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterDiagnostics, AdapterOptions, StudyHarnessAdapter } from '../../packages/activity/src/api';
import { backupArtifact } from '../../packages/activity/fixtures-src/exemplars';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = path.join(ROOT, 'packages/activity/src/index.ts');
const directories: string[] = [];
const adapters: StudyHarnessAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// Native ESM loads the actual split build, including its real import failure. Vitest's module runner would otherwise
// transform/resolve the generated files and conceal the browser consumer's chunk boundary.
const nativeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER }) as (url: string) => Promise<{
  createStudyHarnessAdapter: (options: AdapterOptions) => StudyHarnessAdapter;
  migrateArtifact?: (raw: unknown) => unknown;
  verifyArtifact?: (typeof import('../../packages/activity/src/artifacts'))['verifyArtifact'];
}>;

async function bundle(options: { missing?: boolean; gate?: { name: string; started: string }; synchronous?: boolean; codec?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'study-migration-loading-'));
  directories.push(directory);
  const result = await build({
    stdin: { contents: `export { createStudyHarnessAdapter${options.synchronous ? ', migrateArtifact' : ''}${options.codec ? ', verifyArtifact' : ''} } from ${JSON.stringify(ENTRY)};`, resolveDir: ROOT, loader: 'ts' },
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, metafile: true,
    outdir: directory, outExtension: { '.js': '.mjs' }, entryNames: 'entry', logLevel: 'silent',
    alias: { '@experiment-kit/core/model': path.join(ROOT, 'packages/core/src/model/index.ts'), '@experiment-kit/core': path.join(ROOT, 'packages/core/src/index.ts') },
  });
  const outputs = new Map(Object.entries(result.metafile.outputs).map(([file, details]) => [path.resolve(ROOT, file), details]));
  const entry = path.join(directory, 'entry.mjs');
  const migration = [...outputs].find(([, details]) => details.entryPoint?.endsWith('/migrations.ts'))?.[0];
  if (!options.synchronous) expect(migration, 'restore has its own emitted migration chunk').toBeDefined();
  for (const output of result.outputFiles) {
    if (options.missing && output.path === migration) continue;
    await mkdir(path.dirname(output.path), { recursive: true });
    const prefix = options.gate && output.path === migration
      ? `globalThis[${JSON.stringify(options.gate.started)}](); await globalThis[${JSON.stringify(options.gate.name)}];\n` : '';
    await writeFile(output.path, prefix + output.text);
  }
  const staticSources = new Set<string>(), seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const output = outputs.get(file);
    expect(output, `emitted dependency ${file}`).toBeDefined();
    for (const [source, input] of Object.entries(output!.inputs)) if (input.bytesInOutput > 0) staticSources.add(source);
    for (const edge of output!.imports) if (!edge.external && edge.kind !== 'dynamic-import') visit(path.resolve(ROOT, edge.path));
  };
  visit(entry);
  const restoreMigration = async () => {
    const output = result.outputFiles.find(file => file.path === migration);
    if (!output) throw new Error('No emitted migration chunk to restore');
    await writeFile(output.path, output.text);
  };
  return { module: await nativeImport(pathToFileURL(entry).href), staticSources, outputs, migration, restoreMigration };
}

function fixture(create: (options: AdapterOptions) => StudyHarnessAdapter) {
  const methods = ['getPolicy', 'registerActivity', 'requestStageTransition', 'recordExposureIntent', 'recordDisplayAck', 'recordAssistance', 'appendEvents', 'getJournalCursor', 'saveArtifact', 'getActivityRecords'];
  const calls = Object.fromEntries(methods.map(method => [method, vi.fn(() => { throw new Error('Host must not be called before artifact validation'); })]));
  const createWorker = vi.fn(() => { throw new Error('No worker before artifact validation'); });
  const adapter = create({ host: calls, catalog: { getTemplate: () => null, createWorker } } as unknown as AdapterOptions);
  adapters.push(adapter);
  const untouched = () => {
    for (const method of methods) expect(calls[method]).not.toHaveBeenCalled();
    expect(createWorker).not.toHaveBeenCalled();
    expect((adapter.getDiagnostics() as AdapterDiagnostics).activities).toEqual([]);
  };
  return { adapter, untouched };
}

describe('on-demand restore implementation', () => {
  it('excludes restore codecs from the public adapter eager closure, then strictly validates restore input without host effects', async () => {
    const built = await bundle();
    expect([...built.staticSources].filter(source => source.endsWith('/migrations.ts'))).toEqual([]);
    expect([...built.staticSources].some(source => source.endsWith('/artifact-build.ts'))).toBe(true);
    expect([...built.staticSources].filter(source => source.endsWith('/artifact-read.ts'))).toEqual([]);
    expect([...built.outputs.values()].some(output => Object.entries(output.inputs).some(([source, input]) => source.endsWith('/migrations.ts') && input.bytesInOutput > 0))).toBe(true);
    expect([...built.outputs.values()].some(output => Object.entries(output.inputs).some(([source, input]) => source.endsWith('/artifact-read.ts') && input.bytesInOutput > 0))).toBe(true);
    const { adapter, untouched } = fixture(built.module.createStudyHarnessAdapter);
    const restored = await adapter.restore({}, { operationId: 'restore-invalid', hostSessionRevision: 0 });
    expect(restored).toMatchObject({ ok: false, diagnostics: [{ code: 'UNSUPPORTED_ARTIFACT' }] });
    const corrupted = structuredClone(backupArtifact);
    corrupted.scientific.params.eta! += 0.1;
    expect(await adapter.restore(corrupted, { operationId: 'restore-corrupted', hostSessionRevision: 0 }))
      .toMatchObject({ ok: false, diagnostics: [{ code: 'INTEGRITY_FAILURE' }] });
    untouched();
  });

  it('keeps explicit public verification synchronous and checks integrity after the reader is split', async () => {
    const built = await bundle({ codec: true });
    expect([...built.staticSources].some(source => source.endsWith('/artifact-read.ts'))).toBe(true);
    const verified = built.module.verifyArtifact!(JSON.stringify(backupArtifact));
    expect(verified).not.toBeInstanceOf(Promise);
    expect(verified).toEqual({ ok: true, artifact: backupArtifact });
    const corrupted = structuredClone(backupArtifact);
    corrupted.scientific.params.eta! += 0.1;
    expect(built.module.verifyArtifact!(corrupted)).toMatchObject({ ok: false, diagnostics: [{ code: 'INTEGRITY_FAILURE' }] });
  });

  it('keeps the public migrateArtifact helper synchronous for callers that explicitly import it', async () => {
    const built = await bundle({ synchronous: true });
    expect([...built.staticSources].some(source => source.endsWith('/migrations.ts'))).toBe(true);
    const migrated = built.module.migrateArtifact!({});
    expect(migrated).not.toBeInstanceOf(Promise);
    expect(migrated).toMatchObject({ ok: false, diagnostics: [{ code: 'UNSUPPORTED_ARTIFACT' }] });
  });

  it('turns a missing local migration chunk into a recoverable command failure without exposing loader details', async () => {
    const built = await bundle({ missing: true });
    const { adapter, untouched } = fixture(built.module.createStudyHarnessAdapter);
    const result = await adapter.restore({}, { operationId: 'restore-unavailable', hostSessionRevision: 0 });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'NOT_READY', path: '$.artifact', message: 'The installed artifact migration module could not be loaded.' }] });
    if (result.ok) throw new Error('Expected a recoverable failure');
    expect(result.diagnostics[0]!.recovery).toContain('retry');
    expect(JSON.stringify(result)).not.toContain(built.migration);
    untouched();
    // The same operation can recover once the local chunk becomes available; the adapter must not cache NOT_READY.
    await built.restoreMigration();
    expect(await adapter.restore({}, { operationId: 'restore-unavailable', hostSessionRevision: 0 }))
      .toMatchObject({ ok: false, diagnostics: [{ code: 'UNSUPPORTED_ARTIFACT' }] });
    untouched();
  });

  for (const action of ['dispose', 'abort'] as const) it(`rechecks ${action} after a delayed migration import before any artifact or host work`, async () => {
    const name = `__study_migration_gate_${action}`, startedName = `${name}_started`;
    let release!: () => void, notify!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { notify = resolve; });
    const globals = globalThis as unknown as Record<string, unknown>;
    globals[name] = gate;
    globals[startedName] = notify;
    try {
      const built = await bundle({ gate: { name, started: startedName } });
      const { adapter, untouched } = fixture(built.module.createStudyHarnessAdapter);
      const controller = new AbortController();
      const pending = adapter.restore({}, { operationId: `restore-${action}`, hostSessionRevision: 0 }, controller.signal);
      await started;
      untouched();
      if (action === 'dispose') adapter.dispose(); else controller.abort();
      release();
      const result = await pending;
      expect(result).toMatchObject({ ok: false, diagnostics: [{ code: action === 'dispose' ? 'DISPOSED' : 'CANCELLED' }] });
      untouched();
    } finally { release(); delete globals[name]; delete globals[startedName]; }
  });
});
