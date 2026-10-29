import { build as esbuild, type Plugin } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { RUNTIME_VERSION, definitionRevision, validateManifest, validateViews } from '../../core/src/index.js';
import type { ExperimentDefinition, Manifest, ViewDefinition } from '../../core/src/types.js';
import { CliError, canonical, digest, exists, inside, listFiles, readSource, readBounded, writeJSON } from './files.js';

export const TOOLKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CORE_ENTRY = path.join(TOOLKIT_ROOT, 'packages/core/src/index.ts');
export async function readDependencyLock(): Promise<string> {
  const shrinkwrap=path.join(TOOLKIT_ROOT,'npm-shrinkwrap.json');
  return readBounded(await exists(shrinkwrap)?shrinkwrap:path.join(TOOLKIT_ROOT,'package-lock.json'),8*1024*1024);
}
/** Shared by gallery and candidate builds so identical source/runtime restores identically. */
export async function getRuntimeIdentity(): Promise<string> {
  const sources: Record<string,string> = {};
  for (const name of ['core','player']) {
    const root = path.join(TOOLKIT_ROOT,'packages',name,'src');
    for (const relative of await listFiles(root)) if(/\.(?:ts|tsx|css)$/.test(relative)) sources[`${name}/${relative.split(path.sep).join('/')}`] = await readBounded(path.join(root,relative));
  }
  return digest(canonical(sources));
}
export interface CompiledProject {
  directory: string;
  sourceDirectory: string;
  source: Record<string, string>;
  definition: ExperimentDefinition;
  dependencyLock: string;
  dispose(): Promise<void>;
}
/** Fixed build surface. Resolves only local source and the trusted core entry. No candidate configuration or package hooks. */
export function modelImportPolicy(sourceDirectory: string, extraSource: Record<string, string>): Plugin {
  const candidateRoot = path.resolve(sourceDirectory);
  const coreRoot = path.join(TOOLKIT_ROOT, 'packages/core/src');
  return {
    name: 'explorable-models-import-policy',
    setup(build) {
      build.onLoad({ filter: /\.(?:ts|json)$/ }, async args => {
        if (!args.path.startsWith(candidateRoot + path.sep)) return undefined;
        const text = await readBounded(args.path);
        if (args.path.endsWith('.json')) return { contents: text, loader: 'json' };
        const source = ts.createSourceFile(args.path, text, ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new CliError('INVALID_IMPORT', 'Dynamic imports are not supported in experiment models. Use a relative static import.');
          ts.forEachChild(node, visit);
        };
        visit(source);
        return { contents: text, loader: 'ts', resolveDir: path.dirname(args.path) };
      });
      build.onResolve({ filter: /.*/ }, async args => {
        if (args.path === '@explorable-models/core') return { path: CORE_ENTRY };
        if (args.path === 'kit:model') return { path: path.join(candidateRoot, 'model.ts') };
        if (args.path === 'kit:checks') return { path: path.join(candidateRoot, 'checks.ts') };
        if (args.importer.startsWith(coreRoot + path.sep)) return undefined;
        if (!args.path.startsWith('.')) throw new CliError('INVALID_IMPORT', `Model imports must be relative TypeScript/JSON files or @explorable-models/core: ${args.path}`);
        const base = path.resolve(args.resolveDir, args.path);
        const alternatives = [base, `${base}.ts`, `${base}.json`, base.replace(/\.js$/, '.ts')];
        let resolved: string | undefined;
        for (const alternative of alternatives) if (await exists(alternative)) { resolved = await inside(candidateRoot, alternative); break; }
        if (!resolved || !/\.(ts|json)$/.test(resolved)) throw new CliError('INVALID_IMPORT', `Unsupported or missing source import: ${args.path}`);
        const relative = path.relative(candidateRoot, resolved);
        extraSource[relative] = await readBounded(resolved);
        return { path: resolved };
      });
    },
  };
}

