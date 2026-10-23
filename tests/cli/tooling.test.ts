import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonical, digest, ensureEmptyDestination, inside, readSource } from '../../packages/cli/src/files';
import { compileProject } from '../../packages/cli/src/compiler';
import { main } from '../../packages/cli/src/index';
import { serveStatic } from '../../packages/cli/src/server';

const directories: string[] = [];
async function temp() { const dir = await mkdtemp(path.join(tmpdir(), 'experiment-cli-test-')); directories.push(dir); return dir; }
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('portable source and bounded build surface', () => {
  it('hashes canonical JSON independent of object insertion order', () => { expect(canonical({ z: 2, a: [1,3] })).toBe(canonical({ a: [1,3], z: 2 })); expect(digest('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); });
  it('never overwrites an existing source destination', async () => { const dir = await temp(); await writeFile(path.join(dir,'lesson.txt'),'keep'); await expect(ensureEmptyDestination(dir)).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' }); expect(await readFile(path.join(dir,'lesson.txt'),'utf8')).toBe('keep'); });
  it('excludes secrets, candidate scripts, and unrelated local files from source transfer', async () => { const dir = await temp(); await Promise.all(Object.entries({ 'experiment.json':'{}', 'model.ts':'export default {}', 'model.md':'Assumptions', '.env':'SECRET=never-export', 'package.json':'{"scripts":{"build":"do-not-run"}}' }).map(([name, value])=>writeFile(path.join(dir,name),value))); const source=await readSource(dir); expect(Object.keys(source).sort()).toEqual(['experiment.json','model.md','model.ts']); });
  it('rejects symlink imports that escape the experiment', async () => { const dir=await temp(); const sibling=await temp(); await writeFile(path.join(sibling,'private.ts'),'private'); await symlink(path.join(sibling,'private.ts'),path.join(dir,'escape.ts')); await expect(inside(dir,path.join(dir,'escape.ts'))).rejects.toMatchObject({code:'INVALID_IMPORT'}); });
  it('initializes editable source and compiles without executing top-level candidate code or package hooks', async () => {
    const dir=await temp(); await main(['init',dir,'--template','linear-map']);
    const file=path.join(dir,'model.ts'); await writeFile(file, `globalThis.__candidateWasExecuted = true;\n${await readFile(file,'utf8')}`);
    await writeFile(path.join(dir,'vite.config.ts'), 'throw new Error("CANDIDATE CONFIG EXECUTED")');
    await writeFile(path.join(dir,'package.json'), '{"scripts":{"build":"exit 42"}}');
    const compiled=await compileProject(dir);
    try { expect((globalThis as Record<string,unknown>).__candidateWasExecuted).toBeUndefined(); expect(compiled.definition.definitionRevision).toMatch(/^sha256:[a-f0-9]{64}$/); expect(await readFile(path.join(compiled.directory,'model-worker.js'),'utf8')).toContain('__candidateWasExecuted'); expect(compiled.source).not.toHaveProperty('vite.config.ts'); }
    finally { await compiled.dispose(); }
  });
  it('rejects remote and dynamic imports before any runtime starts', async () => {
    const dir=await temp(); await main(['init',dir]); const file=path.join(dir,'model.ts'); const original=await readFile(file,'utf8');
    await writeFile(file, `import 'https://example.com/remote.js';\n${original}`); await expect(compileProject(dir)).rejects.toThrow(/Model imports must be/);
    await writeFile(file, `const load = () => import('./hidden.ts');\n${original}`); await expect(compileProject(dir)).rejects.toThrow(/Dynamic imports/);
  });
});

describe('loopback transport boundary', () => {
  it('serves only local assets, requires token and matching origin for mutations', async () => {
    const dir=await temp(); await writeFile(path.join(dir,'index.html'),'<h1>Local experiment</h1>');
    const server=await serveStatic(dir,{api:async input=>({received:input})});
    try {
      const get=await fetch(server.url); expect(get.status).toBe(200); expect(get.headers.get('content-security-policy')).toContain("object-src 'none'"); expect(get.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect((await fetch(`${server.url}/__experiment/api`,{method:'POST',body:'{}'})).status).toBe(403);
      expect((await fetch(`${server.url}/__experiment/api`,{method:'POST',headers:{Authorization:`Bearer ${server.token}`,Origin:'https://untrusted.example'},body:'{}'})).status).toBe(403);
      const valid=await fetch(`${server.url}/__experiment/api`,{method:'POST',headers:{Authorization:`Bearer ${server.token}`,Origin:server.url},body:'{"command":"inspect"}'}); expect(await valid.json()).toEqual({received:{command:'inspect'}});
      expect((await fetch(`${server.url}/missing.json`)).status).toBe(404);
      const outside=await temp(); await writeFile(path.join(outside,'private.txt'),'not public'); await symlink(path.join(outside,'private.txt'),path.join(dir,'private.txt')); expect((await fetch(`${server.url}/private.txt`)).status).toBe(403);
    } finally { await server.close(); }
  });
});
