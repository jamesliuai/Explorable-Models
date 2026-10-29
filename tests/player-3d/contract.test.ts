/**
 * The spatial renderer against the learner surface's contract and the package boundaries (report §13, §16, A44, N4):
 * it satisfies `SpatialRendererModule` (checked at compile time), uses no HTML injection, style attributes, eval,
 * SVG `foreignObject`, network loaders or textures; its bundle keeps Three.js external; and the eager graph of the 2D
 * learner entry never reaches Three.js or this package (bundle analysis with esbuild, as the package build does).
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { INSTALLED_TEMPLATES } from '../../packages/catalog/src/index';
import type { SpatialRendererModule, SpatialRendererStats } from '../../packages/player/src/activity/spatial-contract';
import * as player3d from '../../packages/player-3d/src/index';
import type { SpatialStats } from '../../packages/player-3d/src/types';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = join(root, 'packages/player-3d/src');

// Compile-time conformance: the package namespace is a SpatialRendererModule, and its stats are the contract's stats.
const asModule: SpatialRendererModule = player3d;
const statsMatch: SpatialRendererStats extends SpatialStats ? (SpatialStats extends SpatialRendererStats ? true : false) : false = true;

const code = async (file: string) => (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const files = async () => (await readdir(source)).filter(name => name.endsWith('.ts')).map(name => join(source, name));

describe('player-3d contract and boundaries', () => {
  it('exports the contract surface and probes WebGL without a DOM as unavailable', () => {
    expect(statsMatch).toBe(true);
    expect(typeof asModule.mount).toBe('function');
    expect(asModule.webglAvailable()).toBe(false);
    expect(Object.keys(player3d).sort()).toEqual(['CAMERA_LIMITS', 'CAMERA_PRESETS', 'IDLE_RENDERER_LIMIT', 'PRESET_ORDER', 'RESTORE_ATTEMPTS', 'SPATIAL_LIMITS', 'SPATIAL_STYLESHEET', 'inspect', 'mount', 'planSpatialScene', 'releaseIdleRenderers', 'webglAvailable']);
    // Without a document there is no pool to release.
    expect(player3d.releaseIdleRenderers()).toBe(0);
  });

  it('uses no HTML injection, style attributes, inline style elements, eval, foreignObject, network loaders or textures (§16, N4)', async () => {
    for (const file of await files()) {
      const text = await code(file);
      const name = relative(root, file);
      expect(text, name).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
      expect(text, name).not.toMatch(/setAttribute\(\s*['"]style['"]|createElement\(\s*['"]style['"]|\.cssText\s*=/);
      expect(text, name).not.toMatch(/\beval\(|new Function\(/);
      expect(text, name).not.toMatch(/foreignObject/);
      expect(text, name).not.toMatch(/\bfetch\(|XMLHttpRequest|TextureLoader|ImageLoader|FileLoader|GLTFLoader|ObjectLoader|https?:\/\//);
      expect(text, name).not.toMatch(/\b(CanvasTexture|DataTexture|Texture)\b/);
      expect(text, name).not.toMatch(/ShaderMaterial|RawShaderMaterial|onBeforeCompile/);
      expect(text, name).not.toMatch(/setAnimationLoop/);
    }
    expect(player3d.SPATIAL_STYLESHEET).not.toMatch(/@import|url\(|https?:/);
  });

  it('bundles without Three.js (an external peer) and imports only three and its line addons', async () => {
    const result = await build({
      entryPoints: [join(source, 'index.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', metafile: true, logLevel: 'silent',
      external: ['three', 'three/*', '@explorable-models/core', '@explorable-models/core/*'],
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some(input => input.includes('node_modules'))).toBe(false);
    const imports = [...new Set(Object.values(result.metafile.outputs).flatMap(output => output.imports.map(item => item.path)))].sort();
    expect(imports).toEqual(['three', 'three/addons/lines/LineMaterial.js', 'three/addons/lines/LineSegments2.js', 'three/addons/lines/LineSegmentsGeometry.js']);
  });

  it('the eager graph of the 2D learner entry contains neither Three.js nor player-3d; the surface reaches 3D only through the host loader (A44)', async () => {
    const result = await build({
      entryPoints: [join(root, 'packages/player/src/activity/index.ts')], bundle: true, splitting: true, outdir: join(root, '.bundle-analysis'), write: false,
      format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', metafile: true, logLevel: 'silent',
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@explorable-models/*'],
    });
    const outputs = result.metafile.outputs;
    const entry = Object.keys(outputs).find(path => outputs[path]!.entryPoint?.endsWith('packages/player/src/activity/index.ts'))!;
    const eager = new Set<string>();
    const visit = (path: string) => { if (eager.has(path)) return; eager.add(path); for (const item of outputs[path]!.imports) if (item.kind === 'import-statement' && outputs[item.path]) visit(item.path); };
    visit(entry);
    const eagerInputs = [...eager].flatMap(path => Object.keys(outputs[path]!.inputs));
    expect(eagerInputs.some(input => /node_modules[\\/]three[\\/]|player-3d/.test(input))).toBe(false);
    const everyInput = Object.keys(result.metafile.inputs);
    expect(everyInput.some(input => /node_modules[\\/]three[\\/]|player-3d/.test(input))).toBe(false);
    expect(everyInput.some(input => input.endsWith('components/Spatial.tsx'))).toBe(true);
  });

  it('every alternative of both spatial templates is verified by a titled test in the spatial browser spec', async () => {
    const spec = await readFile(join(root, 'tests/browser/study-spatial.spec.ts'), 'utf8');
    const titles = [...spec.matchAll(/\btest\(\s*'([^']+)'/g)].map(match => match[1]!);
    const spatial = INSTALLED_TEMPLATES.filter(template => template.dimension === '3d');
    expect(spatial.map(template => template.templateId).sort()).toEqual(['quadratic-surface-gradient', 'vector-orientation-3d']);
    const ids = spatial.flatMap(template => template.alternatives.map(alternative => alternative.verifiedBy.split('#')[1]!));
    for (const template of spatial) for (const alternative of template.alternatives) {
      const [file, id] = alternative.verifiedBy.split('#');
      expect(file, alternative.id).toBe('tests/browser/study-spatial.spec.ts');
      // An ID used by both templates names the template in the title.
      const prefix = ids.filter(other => other === id).length > 1 ? `alternative ${id} (${template.templateId}): ` : `alternative ${id}: `;
      expect(titles.filter(title => title.startsWith(prefix)), `${template.templateId} ${alternative.id} → ${prefix}`).toHaveLength(1);
    }
  });
});
