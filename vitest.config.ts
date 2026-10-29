import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
// Specific subpaths precede their package roots: the first matching alias wins.
export default defineConfig({
  resolve: { alias: [
    { find: '@experiment-kit/core/model', replacement: at('./packages/core/src/model/index.ts') },
    { find: '@experiment-kit/core/declarative', replacement: at('./packages/core/src/declarative/index.ts') },
    { find: /^@experiment-kit\/core$/, replacement: at('./packages/core/src/index.ts') },
    { find: /^@experiment-kit\/activity\/conformance$/, replacement: at('./packages/activity/src/conformance/index.ts') },
    { find: /^@experiment-kit\/activity$/, replacement: at('./packages/activity/src/index.ts') },
    { find: '@experiment-kit/catalog/worker', replacement: at('./packages/catalog/src/worker.ts') },
    { find: /^@experiment-kit\/catalog$/, replacement: at('./packages/catalog/src/index.ts') },
    { find: /^@experiment-kit\/agent$/, replacement: at('./packages/agent/src/index.ts') },
  ] },
  // The persistent transform cache accumulated gigabytes across release runs. Keep the same checks without retaining it.
  test: { include: ['tests/**/*.test.ts'], exclude: ['tests/browser/**'], testTimeout: 20000, fsModuleCache: false },
});
