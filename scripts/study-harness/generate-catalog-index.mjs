// Writes packages/catalog/src/installed-index.ts — the eager index of the on-demand catalogue (createLazyCatalog):
// template and model references, model identities, reference-suite digests, kernel identities and discovery entries,
// all computed from the installed content through the eager catalogue's validation (packages/catalog/scripts/installed-index.ts).
//
//   node scripts/study-harness/generate-catalog-index.mjs           write the index
//   node scripts/study-harness/generate-catalog-index.mjs --check   exit 1 when the committed index is stale
//
// Run it after changing any installed template, learner copy, model manifest, kernel identity or content loader.
import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
// Resolve @experiment-kit/* to the repository sources (root tsconfig paths) wherever the script is started from — the
// catalogue's `build` script runs it from packages/catalog so every packed catalogue carries an index of its own content.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const invokedFrom = process.cwd();
process.chdir(ROOT);
register();
const { INSTALLED_INDEX_PATH, buildInstalledIndex, renderInstalledIndex } = await import('../../packages/catalog/scripts/installed-index.ts');

const text = renderInstalledIndex(buildInstalledIndex());
const current = await readFile(INSTALLED_INDEX_PATH, 'utf8').catch(() => null);
const file = relative(invokedFrom, INSTALLED_INDEX_PATH);
if (process.argv.includes('--check')) {
  if (current !== text) { console.error(`${file} is stale. Run: node scripts/study-harness/generate-catalog-index.mjs`); process.exit(1); }
  console.log(`${file} is current.`);
} else if (current === text) console.log(`${file} is already current.`);
else { await writeFile(INSTALLED_INDEX_PATH, text); console.log(`Wrote ${file}.`); }