export async function compileProject(sourceDirectory: string, options: { player?: boolean } = {}): Promise<CompiledProject> {
  const sourceRoot = await realpath(sourceDirectory);
  const source = await readSource(sourceRoot);
  let manifest: Manifest; let views: readonly ViewDefinition[];
  try {
    manifest = JSON.parse(source['experiment.json']!);
    validateManifest(manifest);
    views = source['views.json'] ? JSON.parse(source['views.json']) : [];
    validateViews(views, manifest);
  } catch (error) { throw new CliError('INVALID_SOURCE', `Experiment schema failed: ${error instanceof Error ? error.message : String(error)}`); }
  const dependencyLock = await readDependencyLock();
  const runtimeIdentity = await getRuntimeIdentity();
  const staging = await mkdtemp(path.join(tmpdir(), 'explorable-models-'));
  const output = path.join(staging, 'bundle');
  await mkdir(output);
  try {
    const hasChecks = Boolean(source['checks.ts']);
    const workerSource = `import { exposeModelWorker } from '@explorable-models/core';\nimport * as modelModule from 'kit:model';\n${hasChecks ? "import * as checkModule from 'kit:checks';" : 'const checkModule = {};'}\nconst model = modelModule.default ?? modelModule.model;\nif (!model || typeof model.evaluate !== 'function') throw new Error('model.ts must export model or a default AnalyticModel');\nexposeModelWorker(model);\nself.addEventListener('message', ({data}) => { if(data?.namespace === 'explorable-models-checks') { try { const suite = checkModule.default ?? checkModule.checks ?? checkModule.suite ?? null; self.postMessage({namespace:'explorable-models-checks', id:data.id, result:suite}); } catch(e) { self.postMessage({namespace:'explorable-models-checks',id:data.id,error:{code:'MODEL_ERROR',message:String(e)}}); } } });`;
    await esbuild({ stdin: { contents: workerSource, resolveDir: sourceRoot, sourcefile: 'toolkit-worker-entry.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: path.join(output, 'model-worker.js'), plugins: [modelImportPolicy(sourceRoot, source)], logLevel: 'silent', sourcemap: false, tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: false } } });
    if (Object.keys(source).length > 128 || Object.values(source).reduce((total, text) => total + Buffer.byteLength(text), 0) > 2 * 1024 * 1024) throw new CliError('RESOURCE_LIMIT', 'Experiment source and imported helpers exceed 128 files or 2 MiB.');
    const revision = definitionRevision({ manifest, views, source: canonical(source), dependencyLock, runtimeIdentity });
    const definition: ExperimentDefinition = { manifest, views, modelCard: source['model.md'], definitionRevision: revision };
    await writeJSON(path.join(output, 'definition.json'), definition);
    const harnessEntry = `import { startHarness } from ${JSON.stringify(path.join(TOOLKIT_ROOT, 'packages/cli/src/browser-harness.ts'))};\nstartHarness(${JSON.stringify(definition)});`;
    await esbuild({ stdin: { contents: harnessEntry, resolveDir: TOOLKIT_ROOT, sourcefile: 'toolkit-harness-entry.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: path.join(output, 'harness.js'), logLevel: 'silent', tsconfigRaw: {} });
    await writeFile(path.join(output, 'harness.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Explorable Models runner</title></head><body><main id="status">Starting model worker…</main><script type="module" src="./harness.js"></script></body></html>');
    if (options.player) {
      await buildPlayer(staging, output, definition);
      for (const [relative, text] of Object.entries(source)) { const file=path.join(output,'source',manifest.id,relative); await mkdir(path.dirname(file),{recursive:true}); await writeFile(file,text); }
    }
    return { directory: output, sourceDirectory: sourceRoot, source, definition, dependencyLock, dispose: () => rm(staging, { recursive: true, force: true }) };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

async function buildPlayer(staging: string, output: string, definition: ExperimentDefinition): Promise<void> {
  const entryDirectory = path.join(staging, 'player'); await mkdir(entryDirectory);
  const workerFile = path.join(output, 'model-worker.js');
  const registry = path.join(entryDirectory, 'registry.ts');
  await writeFile(registry, `import { WorkerExecutor } from ${JSON.stringify(CORE_ENTRY)};\nconst definition = ${JSON.stringify(definition)};\nconst makeWorker=()=>new Worker(new URL(${JSON.stringify(workerFile)},import.meta.url),{type:'module'});\nconst loadChecks=()=>new Promise((resolve,reject)=>{const worker=makeWorker();const id=crypto.randomUUID();const timer=setTimeout(()=>{worker.terminate();reject(new Error('Author checks timed out'));},3000);worker.addEventListener('message',({data})=>{if(data?.namespace!=='explorable-models-checks'||data.id!==id)return;clearTimeout(timer);worker.terminate();if(data.error)reject(new Error(data.error.message));else resolve(data.result?{...data.result,provenance:'author'}:null);});worker.postMessage({namespace:'explorable-models-checks',id});});\nexport const experimentEntries = [{id:definition.manifest.id,definition,loadChecks,createExecutor:()=>new WorkerExecutor(makeWorker(),definition.manifest)}];\nexport default experimentEntries;`);
  await writeFile(path.join(entryDirectory, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="description" content="An offline-ready Explorable Models interactive explanation"><title>Explorable Models</title></head><body><div id="root"></div><script type="module" src=${JSON.stringify(path.join(TOOLKIT_ROOT, 'packages/player/src/main.tsx'))}></script></body></html>`);
  await viteBuild({ configFile: false, root: entryDirectory, publicDir: false, base: './', logLevel: 'silent', resolve: { alias: { '@explorable-models/core': CORE_ENTRY, '@explorable-models/examples': registry } }, esbuild: { jsx: 'automatic' }, build: { outDir: output, emptyOutDir: false, target: 'es2022', sourcemap: false }, worker: { format: 'es' } });
}
