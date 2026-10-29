/**
 * Authoring package files (Node side). Reads only the files the authoring format names, bounded and without following
 * symlinks out of the package, and scans kernel.ts/checks.ts (and the relative files they import) with the TypeScript
 * parser. Scanning parses text; it never evaluates it. The same scan backs the bundler's import policy.
 *
 * Import allowlist for authored code: relative `.ts`/`.json` files inside the package, and type-only imports from
 * `@experiment-kit/core/model`. Everything else — Node built-ins, npm packages, other toolkit entries, value imports,
 * dynamic `import()`, `require` and `import x = require()` — is rejected before any bundling.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { CliError, exists } from './files.js';
import type { AuthorDiagnostic, PackageSnapshot } from './activity-validation.js';

export const PACKAGE_JSON_FILES = ['model.json', 'template.json', 'authoring.json', 'fixtures/reference.json', 'fixtures/boundaries.json'] as const;
export const PACKAGE_TEXT_FILES = ['copy.md'] as const;
export const AUTHORED_ENTRIES = ['kernel.ts', 'checks.ts'] as const;
export const SOURCE_LIMITS = Object.freeze({ fileBytes: 2 * 1024 * 1024, totalBytes: 2 * 1024 * 1024, files: 128, fixtureBytes: 8 * 1024 * 1024 });
/** Generated and private directories that never count as package source. */
export const IGNORED_DIRECTORIES = ['.experiment-kit', 'node_modules', '.git'] as const;
const TYPE_ONLY_MODULE = '@experiment-kit/core/model';

export const sha256File = (bytes: string | Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** JSON text that keeps negative zero (`-0`), which JSON.stringify writes as `0`, with a trailing newline. */
export function stableJSON(value: unknown): string {
  const mark = '\u0000negative-zero\u0000';
  const text = JSON.stringify(value, (_key, item: unknown) => Object.is(item, -0) ? mark : item, 2);
  return `${text.split(JSON.stringify(mark)).join('-0')}\n`;
}

async function readRegular(file: string, max: number): Promise<string | null> {
  let info;
  try { info = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink() || !info.isFile()) throw new CliError('INVALID_SOURCE', `Expected an ordinary file (no symlink): ${file}`);
  if (info.size > max) throw new CliError('RESOURCE_LIMIT', `${file} exceeds the ${max}-byte limit.`);
  return readFile(file, 'utf8');
}

export interface ImportRecord { specifier: string; typeOnly: boolean; line: number; kind: 'static' | 'export' | 'dynamic' | 'require' | 'import-equals' | 'type' }
/** Every module reference in one TypeScript source (parsing only). */
export function importsOf(file: string, text: string): ImportRecord[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: ImportRecord[] = [];
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literal = (node: ts.Node | undefined): string | null => node && ts.isStringLiteralLike(node) ? node.text : null;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && named.length > 0 && named.every(element => element.isTypeOnly)));
      found.push({ specifier: literal(node.moduleSpecifier) ?? '<non-literal>', typeOnly, line: line(node), kind: 'static' });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      found.push({ specifier: literal(node.moduleSpecifier) ?? '<non-literal>', typeOnly: node.isTypeOnly, line: line(node), kind: 'export' });
    } else if (ts.isImportEqualsDeclaration(node)) {
      const specifier = ts.isExternalModuleReference(node.moduleReference) ? literal(node.moduleReference.expression) ?? '<non-literal>' : '<namespace alias>';
      found.push({ specifier, typeOnly: node.isTypeOnly, line: line(node), kind: 'import-equals' });
    } else if (ts.isImportTypeNode(node)) {
      const argument = ts.isLiteralTypeNode(node.argument) ? literal(node.argument.literal) : null;
      found.push({ specifier: argument ?? '<non-literal>', typeOnly: true, line: line(node), kind: 'type' });
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) found.push({ specifier: literal(node.arguments[0]) ?? '<non-literal>', typeOnly: false, line: line(node), kind: 'dynamic' });
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') found.push({ specifier: literal(node.arguments[0]) ?? '<non-literal>', typeOnly: false, line: line(node), kind: 'require' });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const relative = (specifier: string): boolean => specifier.startsWith('./') || specifier.startsWith('../');
/** Why a reference breaks the allowlist, or null. */
export function importViolation(record: ImportRecord): string | null {
  if (record.kind === 'dynamic') return `Dynamic import(${JSON.stringify(record.specifier)}) is not allowed in authored code.`;
  if (record.kind === 'require' || record.kind === 'import-equals') return `${record.kind === 'require' ? 'require' : 'import = require'}(${JSON.stringify(record.specifier)}) is not allowed in authored code.`;
  if (relative(record.specifier)) return null;
  if (record.specifier === TYPE_ONLY_MODULE) return record.typeOnly ? null : `Only type-only imports from ${TYPE_ONLY_MODULE} are allowed (use \`import type\`).`;
  return `Import ${JSON.stringify(record.specifier)} is not allowed: authored code may import relative .ts/.json files of the package and types from ${TYPE_ONLY_MODULE}.`;
}

