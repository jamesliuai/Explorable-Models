// Production build of the packed activity consumer. It runs only inside the clean install created by
// scripts/study-harness/verify-consumer.mjs: @experiment-kit/* resolve to the extracted tarballs in that directory's
// node_modules, never to monorepo sources (no aliases here).
//
// - assetsInlineLimit 0: fonts, stylesheets and images stay files, because the production CSP allows no data: URIs.
// - modulePreload false: native ESM loads the static graph; omit optional preload hint bookkeeping. The dependency
//   audit still follows every static import and worker, so this removes loader overhead rather than dependencies.
// - sourcemap 'hidden': .map files for the dependency audit (which package code reached which chunk); the JS bytes and
//   the measured sizes are those of a build without source map comments.
// - manifest: .vite/manifest.json lists every entry's static imports and dynamic imports (cross-check of the audit).
//
// CONSUMER_ENTRY=<name> builds that one page alone into dist-<name>/: the dependency budgets are measured on such
// single-page builds, so code shared with other pages (benchmark, spatial) cannot change what the measured page loads.
import { defineConfig } from 'vite';

const PAGES = { activity: 'activity.html', 'activity-react': 'activity-react.html', spatial: 'spatial.html', bench: 'bench.html' };
const single = process.env.CONSUMER_ENTRY;
if (single && !PAGES[single]) throw new Error(`Unknown CONSUMER_ENTRY ${single}; expected one of ${Object.keys(PAGES).join(', ')}.`);

export default defineConfig({
  base: './',
  clearScreen: false,
  logLevel: 'warn',
  publicDir: false,
  resolve: { alias: [] },
  build: {
    outDir: single ? `dist-${single}` : 'dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    sourcemap: 'hidden',
    manifest: true,
    modulePreload: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: single ? { [single]: PAGES[single] } : PAGES,
    },
  },
  worker: { format: 'es' },
});
