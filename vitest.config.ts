import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  resolve: { alias: { '@experiment-kit/core/declarative': fileURLToPath(new URL('./packages/core/src/declarative/index.ts', import.meta.url)), '@experiment-kit/agent': fileURLToPath(new URL('./packages/agent/src/index.ts', import.meta.url)), '@experiment-kit/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'], exclude: ['tests/browser/**'], testTimeout: 20000 },
});
