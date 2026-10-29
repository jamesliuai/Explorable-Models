import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

// Declarations (dist/public.d.ts, dist/activity/*.d.ts) are emitted after clearing the previous activity output.
await rm('dist/activity', { recursive: true, force: true });
execFileSync('tsc', ['-p', 'tsconfig.build.json'], { stdio: 'inherit' });
await mkdir('dist', { recursive: true });

// Legacy schema 2.0 entry: unchanged build and 180 KB consumer budget (architecture D14).
const result = await build({
  entryPoints: ['src/public.ts'], outfile: 'dist/index.js', bundle: true,
  platform: 'browser', format: 'esm', target: 'es2022', sourcemap: true,
  jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@experiment-kit/core', '@experiment-kit/core/*'],
  define: { __EKP_PACKAGE_BUILD__: 'true' }, banner: { js: '"use client";' }, metafile: true,
});
// Surface stylesheet asset for hosts without constructable stylesheets (the surface adopts it otherwise; no inline style).
const legacyStyles = await build({ entryPoints: ['src/embedding/styles.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' });
const { surfaceStyles } = await import(`data:text/javascript;base64,${Buffer.from(legacyStyles.outputFiles[0].text).toString('base64')}`);
await writeFile('dist/surface.css', `${surfaceStyles.trim()}\n`);
await writeFile('dist/build-manifest.json', JSON.stringify({
  entry: 'index.js', bytes: result.metafile.outputs['dist/index.js'].bytes,
  inputs: Object.keys(result.metafile.inputs),
  externalImports: result.metafile.outputs['dist/index.js'].imports.map(item => item.path),
}, null, 2) + '\n');

// Study Harness learner entry (@experiment-kit/player/activity).
// Decision: KaTeX is bundled as a lazy chunk, reached only through the default mathLoader's dynamic import, so its JS
// always matches the copied CSS and fonts exactly; React and @experiment-kit/* stay external. All chunks are emitted
// next to index.js, and the static asset URLs in asset-urls.ts are rewritten from node_modules to the copied layout.
const require = createRequire(import.meta.url);
const katexDist = dirname(require.resolve('katex/dist/katex.min.css'));
const interRoot = dirname(require.resolve('@fontsource-variable/inter/package.json'));
const KATEX_FONTS = ['AMS-Regular', 'Caligraphic-Bold', 'Caligraphic-Regular', 'Fraktur-Bold', 'Fraktur-Regular', 'Main-Bold', 'Main-BoldItalic', 'Main-Italic',
  'Main-Regular', 'Math-BoldItalic', 'Math-Italic', 'SansSerif-Bold', 'SansSerif-Italic', 'SansSerif-Regular', 'Script-Regular', 'Size1-Regular', 'Size2-Regular',
  'Size3-Regular', 'Size4-Regular', 'Typewriter-Regular'];
const INTER_SUBSETS = ['greek', 'latin-ext', 'latin'];
// Every directory that receives bundled third-party files also receives that component's license text: KaTeX's MIT
// license beside its code and stylesheet, the SIL OFL 1.1 of the KaTeX fonts beside those fonts, and Inter's SIL OFL 1.1
// beside Inter.
const ASSETS = [
  ['math/katex.min.css', join(katexDist, 'katex.min.css')],
  ['math/LICENSE', join(katexDist, '..', 'LICENSE')],
  ...KATEX_FONTS.map(name => [`math/fonts/KaTeX_${name}.woff2`, join(katexDist, 'fonts', `KaTeX_${name}.woff2`)]),
  ...INTER_SUBSETS.map(subset => [`fonts/inter/inter-${subset}-wght-normal.woff2`, join(interRoot, 'files', `inter-${subset}-wght-normal.woff2`)]),
  ['fonts/inter/LICENSE', join(interRoot, 'LICENSE')],
];
/**
 * The KaTeX fonts are not under KaTeX's MIT license: their name tables declare the SIL Open Font License 1.1, copyright
 * Design Science, Inc. and Khan Academy, with Reserved Font Names KaTeX_*. The katex package ships no OFL text, so the
 * build writes one from those declarations and the standard OFL 1.1 terms (taken verbatim from Inter's license file).
 */
const OFL_MARKER = 'SIL OPEN FONT LICENSE Version 1.1';
const interLicense = await readFile(join(interRoot, 'LICENSE'), 'utf8');
const oflStart = interLicense.lastIndexOf('\n', interLicense.lastIndexOf('-----', interLicense.indexOf(OFL_MARKER)));
if (interLicense.indexOf(OFL_MARKER) < 0 || oflStart < 0) throw new Error('The SIL OFL 1.1 text was not found in the Inter license file.');
const RESERVED = [...new Set(KATEX_FONTS.map(name => `KaTeX_${name.split('-')[0]}`))];
const KATEX_FONT_LICENSE = [
  'KaTeX fonts (KaTeX_*.woff2 in this directory), redistributed unmodified from katex@' + JSON.parse(await readFile(join(katexDist, '..', 'package.json'), 'utf8')).version + '.',
  '',
  'Copyright (c) 2009-2010, Design Science, Inc. (<www.mathjax.org>)',
  'Copyright (c) 2014-2018 Khan Academy (<www.khanacademy.org>),',
  `with Reserved Font Names ${RESERVED.join(', ')}.`,
  '',
  'This Font Software is licensed under the SIL Open Font License, Version 1.1.',
  'This license is copied below, and is also available with a FAQ at: https://openfontlicense.org',
  interLicense.slice(oflStart),
].join('\n');
const GENERATED = [['math/fonts/LICENSE', KATEX_FONT_LICENSE]];
const packageVersion = async root => JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
/** Third-party components bundled into dist/activity, with the license file shipped beside each. */
const THIRD_PARTY = [
  { name: 'KaTeX (code and stylesheet)', version: await packageVersion(join(katexDist, '..')), license: 'MIT', files: ['math/katex.min.css', 'lazy KaTeX chunk (*.js)'], text: ['math/LICENSE'] },
  { name: 'KaTeX fonts', version: await packageVersion(join(katexDist, '..')), license: 'OFL-1.1', files: ['math/fonts/*.woff2'], text: ['math/fonts/LICENSE'] },
  { name: 'Inter (Fontsource variable)', version: await packageVersion(interRoot), license: 'OFL-1.1', files: ['fonts/inter/*.woff2'], text: ['fonts/inter/LICENSE'] },
];
// A license must sit in every directory that holds bundled fonts.
const shipped = new Set([...ASSETS.map(([target]) => target), ...GENERATED.map(([target]) => target)]);
for (const directory of new Set(ASSETS.filter(([target]) => target.endsWith('.woff2')).map(([target]) => dirname(target)))) {
  if (!shipped.has(`${directory}/LICENSE`)) throw new Error(`Bundled fonts in ${directory} have no license file beside them.`);
}
const PREFIXES = [["'../../../../node_modules/katex/dist/", "'./math/"], ["'../../../../node_modules/@fontsource-variable/inter/files/", "'./fonts/inter/"]];
const assetUrls = {
  name: 'activity-asset-urls',
  setup(context) {
    context.onLoad({ filter: /[\\/]activity[\\/](?:asset-urls|math-font-urls)\.ts$/ }, async args => {
      let contents = await readFile(args.path, 'utf8');
      for (const [from, to] of PREFIXES) contents = contents.split(from).join(to);
      // Every rewritten URL must name a file this build copies, and no node_modules path may survive.
      const referenced = [...contents.matchAll(/new URL\('\.\/([^']+)', import\.meta\.url\)/g)].map(match => match[1]);
      const copied = new Set(ASSETS.map(([target]) => target).concat('activity.css'));
      const missing = referenced.filter(path => !copied.has(path));
      const expected = args.path.endsWith('math-font-urls.ts') ? KATEX_FONTS.length : INTER_SUBSETS.length + 1;
      if (contents.includes('../node_modules/') || missing.length || referenced.length !== expected) {
        throw new Error(`asset-urls.ts references assets the build does not copy: ${missing.join(', ') || `${referenced.length} URLs`}`);
      }
      return { contents, loader: 'ts' };
    });
  },
};

const activity = await build({
  entryPoints: { index: 'src/activity/index.ts' }, outdir: 'dist/activity', bundle: true, splitting: true,
  platform: 'browser', format: 'esm', target: 'es2022', sourcemap: true, jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@experiment-kit/*'],
  define: { __EKA_PACKAGE_BUILD__: 'true' }, plugins: [assetUrls],
  banner: { js: '"use client";' }, metafile: true, legalComments: 'linked',
});
for (const [target, source] of ASSETS) {
  await mkdir(dirname(join('dist/activity', target)), { recursive: true });
  await copyFile(source, join('dist/activity', target));
}
for (const [target, text] of GENERATED) await writeFile(join('dist/activity', target), text);
await writeFile('dist/activity/THIRD_PARTY_NOTICES.md', [
  '# Third-party components in @experiment-kit/player/activity', '',
  'These components are bundled in this directory under their own licenses; the license texts are the files listed.', '',
  '| Component | Version | License | Bundled files | License text |', '| --- | --- | --- | --- | --- |',
  ...THIRD_PARTY.map(entry => `| ${entry.name} | ${entry.version} | ${entry.license} | ${entry.files.join(', ')} | ${entry.text.join(', ')} |`), '',
].join('\n'));

// Component stylesheet asset for hosts without constructable stylesheets (native.md N4 fallback).
const styles = await build({ entryPoints: ['src/activity/styles.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', define: { __EKA_PACKAGE_BUILD__: 'true' }, logLevel: 'silent' });
const { ACTIVITY_STYLESHEET } = await import(`data:text/javascript;base64,${Buffer.from(styles.outputFiles[0].text).toString('base64')}`);
await writeFile('dist/activity/activity.css', `${ACTIVITY_STYLESHEET.trim()}\n`);

// Eager graph = outputs reachable from the entry through static imports; every other emitted JS file is a lazy chunk.
const outputs = activity.metafile.outputs;
const entry = 'dist/activity/index.js';
const eager = new Set();
const visit = path => { if (eager.has(path)) return; eager.add(path); for (const item of outputs[path].imports) if (item.kind === 'import-statement' && outputs[item.path]) visit(item.path); };
visit(entry);
const inputsOf = path => Object.keys(outputs[path].inputs);
if ([...eager].flatMap(inputsOf).some(input => /node_modules[\\/](katex|three)[\\/]|player-3d/.test(input))) throw new Error('KaTeX or 3D code reached the eager activity graph.');
const describe = async path => ({ file: path.replace('dist/activity/', ''), bytes: outputs[path].bytes, gzipBytes: gzipSync(await readFile(path), { level: 9 }).length, inputs: inputsOf(path).length });
const lazy = Object.keys(outputs).filter(path => path.endsWith('.js') && !eager.has(path));
await writeFile('dist/activity/build-manifest.json', JSON.stringify({
  entry: 'activity/index.js',
  bytes: outputs[entry].bytes,
  eager: await Promise.all([...eager].map(describe)),
  lazyChunks: await Promise.all(lazy.map(async path => ({ ...(await describe(path)), contains: [...new Set(inputsOf(path).map(input => /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input)?.[1] ?? 'player'))] }))),
  externalImports: [...new Set([...eager].flatMap(path => outputs[path].imports.filter(item => item.external).map(item => item.path)))].sort(),
  assets: [...ASSETS.map(([target]) => target), ...GENERATED.map(([target]) => target), 'activity.css', 'THIRD_PARTY_NOTICES.md'],
  thirdParty: THIRD_PARTY.map(({ name, version, license, text }) => ({ name, version, license, licenseFiles: text })),
  katex: { strategy: 'bundled lazy chunk (dynamic import in the default mathLoader)', version: JSON.parse(await readFile(join(katexDist, '..', 'package.json'), 'utf8')).version },
}, null, 2) + '\n');