/** Resolves a relative import inside the package root to an existing `.ts`/`.json` file, or explains why it cannot. */
export async function resolveInside(root: string, importer: string, specifier: string): Promise<{ file: string } | { problem: string }> {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [base, `${base}.ts`, base.replace(/\.js$/, '.ts'), path.join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (!await exists(candidate)) continue;
    const info = await lstat(candidate);
    if (info.isDirectory()) continue;
    const resolved = await realpath(candidate);
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { problem: `Import ${JSON.stringify(specifier)} escapes the package directory.` };
    if (rel.split(path.sep).some(part => (IGNORED_DIRECTORIES as readonly string[]).includes(part))) return { problem: `Import ${JSON.stringify(specifier)} points into a generated or private directory.` };
    if (!/\.(ts|json)$/.test(resolved) || /\.d\.ts$/.test(resolved)) return { problem: `Import ${JSON.stringify(specifier)} is not a .ts or .json source file.` };
    return { file: resolved };
  }
  return { problem: `Import ${JSON.stringify(specifier)} does not resolve to a file in the package.` };
}

export interface AuthoredSources {
  /** Relative path → text for every authored source reachable from the entry (entry included). */
  files: Record<string, string>;
  diagnostics: AuthorDiagnostic[];
}

/** Import closure of one authored entry (kernel.ts or checks.ts), with allowlist and limit diagnostics. */
export async function authoredSources(root: string, entry: string): Promise<AuthoredSources> {
  const files: Record<string, string> = {};
  const diagnostics: AuthorDiagnostic[] = [];
  const queue = [path.join(root, entry)];
  let total = 0;
  while (queue.length) {
    const file = queue.shift()!;
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (rel in files) continue;
    const text = await readRegular(file, SOURCE_LIMITS.fileBytes);
    if (text === null) { diagnostics.push({ severity: 'error', code: 'NOT_FOUND', file: rel, path: '$', message: `${rel} does not exist.` }); continue; }
    files[rel] = text;
    total += Buffer.byteLength(text);
    if (Object.keys(files).length > SOURCE_LIMITS.files || total > SOURCE_LIMITS.totalBytes) {
      diagnostics.push({ severity: 'error', code: 'RESOURCE_LIMIT', file: entry, path: '$', message: `Authored sources exceed ${SOURCE_LIMITS.files} files or ${SOURCE_LIMITS.totalBytes} bytes.` });
      break;
    }
    if (rel.endsWith('.json')) continue;
    for (const record of importsOf(file, text)) {
      const violation = importViolation(record);
      if (violation) { diagnostics.push({ severity: 'error', code: 'INVALID_IMPORT', file: rel, path: `line ${record.line}`, message: violation, recovery: 'Keep authored model and check code self-contained: relative .ts/.json files and `import type` from @experiment-kit/core/model only.' }); continue; }
      if (!relative(record.specifier)) continue;
      const resolved = await resolveInside(root, file, record.specifier);
      if ('problem' in resolved) diagnostics.push({ severity: 'error', code: 'INVALID_IMPORT', file: rel, path: `line ${record.line}`, message: resolved.problem });
      else if (record.kind !== 'type' && !record.typeOnly) queue.push(resolved.file);
    }
  }
  return { files, diagnostics };
}

