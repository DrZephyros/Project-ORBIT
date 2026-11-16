import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: false,
  },
  resolve: {
    alias: {
      '@orbit/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    // The launcher chooses a free port at runtime; fall back to the conventional
    // one when running Vite by hand.
    port: Number(process.env.ORBIT_RENDERER_PORT ?? 5173),
    strictPort: true,
  },
});
