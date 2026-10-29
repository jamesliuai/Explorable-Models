/**
 * Builds the browser bundles for worker-backed authoring commands (report §15.2, §16, A09) into a fresh temporary
 * directory. esbuild only parses and concatenates; nothing authored runs in Node:
 *
 * - `worker-model.js`: fixed toolkit worker entry + the candidate kernel (`kernel.ts` and its relative imports, under
 *   the import allowlist), the installed kernels, or none (bounded document execution). Serves model evaluation.
 * - `worker-checks.js`: the same plus `checks.ts`; runs author checks and mutation batches in its own worker, so a
 *   faulty check module cannot disturb model evaluation.
 * - `harness.js` / `capture.js` / `preview.js`: fixed toolkit pages (no authored code) driving those workers, and the
 *   learner surface with an adapter and the fixture host for stage captures and the author/learner preview; KaTeX is a
 *   lazy chunk and assets are local copies.
 *
 * Candidate configuration (tsconfig, package.json scripts, plugins, Vite config) is never read.
 */
import { build, type BuildFailure, type Plugin } from 'esbuild';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CliError } from './files.js';
import { IGNORED_DIRECTORIES, importsOf, importViolation, resolveInside, sha256File, SOURCE_LIMITS } from './activity-files.js';
import { CLI_SOURCE, FIXTURE_HOST_SOURCE, TOOLKIT_ROOT, sourceEntries, toolkitRequire, toolkitResolver } from './activity-loader.js';
import { PREVIEW_CSS, PREVIEW_HTML } from './activity-preview-assets.js';
import type { AuthorDiagnostic } from './activity-validation.js';

export type ExecutionSource = 'authored-kernel' | 'installed-kernel' | 'document';
export interface BundleOptions {
  /** Package root for authored code, or null for installed templates. */
  root: string | null;
  source: ExecutionSource;
  checks: boolean;
  capture: boolean;
  /** Adds the `activity preview` page (index.html, preview.js, preview.css) and the surface assets. */
  preview?: boolean;
}
export interface SourceDigest { path: string; digest: string }
export interface BuiltBundle {
  directory: string;
  capture: boolean;
  /** Authored kernel sources that entered the worker bundle, with digests; empty for installed or document execution. */
  kernelSources: SourceDigest[];
  kernelSourceDigest: string | null;
  checksSources: SourceDigest[];
  checksSourceDigest: string | null;
  dispose(): Promise<void>;
}

/** Bundling failed; `diagnostics` name the authored file and line where known. */
export class BundleError extends CliError {
  constructor(readonly diagnostics: AuthorDiagnostic[]) {
    super(diagnostics[0]?.code ?? 'BUILD_FAILED', diagnostics.map(item => `${item.file}${item.path !== '$' ? ` ${item.path}` : ''}: ${item.message}`).join('; ').slice(0, 4000), diagnostics[0]?.recovery);
  }
}

const inside = (root: string | null, file: string): boolean => !!root && (file === root || file.startsWith(root + path.sep));
const rel = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');

/**
 * Import policy for authored code: every file under the package root is parsed and its references checked against
 * the allowlist before esbuild sees its contents; resolution stays inside the package; non-relative specifiers from
 * authored files are refused (type-only imports are erased before resolution).
 */
function authoredPolicy(root: string | null, collected: Map<string, string>): Plugin {
  return {
    name: 'explorable-models-authored-import-policy',
    setup(context) {
      context.onResolve({ filter: /.*/ }, async args => {
        if (!inside(root, args.importer)) return undefined;
        if (!args.path.startsWith('./') && !args.path.startsWith('../'))
          throw new CliError('INVALID_IMPORT', `${rel(root!, args.importer)}: import ${JSON.stringify(args.path)} is not allowed in authored code.`, 'Use relative .ts/.json files of the package and `import type` from @explorable-models/core/model.');
        const resolved = await resolveInside(root!, args.importer, args.path);
        if ('problem' in resolved) throw new CliError('INVALID_IMPORT', `${rel(root!, args.importer)}: ${resolved.problem}`);
        return { path: resolved.file };
      });
      context.onLoad({ filter: /.*/ }, async args => {
        if (!inside(root, args.path)) return undefined;
        const name = rel(root!, args.path);
        if (name.split('/').some(part => (IGNORED_DIRECTORIES as readonly string[]).includes(part))) throw new CliError('INVALID_IMPORT', `${name} is in a generated or private directory.`);
        if (!/\.(ts|json)$/.test(name)) throw new CliError('INVALID_IMPORT', `${name} is not a .ts or .json source file.`);
        const info = await lstat(args.path);
        if (!info.isFile() || info.size > SOURCE_LIMITS.fileBytes) throw new CliError('RESOURCE_LIMIT', `${name} is not an ordinary file within ${SOURCE_LIMITS.fileBytes} bytes.`);
        const text = await readFile(args.path, 'utf8');
        if (name.endsWith('.ts')) for (const record of importsOf(args.path, text)) {
          const violation = importViolation(record);
          if (violation) throw new CliError('INVALID_IMPORT', `${name} line ${record.line}: ${violation}`, 'Use relative .ts/.json files of the package and `import type` from @explorable-models/core/model.');
        }
        collected.set(name, text);
        const total = [...collected.values()].reduce((sum, item) => sum + Buffer.byteLength(item), 0);
        if (collected.size > SOURCE_LIMITS.files || total > SOURCE_LIMITS.totalBytes) throw new CliError('RESOURCE_LIMIT', `Authored sources exceed ${SOURCE_LIMITS.files} files or ${SOURCE_LIMITS.totalBytes} bytes.`);
        return { contents: text, loader: name.endsWith('.json') ? 'json' : 'ts', resolveDir: path.dirname(args.path) };
      });
    },
  };
}

