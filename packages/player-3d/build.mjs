// Builds @experiment-kit/player-3d: one ESM bundle (dist/index.js) with Three.js and @experiment-kit/core external,
// declarations from tsc (emitDeclarationOnly), and dist/build-manifest.json recording sizes and inputs. The build fails
// if any Three.js source is bundled (it must stay a peer dependency resolved by the consumer) or if the bundle reaches
// another Experiment Kit package.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
execFileSync('tsc', ['-p', 'tsconfig.build.json', '--emitDeclarationOnly'], { stdio: 'inherit' });

const result = await build({
  entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true,
  platform: 'browser', format: 'esm', target: 'es2022', sourcemap: true,
  external: ['three', 'three/*', '@experiment-kit/core', '@experiment-kit/core/*'],
  metafile: true, legalComments: 'linked',
});
const inputs = Object.keys(result.metafile.inputs);
if (inputs.some(input => /node_modules[\\/]three[\\/]/.test(input))) throw new Error('Three.js source was bundled; it must stay an external peer dependency.');
if (inputs.some(input => !input.startsWith('src/'))) throw new Error(`The bundle reached files outside src/: ${inputs.filter(input => !input.startsWith('src/')).join(', ')}`);
const output = result.metafile.outputs['dist/index.js'];
const externalImports = [...new Set(output.imports.filter(item => item.external).map(item => item.path))].sort();
if (externalImports.some(path => path !== 'three' && !path.startsWith('three/addons/'))) throw new Error(`Unexpected runtime imports: ${externalImports.join(', ')}`);
await writeFile('dist/build-manifest.json', JSON.stringify({
  entry: 'index.js',
  bytes: output.bytes,
  gzipBytes: gzipSync(await readFile('dist/index.js'), { level: 9 }).length,
  inputs,
  externalImports,
  three: { strategy: 'peer dependency (external); resolved by the consumer', peer: JSON.parse(await readFile('package.json', 'utf8')).peerDependencies.three },
}, null, 2) + '\n');
