/**
 * Toolkit resolution for the activity authoring commands (Node side; imports only Node built-ins, esbuild and relative
 * CLI modules, so it loads the same way from the repository, from an unpacked release tree and from any working
 * directory).
 *
 * TOOLKIT_ROOT is the directory three levels above this file: the repository root in a checkout, and the package root
 * of the unified `experiment-kit` release tarball, which keeps the same `packages/<name>/src` layout. `@experiment-kit/*`
 * specifiers resolve to those source entries. Documented fallback: when a source entry is absent (a tree that ships
 * only built packages), the specifier is left to normal `node_modules` resolution of the published package.
 */
import { build, type Plugin } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Toolkit from './activity-toolkit.js';

export const TOOLKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const CLI_SOURCE = path.join(TOOLKIT_ROOT, 'packages/cli/src');
export const ACTIVITY_TEMPLATE_DIRECTORY = path.join(TOOLKIT_ROOT, 'packages/cli/templates/activity');
/** Where the installed reference suites live in the toolkit tree (outside the catalogue, report §12.6). */
export const INSTALLED_FIXTURE_DIRECTORY = path.join(TOOLKIT_ROOT, 'tests/reference/fixtures/activities');
export const INSTALLED_KERNEL_DIRECTORY = path.join(TOOLKIT_ROOT, 'packages/catalog/src/kernels');
/** Browser integration fixture host used for author previews and stage captures (an `HostPort` fixture, not a tutor). */
export const FIXTURE_HOST_SOURCE = path.join(TOOLKIT_ROOT, 'examples/study-harness-host/fixture-host.ts');

/** Version of the toolkit tree the CLI runs from (its package.json), or `unknown` with no manifest. */
export function toolkitVersion(): string {
  try { return String((JSON.parse(readFileSync(path.join(TOOLKIT_ROOT, 'package.json'), 'utf8')) as { version?: unknown }).version ?? 'unknown'); }
  catch { return 'unknown'; }
}

const SOURCE_ENTRIES: Readonly<Record<string, string>> = Object.freeze({
  '@experiment-kit/core': 'packages/core/src/index.ts',
  '@experiment-kit/core/model': 'packages/core/src/model/index.ts',
  '@experiment-kit/core/declarative': 'packages/core/src/declarative/index.ts',
  '@experiment-kit/activity': 'packages/activity/src/index.ts',
  '@experiment-kit/catalog': 'packages/catalog/src/index.ts',
  '@experiment-kit/catalog/worker': 'packages/catalog/src/worker.ts',
  '@experiment-kit/player/activity': 'packages/player/src/activity/index.ts',
});

/** Exact source entries present in this tree (specifier → absolute path). */
export function sourceEntries(): Record<string, string> {
  return Object.fromEntries(Object.entries(SOURCE_ENTRIES).map(([specifier, relative]) => [specifier, path.join(TOOLKIT_ROOT, relative)]).filter(([, file]) => existsSync(file!)));
}

/** esbuild resolver for `@experiment-kit/*`: source entries first, else default package resolution (documented fallback). */
export function toolkitResolver(): Plugin {
  const entries = sourceEntries();
  return {
    name: 'experiment-kit-toolkit-sources',
    setup(context) {
      context.onResolve({ filter: /^@experiment-kit\// }, args => entries[args.path] ? { path: entries[args.path]! } : undefined);
    },
  };
}

/** Directory with the toolkit's npm dependencies (React, KaTeX, fonts) for bundling and asset copies. */
export const toolkitRequire = createRequire(path.join(TOOLKIT_ROOT, 'package.json'));

let toolkit: Promise<typeof Toolkit> | null = null;
/**
 * Loads the Node-side toolkit facade, bundled from source with the same resolution the browser bundles use. Trusted
 * toolkit code only; authored package code never passes through here.
 */
export function loadToolkit(): Promise<typeof Toolkit> {
  toolkit ??= (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'experiment-kit-toolkit-'));
    try {
      const outfile = path.join(directory, 'toolkit.mjs');
      await build({
        entryPoints: [path.join(CLI_SOURCE, 'activity-toolkit.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
        absWorkingDir: TOOLKIT_ROOT, plugins: [toolkitResolver()], logLevel: 'silent', tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: false } },
      });
      return await import(pathToFileURL(outfile).href) as typeof Toolkit;
    } finally { await rm(directory, { recursive: true, force: true }); }
  })();
  toolkit.catch(() => { toolkit = null; });
  return toolkit;
}