/** `kit:kernel` / `kit:checks` virtual entries. */
function kitModules(options: BundleOptions, withChecks: boolean): Plugin {
  const installedIndex = path.join(TOOLKIT_ROOT, 'packages/catalog/src/kernels/index.ts');
  return {
    name: 'explorable-models-kit-modules',
    setup(context) {
      context.onResolve({ filter: /^kit:(kernel|checks)$/ }, args => {
        if (args.path === 'kit:kernel') {
          if (options.source === 'authored-kernel') return { path: path.join(options.root!, 'kernel.ts') };
          if (options.source === 'installed-kernel') return existsSync(installedIndex) ? { path: installedIndex } : { path: 'installed', namespace: 'kit' };
          return { path: 'empty', namespace: 'kit' };
        }
        return withChecks ? { path: path.join(options.root!, 'checks.ts') } : { path: 'empty', namespace: 'kit' };
      });
      context.onLoad({ filter: /.*/, namespace: 'kit' }, args => ({
        // Documented fallback when the catalogue source is absent: the published package's kernel list.
        contents: args.path === 'installed' ? "export { INSTALLED_KERNELS } from '@explorable-models/catalog';" : 'export {};', loader: 'ts', resolveDir: TOOLKIT_ROOT,
      }));
    },
  };
}

function failureDiagnostics(error: unknown, root: string | null): AuthorDiagnostic[] {
  const failure = error as Partial<BuildFailure>;
  if (!Array.isArray(failure.errors)) return [{ severity: 'error', code: 'BUILD_FAILED', file: '$', path: '$', message: error instanceof Error ? error.message : String(error) }];
  return failure.errors.slice(0, 16).map(item => {
    const detail = item.detail as unknown;
    if (detail instanceof CliError) return { severity: 'error' as const, code: detail.code, file: 'authored code', path: '$', message: detail.message, ...(detail.recovery ? { recovery: detail.recovery } : {}) };
    const file = item.location?.file ? (root && path.isAbsolute(item.location.file) && inside(root, item.location.file) ? rel(root, item.location.file) : item.location.file) : '$';
    return { severity: 'error' as const, code: 'BUILD_FAILED', file, path: item.location ? `line ${item.location.line}` : '$', message: item.text };
  });
}

const digestOf = (collected: Map<string, string>): { sources: SourceDigest[]; digest: string | null } => {
  const sources = [...collected.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, text]) => ({ path: file, digest: sha256File(text) }));
  return { sources, digest: sources.length ? sha256File(JSON.stringify(sources)) : null };
};

const COMMON = { bundle: true, format: 'esm' as const, platform: 'browser' as const, target: 'es2022', logLevel: 'silent' as const, absWorkingDir: TOOLKIT_ROOT,
  tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: false, jsx: 'react-jsx' as const } }, define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'none' as const };

