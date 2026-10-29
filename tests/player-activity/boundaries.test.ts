import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_STYLESHEET } from '../../packages/player/src/activity/styles';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/player/src/activity');
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
/** Source without comments (documentation may name forbidden APIs to explain why they are not used). */
const code = async (file: string) => (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : Promise.resolve(/\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : [])));
  return nested.flat();
}

async function resolveSource(base: string): Promise<string> {
  for (const candidate of [`${base}.ts`, `${base}.tsx`]) {
    try { await readFile(candidate); return candidate; } catch { /* try the next extension */ }
  }
  throw new Error(`Cannot resolve ${base}`);
}

/** Static import graph reachable from the entry. */
async function reachable(entry: string): Promise<{ files: Set<string>; external: Set<string> }> {
  const files = new Set<string>(), external = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = await code(file);
    for (const match of text.matchAll(STATIC_IMPORT)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith('.')) queue.push(await resolveSource(resolve(dirname(file), specifier.replace(/\.js$/, ''))));
      else external.add(specifier);
    }
  }
  return { files, external };
}

describe('learner entry boundaries (A01, A44, report §4.1, §16)', () => {
  it('keeps every relative import inside the activity entry and every external import on the allow-list', async () => {
    const files = await sourceFiles(root);
    const allowed = new Set(['react', 'react-dom', 'react-dom/client', '@experiment-kit/activity', '@experiment-kit/core/model']);
    for (const file of files) {
      const text = await code(file);
      for (const match of text.matchAll(STATIC_IMPORT)) {
        const specifier = match[1] ?? match[2];
        if (specifier.startsWith('.')) {
          expect(resolve(dirname(file), specifier).startsWith(root), `${relative(root, file)} imports ${specifier}`).toBe(true);
          expect(specifier, `${relative(root, file)} must use an explicit .js suffix`).toMatch(/\.js$/);
        } else expect(allowed.has(specifier), `${relative(root, file)} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('limits dynamic imports to the math loader and local optional assets, and forbids 3D, studio, CLI, Playwright or provider code', async () => {
    const files = await sourceFiles(root);
    const dynamic: Record<string, string[]> = {};
    for (const file of files) {
      const text = await code(file);
      // A typeof import() type reference and the actual import may name the same local module.
      const found = [...new Set([...text.matchAll(DYNAMIC_IMPORT)].map(match => match[1]))];
      if (found.length) dynamic[relative(root, file)] = found;
      expect(text, relative(root, file)).not.toMatch(/from\s+['"](three|katex|@experiment-kit\/player-3d|playwright|@playwright\/test|@modelcontextprotocol\/[^'"]*|@experiment-kit\/cli|@experiment-kit\/agent|node:[^'"]+)['"]/);
      expect(text, relative(root, file)).not.toMatch(/\.\.\/(App|main|agent-gallery|public|index)\b/);
    }
    expect(dynamic).toEqual({
      'StudyActivitySurface.tsx': ['./math-font-urls.js'],
      'capture.ts': ['./capture-renderer.js'],
      'math.ts': ['katex'],
    });
  });

  it('reaches the whole surface from the entry through static imports only', async () => {
    const graph = await reachable(join(root, 'index.ts'));
    expect([...graph.files].map(file => relative(root, file)).sort()).toEqual(expect.arrayContaining(['StudyActivitySurface.tsx', 'mount.tsx', 'components/Scene2D.tsx', 'components/Spatial.tsx', 'capture.ts', 'math.ts']));
    expect([...graph.files].map(file => relative(root, file))).not.toEqual(expect.arrayContaining(['capture-renderer.ts']));
    expect([...graph.files].map(file => relative(root, file))).not.toEqual(expect.arrayContaining(['math-font-urls.ts']));
    expect([...graph.external].sort()).toEqual(['@experiment-kit/activity', '@experiment-kit/core/model', 'react', 'react-dom', 'react-dom/client']);
  });

  it('uses no HTML injection, parsed style attributes, eval or dynamic function construction (§16, N4, N5)', async () => {
    for (const file of await sourceFiles(root)) {
      const text = await code(file);
      const name = relative(root, file);
      expect(text, name).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML|insertAdjacentHTML|renderToString|document\.write/);
      expect(text, name).not.toMatch(/setAttribute\(\s*['"]style['"]/);
      expect(text, name).not.toMatch(/\beval\(|new Function\(/);
      expect(text, name).not.toMatch(/createElement\(\s*['"]style['"]/);
    }
  });

  it('ships a stylesheet with container queries, reduced motion and no external resources', () => {
    expect(ACTIVITY_STYLESHEET).toMatch(/@container eka-card \(max-width:360px\)/);
    expect(ACTIVITY_STYLESHEET).toMatch(/@container eka-card \(min-width:800px\)/);
    expect(ACTIVITY_STYLESHEET).toMatch(/prefers-reduced-motion:reduce/);
    expect(ACTIVITY_STYLESHEET).not.toMatch(/@import|url\(|https?:/);
  });
});
