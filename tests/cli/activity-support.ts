/**
 * Shared helpers for the activity authoring CLI tests: run `experiment-kit activity …` in-process and parse its JSON
 * report, temporary directories, and small JSON edits of scaffolded packages.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { main } from '../../packages/cli/src/index';
import { CliError } from '../../packages/cli/src/files';

export interface CliRun<T = Record<string, unknown>> { report: T; exitCode: number; stdout: string }

/** Runs the CLI in this process and returns the JSON report printed on stdout and the exit code it set. */
export async function activity<T = Record<string, unknown>>(...args: string[]): Promise<CliRun<T>> {
  let stdout = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; });
  const previous = process.exitCode;
  process.exitCode = 0;
  try {
    try { await main(['activity', ...args]); }
    catch (error) {
      // The executable prints thrown CLI errors as { error } on stderr with exit code 1; mirror that here.
      if (!(error instanceof CliError)) throw error;
      return { report: { error: error.toJSON() } as T, exitCode: 1, stdout };
    }
    const exitCode = Number(process.exitCode ?? 0);
    return { report: (stdout.trim().startsWith('{') ? JSON.parse(stdout) : {}) as T, exitCode, stdout };
  } finally {
    spy.mockRestore();
    process.exitCode = previous;
  }
}

export async function temporaryDirectory(prefix: string): Promise<{ path: string; dispose(): Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), `experiment-kit-${prefix}-`));
  return { path: directory, dispose: () => rm(directory, { recursive: true, force: true }) };
}

export async function readJson<T = Record<string, unknown>>(file: string): Promise<T> { return JSON.parse(await readFile(file, 'utf8')) as T; }
/** Applies `edit` to a JSON file in place (pretty-printed, as the scaffold writes it). */
export async function editJson<T = Record<string, unknown>>(file: string, edit: (value: T) => T | void): Promise<void> {
  const value = await readJson<T>(file);
  const next = edit(value) ?? value;
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
}

export interface Diagnostic { severity: string; code: string; file: string; path: string; message: string }
export const codes = (diagnostics: Diagnostic[] | undefined, severity = 'error'): string[] => (diagnostics ?? []).filter(item => item.severity === severity).map(item => item.code);
