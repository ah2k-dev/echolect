import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

export default defineConfig({
  plugins: [svelte()],
  root: 'src/renderer',
  base: './',
  // Fixed port the Electron main process loads from (see src/main/index.ts).
  server: { port: 5174, strictPort: true },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        dashboard: path.resolve(__dirname, 'src/renderer/dashboard/index.html'),
        overlay: path.resolve(__dirname, 'src/renderer/overlay/index.html'),
      },
    },
  },
  resolve: {
    alias: {
      '$shared': path.resolve(__dirname, 'src/renderer/shared'),
    },
  },
});
