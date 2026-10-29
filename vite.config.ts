import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
// Specific subpaths precede their package roots: the first matching alias wins.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: { alias: [
    { find: '@explorable-models/core/model', replacement: at('./packages/core/src/model/index.ts') },
    { find: '@explorable-models/core/declarative', replacement: at('./packages/core/src/declarative/index.ts') },
    { find: /^@explorable-models\/core$/, replacement: at('./packages/core/src/index.ts') },
    { find: /^@explorable-models\/activity$/, replacement: at('./packages/activity/src/index.ts') },
    { find: '@explorable-models/catalog/worker', replacement: at('./packages/catalog/src/worker.ts') },
    { find: /^@explorable-models\/catalog$/, replacement: at('./packages/catalog/src/index.ts') },
    { find: /^@explorable-models\/agent$/, replacement: at('./packages/agent/src/index.ts') },
    { find: '@explorable-models/player/activity', replacement: at('./packages/player/src/activity/index.ts') },
    { find: /^@explorable-models\/player$/, replacement: at('./packages/player/src/public.ts') },
    { find: /^@explorable-models\/player-3d$/, replacement: at('./packages/player-3d/src/index.ts') },
    { find: /^@explorable-models\/examples$/, replacement: at('./examples/browser.ts') },
  ] },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, rollupOptions: { input: {
    home: at('./index.html'),
    gallery: at('./gallery.html'),
    studio: at('./agent.html'),
    guide: at('./guide.html'),
    hingedRod: at('./hinged-rod.html'),
    showcase: at('./showcase.html'),
    studyHarness: at('./study-harness.html'),
    projectionLab: at('./examples/study-harness-host/projection-lab.html'),
    lifecycle: at('./examples/study-harness-host/lifecycle.html'),
  } } },
});
