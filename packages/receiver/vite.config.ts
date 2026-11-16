import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  // Served by the ORBIT server under /r, so assets resolve from /assets.
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'safari16',
    sourcemap: false,
  },
  resolve: {
    alias: {
      '@orbit/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
      '/health': 'http://127.0.0.1:8787',
    },
  },
});
