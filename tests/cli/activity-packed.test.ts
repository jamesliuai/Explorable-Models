/**
 * Activity authoring from a packed toolkit tree (A56): the unified release keeps the `packages/<name>/src` layout and
 * installs no workspace links, so `@experiment-kit/*` must resolve from TOOLKIT_ROOT sources, not from monorepo
 * `node_modules/@experiment-kit` links or the repository's tsconfig paths. This builds that layout in a temporary
 * directory (sources copied, third-party dependencies linked, no `@experiment-kit` packages, no tsconfig.json) and runs
 * the real executable from an unrelated working directory. The release pipeline's clean npm install remains the
 * authoritative clean-install check.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { temporaryDirectory } from './activity-support';

const run = promisify(execFile);
const repository = path.resolve('.');
const COPIED = [
  'package.json', 'packages/core/src', 'packages/activity/src', 'packages/catalog/src', 'packages/player/src', 'packages/cli/src', 'packages/cli/bin', 'packages/cli/templates',
  'examples/study-harness-host', 'tests/reference/fixtures/activities',
];

describe('activity commands from a packed toolkit tree', () => {
  let work: Awaited<ReturnType<typeof temporaryDirectory>>;
  let tree: string, elsewhere: string;
  const cli = async (...args: string[]) => {
    try {
      const { stdout } = await run(process.execPath, [path.join(tree, 'packages/cli/bin/experiment-kit.mjs'), ...args], { cwd: elsewhere, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '' } });
      return { code: 0, stdout, report: stdout.trim().startsWith('{') ? JSON.parse(stdout) as Record<string, unknown> : null };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? 1, stdout: failure.stdout ?? '', report: failure.stdout?.trim().startsWith('{') ? JSON.parse(failure.stdout) as Record<string, unknown> : null, stderr: failure.stderr };
    }
  };

  beforeAll(async () => {
    work = await temporaryDirectory('activity-packed');
    tree = path.join(work.path, 'experiment-kit');
    elsewhere = path.join(work.path, 'author-project');
    await mkdir(elsewhere, { recursive: true });
    for (const relative of COPIED) await cp(path.join(repository, relative), path.join(tree, relative), { recursive: true, filter: source => !/[\\/](dist|node_modules|\.experiment-kit)([\\/]|$)/.test(source) });
    await mkdir(path.join(tree, 'node_modules'));
    for (const entry of await readdir(path.join(repository, 'node_modules'))) {
      if (entry === '@experiment-kit' || entry === '.vite' || entry === '.cache') continue;
      await symlink(path.join(repository, 'node_modules', entry), path.join(tree, 'node_modules', entry));
    }
  }, 60_000);
  afterAll(async () => { await work.dispose(); });

  it('has no workspace links or tsconfig paths to lean on', () => {
    expect(existsSync(path.join(tree, 'node_modules/@experiment-kit'))).toBe(false);
    expect(existsSync(path.join(tree, 'tsconfig.json'))).toBe(false);
    expect(existsSync(path.join(elsewhere, 'tsconfig.json'))).toBe(false);
  });

  it('prints the tree version in help and runs scaffold, validate, check, reference and capture', async () => {
    const version = (JSON.parse(await readFile(path.join(tree, 'package.json'), 'utf8')) as { version: string }).version;
    const help = await cli('--help');
    expect(help.stdout).toContain(`Explorable Models ${version}`);
    expect(help.stdout).toContain('activity <command>');
    expect((await cli('activity', '--help')).stdout).toContain('review-packet');

    const scaffold = await cli('activity', 'scaffold', 'packed-quad', '--from', 'quadratic-gradient-descent');
    expect(scaffold.code).toBe(0);
    expect(scaffold.report).toMatchObject({ templateId: 'packed-quad', kernel: 'copied-from-installed' });
    expect((await cli('activity', 'validate', 'packed-quad')).report).toMatchObject({ ok: true, referenceSuite: { binding: 'matches' } });
    const check = await cli('activity', 'check', 'packed-quad');
    expect(check.code).toBe(0);
    expect(check.report).toMatchObject({ passed: true, stage: 'worker' });
    const reference = await cli('activity', 'reference', 'packed-quad');
    expect(reference.report).toMatchObject({ passed: true, summary: { cases: 55, failed: 0 } });
    const capture = await cli('activity', 'capture', 'packed-quad', '--stage', 'explore-step', '--index', '3');
    expect(capture.code).toBe(0);
    expect(capture.report).toMatchObject({ passed: true });
    expect(existsSync(path.join(elsewhere, 'packed-quad/review/captures/explore-step.png'))).toBe(true);
    const companion = await readFile(path.join(elsewhere, 'packed-quad/review/captures/explore-step.txt'), 'utf8');
    expect(companion).toContain('Shown at iteration n = 3');
  }, 120_000);
});
