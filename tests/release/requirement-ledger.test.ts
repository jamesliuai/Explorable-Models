/**
 * Requirement ledger hygiene (report §20, §22.3; G63): every repository path cited in an implementation, verification
 * or evidence entry of docs/study-harness/requirement-ledger.json exists (globs must match at least one file), and the
 * rendered Markdown carries the Evidence and Notes columns. Statuses are not judged here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ledger = JSON.parse(readFileSync(join(root, 'docs/study-harness/requirement-ledger.json'), 'utf8')) as {
  requirements: { id: string; implementation: unknown[]; verification: unknown[]; evidence?: unknown[]; notes?: string }[];
};
const TOP = ['.github', 'packages', 'tests', 'docs', 'scripts', 'examples'];
const CANDIDATE = new RegExp(`(?<![\\w./@-])((?:${TOP.map(name => name.replace('.', '\\.')).join('|')})/[A-Za-z0-9_.@/{},*-]+)`, 'g');

/** Repository paths in a ledger entry: brace lists expanded, line suffixes and trailing punctuation removed. */
export function citedPaths(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    let candidate = match[1]!;
    // A comma outside braces ends the path ("a.ts, b.ts" or "a.ts,").
    let depth = 0, end = candidate.length;
    for (let index = 0; index < candidate.length; index++) {
      const char = candidate[index];
      if (char === '{') depth++;
      else if (char === '}') depth--;
      else if (char === ',' && depth === 0) { end = index; break; }
    }
    candidate = candidate.slice(0, end).replace(/[.:;]+$/, '').replace(/:\d+(-\d+)?$/, '');
    const brace = candidate.match(/^(.*?)\{([^{}]+)\}(.*)$/);
    const expanded = brace ? brace[2]!.split(',').map(part => `${brace[1]}${part}${brace[3]}`) : [candidate];
    out.push(...expanded.map(path => path.replace(/\/+$/, '')).filter(path => path.includes('/') && !/\/\.\.?(\/|$)/.test(path)));
  }
  return out;
}

/** True when the path exists, or (with `*` segments) matches at least one file or directory. */
export function pathExists(path: string, base = root): boolean {
  if (!path.includes('*')) return existsSync(join(base, path));
  const segments = path.split('/');
  const walk = (directory: string, rest: string[]): boolean => {
    if (!rest.length) return true;
    const [head, ...tail] = rest;
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return false;
    if (head === '**') return walk(directory, tail) || readdirSync(directory).some(name => statSync(join(directory, name)).isDirectory() && walk(join(directory, name), rest));
    if (!head!.includes('*')) return walk(join(directory, head!), tail);
    const pattern = new RegExp(`^${head!.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    return readdirSync(directory).some(name => pattern.test(name) && walk(join(directory, name), tail));
  };
  return walk(base, segments);
}

const text = (item: unknown): string => typeof item === 'string' ? item : item && typeof item === 'object' ? JSON.stringify(item) : '';

describe('requirement ledger (G63)', () => {
  it('extracts repository paths from ledger prose', () => {
    expect(citedPaths('packages/catalog/src/{kernels,models}/index.ts and tests/a.test.ts: x; see scripts/x.mjs, docs/y.md.')).toEqual([
      'packages/catalog/src/kernels/index.ts', 'packages/catalog/src/models/index.ts', 'tests/a.test.ts', 'scripts/x.mjs', 'docs/y.md',
    ]);
    expect(citedPaths('packages/cli/src/activity-worker.ts, activity-harness.ts (browser workers) and tests/b.test.ts:120-140')).toEqual(['packages/cli/src/activity-worker.ts', 'tests/b.test.ts']);
    expect(citedPaths('cd examples/study-harness-tauri && node scripts/conformance.mjs')).toEqual(['examples/study-harness-tauri', 'scripts/conformance.mjs']);
    expect(pathExists('tests/release/*.test.mjs')).toBe(true);
    expect(pathExists('tests/release/*.nothing')).toBe(false);
    expect(pathExists('tests/release/no-such-file.ts')).toBe(false);
  });

  it('every repository path cited in implementation, verification and evidence entries exists', () => {
    const missing: string[] = [];
    let cited = 0;
    for (const row of ledger.requirements) {
      for (const field of ['implementation', 'verification', 'evidence'] as const) {
        for (const item of row[field] ?? []) {
          for (const path of citedPaths(text(item))) {
            cited++;
            if (!pathExists(path)) missing.push(`${row.id} ${field}: ${path}`);
          }
        }
      }
    }
    expect(cited).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });

  it('the rendered ledger has Evidence and Notes columns and lists no duplicated entries', () => {
    const markdown = readFileSync(join(root, 'docs/study-harness/requirement-ledger.md'), 'utf8');
    expect(markdown).toContain('| ID | Criterion | WP | Status | Implementation | Verification | Evidence | External dependency | Notes |');
    for (const row of ledger.requirements) {
      for (const field of ['implementation', 'verification', 'evidence'] as const) {
        const entries = (row[field] ?? []).map(text);
        expect(new Set(entries).size, `${row.id} ${field} has duplicated entries`).toBe(entries.length);
      }
    }
  });
});
