import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SOURCE_FILES = ['experiment.json', 'model.ts', 'views.json', 'checks.ts', 'model.md', 'fixtures.json'] as const;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export class CliError extends Error {
  constructor(public readonly code: string, message: string, public readonly recovery?: string) { super(message); this.name = 'CliError'; }
  toJSON() { return { code: this.code, message: this.message, ...(this.recovery ? { recovery: this.recovery } : {}) }; }
}
export function digest(bytes: string | Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
export async function readBounded(file: string, max = MAX_SOURCE_BYTES): Promise<string> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CliError('INVALID_SOURCE', `Expected an ordinary file: ${file}`);
  if (stat.size > max) throw new CliError('RESOURCE_LIMIT', `${file} exceeds the ${max}-byte limit.`);
  return readFile(file, 'utf8');
}
export async function readJSON(file: string): Promise<unknown> {
  try { return JSON.parse(await readBounded(file)); }
  catch (error) { if (error instanceof SyntaxError) throw new CliError('INVALID_SOURCE', `Invalid JSON in ${file}: ${error.message}`); throw error; }
}
export async function exists(file: string): Promise<boolean> { try { await lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
export async function ensureEmptyDestination(destination: string): Promise<void> {
  if (await exists(destination)) {
    const stat = await lstat(destination);
    if (!stat.isDirectory() || (await readdir(destination)).length !== 0) throw new CliError('DESTINATION_EXISTS', `Destination is not an empty directory: ${destination}`, 'Choose a new directory; existing work is never overwritten.');
  } else await mkdir(destination, { recursive: true });
}
export async function inside(root: string, file: string): Promise<string> {
  const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(file)]);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new CliError('INVALID_IMPORT', `Source import escapes the experiment: ${file}`);
  return resolvedFile;
}
/** Only source files explicitly allowed by the authoring contract enter exports. */
export async function readSource(directory: string): Promise<Record<string, string>> {
  const source: Record<string, string> = {};
  for (const name of SOURCE_FILES) {
    const file = path.join(directory, name);
    if (await exists(file)) source[name] = await readBounded(file);
  }
  for (const required of ['experiment.json', 'model.ts', 'model.md']) if (!(required in source)) throw new CliError('INVALID_SOURCE', `Missing ${required} in ${directory}`);
  const total = Object.values(source).reduce((sum, value) => sum + Buffer.byteLength(value), 0);
  if (total > MAX_SOURCE_BYTES) throw new CliError('RESOURCE_LIMIT', 'The experiment source exceeds 2 MiB.');
  return source;
}
export async function writeJSON(file: string, value: unknown): Promise<void> { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
export async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new CliError('INVALID_SOURCE', `Symlinks are not permitted in artifacts: ${relative}`);
    if (entry.isDirectory()) files.push(...await listFiles(directory, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}
