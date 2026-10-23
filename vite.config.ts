import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: { alias: {
    '@experiment-kit/core/declarative': fileURLToPath(new URL('./packages/core/src/declarative/index.ts', import.meta.url)),
    '@experiment-kit/agent': fileURLToPath(new URL('./packages/agent/src/index.ts', import.meta.url)),
    '@experiment-kit/player': fileURLToPath(new URL('./packages/player/src/public.ts', import.meta.url)),
    '@experiment-kit/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    '@experiment-kit/examples': fileURLToPath(new URL('./examples/browser.ts', import.meta.url)),
  } },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, rollupOptions: { input: {
    home: fileURLToPath(new URL('./index.html', import.meta.url)),
    gallery: fileURLToPath(new URL('./gallery.html', import.meta.url)),
    studio: fileURLToPath(new URL('./agent.html', import.meta.url)),
    guide: fileURLToPath(new URL('./guide.html', import.meta.url)),
  } } },
});
