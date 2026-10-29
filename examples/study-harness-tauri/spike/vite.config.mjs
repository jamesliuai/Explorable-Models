// Vite configuration for the packaged Tauri reference host.
// The packaged app loads dist/ through Tauri's custom protocol (no dev server, no devUrl).
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  clearScreen: false,
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'safari16',
    // Never inline assets as data: URIs; the production CSP only allows 'self' fonts/images.
    assetsInlineLimit: 0,
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
  worker: { format: 'es' },
});
