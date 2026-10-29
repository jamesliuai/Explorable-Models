// Vite configuration of the packaged reference host. The app resolves @explorable-models/* from the packed tarballs
// installed in this directory's node_modules (scripts/install-packed.mjs): there are no monorepo aliases here.
// The packaged app loads its build through Tauri's custom protocol (no dev server, no devUrl).
//
//   --mode production   → dist/              (release binary; the conformance runner is dead code and not emitted)
//   --mode conformance  → .conformance-out/dist/  (conformance binary only; tauri build --config sets this frontendDist;
//                         .conformance-out is excluded from release packaging)
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  base: './',
  clearScreen: false,
  publicDir: 'public',
  resolve: { alias: [] },
  build: {
    outDir: mode === 'conformance' ? '.conformance-out/dist' : 'dist',
    emptyOutDir: true,
    target: 'safari16',
    // Never inline assets as data: URIs; the production CSP allows only 'self' fonts and images (native.md N3).
    assetsInlineLimit: 0,
    sourcemap: false,
    // Native ESM loads local dependencies; optional preload hint bookkeeping is unnecessary for this packaged host.
    modulePreload: false,
    chunkSizeWarningLimit: 1600,
  },
  // Module workers (`new Worker(new URL('./x.js', import.meta.url), { type: 'module' })`, native.md N1).
  worker: { format: 'es' },
}));
