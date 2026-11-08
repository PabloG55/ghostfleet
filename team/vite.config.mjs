import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The browser only ever talks to server/index.mjs; in development vite proxies /api to it.
export default defineConfig({
  root: 'web',
  plugins: [preact()],
  server: { port: 5190, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8790' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
