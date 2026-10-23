import { defineConfig } from 'vite';
export default defineConfig({ base: './', worker: { format: 'es' }, build: { target: 'es2022', rollupOptions: { input: { dom: 'dom.html', react: 'react.html' } } }, esbuild: { jsx: 'automatic' } });