export interface ActivityPackage {
  root: string;
  snapshot: PackageSnapshot;
  /** Import closure of each present authored entry. */
  authored: { kernel: AuthoredSources | null; checks: AuthoredSources | null };
}

/**
 * Reads a package directory: the named JSON/Markdown files, the authored entries and their import closure, and the
 * reference fixtures (`fixtures/reference.json`, or `fixturesPath` outside the package).
 */
export async function readActivityPackage(directory: string, options: { fixturesPath?: string } = {}): Promise<ActivityPackage> {
  let root: string;
  try { root = await realpath(directory); } catch { throw new CliError('NOT_FOUND', `Package directory not found: ${directory}`, 'Run experiment-kit activity scaffold <directory> to create one.'); }
  if (!(await lstat(root)).isDirectory()) throw new CliError('INVALID_SOURCE', `Not a directory: ${directory}`);
  const files: Record<string, string> = {};
  for (const name of [...PACKAGE_JSON_FILES, ...PACKAGE_TEXT_FILES]) {
    const text = await readRegular(path.join(root, name), name.startsWith('fixtures/') ? SOURCE_LIMITS.fixtureBytes : SOURCE_LIMITS.fileBytes);
    if (text !== null) files[name] = text;
  }
  const authored: ActivityPackage['authored'] = { kernel: null, checks: null };
  const importDiagnostics: AuthorDiagnostic[] = [];
  for (const entry of AUTHORED_ENTRIES) {
    if (!await exists(path.join(root, entry))) continue;
    const sources = await authoredSources(root, entry);
    authored[entry === 'kernel.ts' ? 'kernel' : 'checks'] = sources;
    files[entry] = sources.files[entry] ?? '';
    importDiagnostics.push(...sources.diagnostics);
  }
  let fixture: PackageSnapshot['fixture'] = null;
  if (options.fixturesPath) {
    const external = path.resolve(options.fixturesPath);
    const text = await readRegular(external, SOURCE_LIMITS.fixtureBytes);
    if (text === null) throw new CliError('NOT_FOUND', `Reference fixtures not found: ${options.fixturesPath}`);
    fixture = { path: external, text, external: true };
  } else if (files['fixtures/reference.json'] !== undefined) fixture = { path: path.join(root, 'fixtures/reference.json'), text: files['fixtures/reference.json'], external: false };
  return { root, snapshot: { files, fixture, importDiagnostics }, authored };
}

/** Every regular file below `directory` (sorted, posix separators), skipping ignored directories; rejects symlinks. */
export async function listPackageFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new CliError('INVALID_SOURCE', `Symlinks are not permitted in activity packages: ${rel}`);
    if (entry.isDirectory()) { if (!(IGNORED_DIRECTORIES as readonly string[]).includes(entry.name)) out.push(...await listPackageFiles(directory, rel)); }
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Replaces `target` with `staging` only after a run completed: a failed run leaves the previous outputs (the last
 * working candidate's captures or packet) untouched.
 */
export async function replaceDirectory(staging: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const previous = `${target}.previous-${process.pid}`;
  const had = await exists(target);
  if (had) await rename(target, previous);
  try { await rename(staging, target); }
  catch (error) { if (had) await rename(previous, target); throw error; }
  if (had) await rm(previous, { recursive: true, force: true });
}

export async function writeText(file: string, text: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