async function copyAssets(directory: string): Promise<void> {
  const katexCss = toolkitRequire.resolve('katex/dist/katex.min.css');
  const katexFonts = path.join(path.dirname(katexCss), 'fonts');
  const interFiles = path.join(path.dirname(toolkitRequire.resolve('@fontsource-variable/inter/package.json')), 'files');
  await mkdir(path.join(directory, 'assets/math/fonts'), { recursive: true });
  await mkdir(path.join(directory, 'assets/fonts/inter'), { recursive: true });
  await copyFile(katexCss, path.join(directory, 'assets/math/katex.min.css'));
  for (const file of (await readdir(katexFonts)).filter(name => name.endsWith('.woff2'))) await copyFile(path.join(katexFonts, file), path.join(directory, 'assets/math/fonts', file));
  for (const subset of ['greek', 'latin-ext', 'latin']) await copyFile(path.join(interFiles, `inter-${subset}-wght-normal.woff2`), path.join(directory, `assets/fonts/inter/inter-${subset}-wght-normal.woff2`));
}

/** Builds the bundles; throws BundleError with authored-file diagnostics when the candidate cannot be bundled. */
export async function buildBundle(options: BundleOptions): Promise<BuiltBundle> {
  if (options.source === 'authored-kernel' && !options.root) throw new CliError('INVALID_PARAMETER', 'Authored kernels need a package root.');
  const entries = sourceEntries();
  if (!entries['@explorable-models/core/model'] && !existsSync(path.join(TOOLKIT_ROOT, 'node_modules/@explorable-models/core'))) throw new CliError('TOOLKIT_INCOMPLETE', 'The toolkit tree has neither packages/core/src nor an installed @explorable-models/core.');
  if ((options.capture || options.preview) && !existsSync(FIXTURE_HOST_SOURCE)) throw new CliError('TOOLKIT_INCOMPLETE', `Stage captures and previews need the browser fixture host at ${path.relative(TOOLKIT_ROOT, FIXTURE_HOST_SOURCE)}.`, 'Use the unified explorable-models toolkit tree, which ships examples/study-harness-host.');
  const directory = await mkdtemp(path.join(tmpdir(), 'explorable-models-activity-'));
  const kernelCollected = new Map<string, string>(), checksCollected = new Map<string, string>();
  const workerEntry = (checks: boolean) => [
    `import { startAuthorWorker } from ${JSON.stringify(path.join(CLI_SOURCE, 'activity-worker.ts'))};`,
    "import * as kernelModule from 'kit:kernel';",
    "import * as checksModule from 'kit:checks';",
    `startAuthorWorker({ source: ${JSON.stringify(options.source)}, kernelModule, checksModule, checks: ${checks} });`,
  ].join('\n');
  try {
    const worker = (name: string, checks: boolean, collected: Map<string, string>) => build({
      ...COMMON, stdin: { contents: workerEntry(checks), resolveDir: TOOLKIT_ROOT, sourcefile: `toolkit-${name}-entry.ts`, loader: 'ts' },
      outfile: path.join(directory, `${name}.js`), plugins: [kitModules(options, checks), authoredPolicy(options.root, collected), toolkitResolver()],
    });
    const pages: Record<string, string> = { harness: path.join(CLI_SOURCE, 'activity-harness.ts') };
    if (options.capture) pages.capture = path.join(CLI_SOURCE, 'activity-capture.ts');
    if (options.preview) pages.preview = path.join(CLI_SOURCE, 'activity-preview-page.ts');
    await Promise.all([
      worker('worker-model', false, kernelCollected),
      worker('worker-checks', options.checks, checksCollected),
      build({ ...COMMON, entryPoints: pages, outdir: directory, splitting: true, chunkNames: 'chunks/[name]-[hash]', jsx: 'automatic', plugins: [toolkitResolver()] }),
    ]);
    await writeFile(path.join(directory, 'harness.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Activity author harness</title></head><body><main id="status">Starting the author harness…</main><script type="module" src="./harness.js"></script></body></html>');
    if (options.capture) {
      await writeFile(path.join(directory, 'capture.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Activity stage capture</title></head><body><main id="capture-root"></main><script type="module" src="./capture.js"></script></body></html>');
    }
    if (options.preview) {
      await writeFile(path.join(directory, 'index.html'), PREVIEW_HTML);
      await writeFile(path.join(directory, 'preview.css'), PREVIEW_CSS);
    }
    if (options.capture || options.preview) await copyAssets(directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof CliError) throw error;
    throw new BundleError(failureDiagnostics(error, options.root));
  }
  // Checks sources include the kernel files they import; report the checks-only digest separately.
  const kernel = digestOf(kernelCollected);
  for (const file of kernelCollected.keys()) checksCollected.delete(file);
  const checks = digestOf(checksCollected);
  return {
    directory, capture: options.capture, kernelSources: kernel.sources, kernelSourceDigest: kernel.digest, checksSources: checks.sources, checksSourceDigest: checks.digest,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
