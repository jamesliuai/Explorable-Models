import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';

execFileSync('tsc', ['-p', 'tsconfig.build.json'], { stdio: 'inherit' });
await mkdir('dist', { recursive: true });
const result = await build({
  entryPoints: ['src/public.ts'], outfile: 'dist/index.js', bundle: true,
  platform: 'browser', format: 'esm', target: 'es2022', sourcemap: true,
  jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@experiment-kit/core', '@experiment-kit/core/*'],
  banner: { js: '"use client";' }, metafile: true,
});
await writeFile('dist/build-manifest.json', JSON.stringify({
  entry: 'index.js', bytes: result.metafile.outputs['dist/index.js'].bytes,
  inputs: Object.keys(result.metafile.inputs),
  externalImports: result.metafile.outputs['dist/index.js'].imports.map(item => item.path),
}, null, 2) + '\n');
